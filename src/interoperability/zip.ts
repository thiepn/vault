import { VaultError } from '../domain/errors.js';

export interface ArchiveFile {
  path: string;
  bytes: Uint8Array;
  directory: boolean;
  modifiedAt: string | null;
}

export interface ZipReadResult {
  files: ArchiveFile[];
  warnings: string[];
}

const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 512 * 1024 * 1024;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_ENTRIES = 20_000;

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function decodeName(bytes: Uint8Array, utf8: boolean, warnings: string[]): string {
  if (utf8) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
      throw new VaultError('CORRUPT', 'ZIP filename is not valid UTF-8.', { cause: error });
    }
  }
  warnings.push('One or more ZIP filenames did not declare UTF-8; bytes were decoded losslessly as Latin-1.');
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return value;
}

function safePath(raw: string, warnings: string[]): string {
  let path = raw.normalize('NFC');
  if (path.includes('\\')) {
    path = path.replaceAll('\\', '/');
    warnings.push('Backslash ZIP paths were normalized to forward slashes.');
  }
  path = path.replace(/^\.\//u, '');
  const directory = path.endsWith('/');
  const trimmed = directory ? path.slice(0, -1) : path;
  if (!trimmed || path.startsWith('/') || /^[A-Za-z]:\//u.test(path)) {
    throw new VaultError('CORRUPT', 'ZIP contains an absolute or empty path.');
  }
  const segments = trimmed.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\u0000'))) {
    throw new VaultError('CORRUPT', 'ZIP contains an unsafe traversal path.');
  }
  return trimmed + (directory ? '/' : '');
}

function dosDateTime(date: number, time: number): string | null {
  if (!date) return null;
  const year = 1980 + ((date >>> 9) & 0x7f);
  const month = (date >>> 5) & 0x0f;
  const day = date & 0x1f;
  const hour = (time >>> 11) & 0x1f;
  const minute = (time >>> 5) & 0x3f;
  const second = (time & 0x1f) * 2;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second)).toISOString();
}

async function inflateRaw(compressed: Uint8Array, expectedSize: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new VaultError('UNSUPPORTED', 'This browser cannot decompress standard DEFLATE ZIP entries.');
  }
  try {
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    if (bytes.byteLength !== expectedSize) throw new VaultError('CORRUPT', 'ZIP entry expanded to an unexpected size.');
    return bytes;
  } catch (error) {
    if (error instanceof VaultError) throw error;
    throw new VaultError('CORRUPT', 'ZIP DEFLATE payload could not be decompressed.', { cause: error });
  }
}

export async function readZipArchive(bytes: Uint8Array): Promise<ZipReadResult> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 22) throw new VaultError('CORRUPT', 'ZIP archive is truncated.');
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new VaultError('UNSUPPORTED', 'ZIP import is limited to 512 MB in this browser-first release.');

  const warnings: string[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimum = Math.max(0, bytes.byteLength - 65_557);
  let endOffset = -1;
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      const commentLength = view.getUint16(offset + 20, true);
      if (offset + 22 + commentLength === bytes.byteLength) { endOffset = offset; break; }
    }
  }
  if (endOffset < 0) throw new VaultError('CORRUPT', 'ZIP archive has no valid end-of-central-directory record.');

  const disk = view.getUint16(endOffset + 4, true);
  const centralDisk = view.getUint16(endOffset + 6, true);
  const diskCount = view.getUint16(endOffset + 8, true);
  const count = view.getUint16(endOffset + 10, true);
  const centralSize = view.getUint32(endOffset + 12, true);
  const centralOffset = view.getUint32(endOffset + 16, true);
  if (disk !== 0 || centralDisk !== 0 || diskCount !== count) throw new VaultError('UNSUPPORTED', 'Multi-disk ZIP archives are not supported.');
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new VaultError('UNSUPPORTED', 'ZIP64 imports are not supported yet.');
  if (count > MAX_ENTRIES) throw new VaultError('UNSUPPORTED', `ZIP import supports at most ${MAX_ENTRIES.toLocaleString()} entries.`);
  if (centralOffset + centralSize > endOffset) throw new VaultError('CORRUPT', 'ZIP central directory points outside the archive.');

  const files: ArchiveFile[] = [];
  const seen = new Set<string>();
  let expandedTotal = 0;
  let cursor = centralOffset;

  for (let index = 0; index < count; index++) {
    if (cursor + 46 > endOffset || view.getUint32(cursor, true) !== 0x02014b50) {
      throw new VaultError('CORRUPT', 'ZIP central directory is truncated.');
    }
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const modifiedTime = view.getUint16(cursor + 12, true);
    const modifiedDate = view.getUint16(cursor + 14, true);
    const expectedCrc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const diskStart = view.getUint16(cursor + 34, true);
    const localOffset = view.getUint32(cursor + 42, true);

    if (diskStart !== 0) throw new VaultError('UNSUPPORTED', 'Multi-disk ZIP entries are not supported.');
    if ((flags & 0x0001) !== 0) throw new VaultError('UNSUPPORTED', 'Encrypted ZIP entries are not supported.');
    if (method !== 0 && method !== 8) throw new VaultError('UNSUPPORTED', `ZIP compression method ${method} is not supported.`);
    if (uncompressedSize > MAX_FILE_BYTES) throw new VaultError('UNSUPPORTED', 'A ZIP entry exceeds the 128 MB per-file import limit.');
    expandedTotal += uncompressedSize;
    if (expandedTotal > MAX_EXPANDED_BYTES) throw new VaultError('UNSUPPORTED', 'Expanded ZIP content exceeds the 512 MB import limit.');

    const nameFrom = cursor + 46;
    const nameTo = nameFrom + nameLength;
    const recordTo = nameTo + extraLength + commentLength;
    if (recordTo > endOffset) throw new VaultError('CORRUPT', 'ZIP filename or extra data is truncated.');
    const path = safePath(decodeName(bytes.subarray(nameFrom, nameTo), (flags & 0x0800) !== 0, warnings), warnings);
    const key = path.normalize('NFC').toLocaleLowerCase();
    if (seen.has(key)) throw new VaultError('CORRUPT', 'ZIP contains duplicate or case-colliding paths.');
    seen.add(key);

    if (localOffset + 30 > centralOffset || view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new VaultError('CORRUPT', 'ZIP local file header is invalid.');
    }
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    if ((localFlags & 0x0001) !== 0 || localMethod !== method) throw new VaultError('CORRUPT', 'ZIP local header disagrees with the central directory.');

    const dataFrom = localOffset + 30 + localNameLength + localExtraLength;
    const dataTo = dataFrom + compressedSize;
    if (dataTo > centralOffset) throw new VaultError('CORRUPT', 'ZIP file data overlaps the central directory.');
    const compressed = bytes.subarray(dataFrom, dataTo);
    const directory = path.endsWith('/');
    const payload = directory
      ? new Uint8Array()
      : method === 0
        ? compressed.slice()
        : await inflateRaw(compressed, uncompressedSize);

    if (!directory && payload.byteLength !== uncompressedSize) throw new VaultError('CORRUPT', 'ZIP entry size does not match its directory record.');
    if (crc32(payload) !== expectedCrc) throw new VaultError('CORRUPT', `ZIP CRC check failed for ${path}.`);
    if (directory && (compressedSize !== 0 || uncompressedSize !== 0)) throw new VaultError('CORRUPT', 'ZIP directory entry contains data.');

    files.push({
      path,
      bytes: payload,
      directory,
      modifiedAt: dosDateTime(modifiedDate, modifiedTime),
    });
    cursor = recordTo;
  }

  if (cursor !== centralOffset + centralSize) throw new VaultError('CORRUPT', 'ZIP central-directory size does not match its entries.');
  return { files, warnings: [...new Set(warnings)] };
}
