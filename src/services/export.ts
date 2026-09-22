import { VaultError } from '../domain/errors.js';
import type { AttachmentSnapshot, MarkdownContent, VaultSnapshot } from '../domain/model.js';
import { VaultTree } from '../domain/tree.js';
import { nameKey, validateName } from '../domain/paths.js';
import { assertMarkdownContent } from '../domain/integrity.js';

export interface ExportFile { path: string; bytes: Uint8Array }

function base64Bytes(value: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = value.replace(/\s+/gu, '');
  if (clean.length % 4 !== 0 || /[^A-Za-z0-9+/=]/u.test(clean)) throw new VaultError('CORRUPT', 'Attachment backup data is not valid base64.');
  const output: number[] = [];
  for (let index = 0; index < clean.length; index += 4) {
    const chunk = clean.slice(index, index + 4);
    const values = [...chunk].map(character => character === '=' ? 0 : alphabet.indexOf(character));
    if (values.some(value => value < 0)) throw new VaultError('CORRUPT', 'Attachment backup data is not valid base64.');
    const combined = (values[0]! << 18) | (values[1]! << 12) | (values[2]! << 6) | values[3]!;
    output.push((combined >>> 16) & 255);
    if (chunk[2] !== '=') output.push((combined >>> 8) & 255);
    if (chunk[3] !== '=') output.push(combined & 255);
  }
  return Uint8Array.from(output);
}

export function vaultFiles(snapshot: VaultSnapshot): ExportFile[] {
  const encoder = new TextEncoder();
  const tree = new VaultTree(snapshot.entries);
  const contents = new Map<string, MarkdownContent>();
  const attachments = new Map<string, AttachmentSnapshot>();
  for (const content of snapshot.contents) {
    if (contents.has(content.entryId) || typeof content.text !== 'string') throw new VaultError('CORRUPT', 'Duplicate or invalid canonical Markdown content.');
    contents.set(content.entryId, content);
  }
  for (const attachment of snapshot.attachments ?? []) {
    if (attachments.has(attachment.entryId) || !Number.isInteger(attachment.size) || attachment.size < 0) throw new VaultError('CORRUPT', 'Duplicate or invalid attachment backup.');
    attachments.set(attachment.entryId, attachment);
  }
  return snapshot.entries.filter(entry => entry.deletedAt === null).map(entry => {
    const path = tree.path(entry.id);
    if (entry.kind === 'directory') return { path: `${path}/`, bytes: new Uint8Array() };
    if (entry.kind === 'attachment') {
      const attachment = attachments.get(entry.id);
      if (!attachment) throw new VaultError('CORRUPT', 'Attachment bytes are missing from this backup.');
      const bytes = base64Bytes(attachment.dataBase64);
      if (bytes.byteLength !== attachment.size) throw new VaultError('CORRUPT', 'Attachment size does not match its backup data.');
      return { path, bytes };
    }
    const content = contents.get(entry.id);
    assertMarkdownContent(entry, content);
    return { path, bytes: encoder.encode(content.text) };
  });
}

/** Backwards-compatible name retained for older callers; Phase 9 now exports all active vault files. */
export const markdownFiles = vaultFiles;

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
function header(length: number): { bytes: Uint8Array; view: DataView } {
  const bytes = new Uint8Array(length);
  return { bytes, view: new DataView(bytes.buffer) };
}

/** Minimal standard ZIP STORE writer for local export; no compression, ZIP64 or import. */
export function zipStore(files: readonly ExportFile[]): Uint8Array {
  if (files.length > 65535) throw new VaultError('UNSUPPORTED', 'This local exporter supports at most 65,535 entries.');
  const encoder = new TextEncoder();
  const keys = new Set<string>(); const fileKeys = new Set<string>(); let estimatedSize = 22;
  for (const file of files) {
    const directory = file.path.endsWith('/');
    const segments = file.path.replace(/\/$/, '').split('/');
    if (!file.path || segments.some(part => validateName(part) !== part)) throw new VaultError('INVALID_NAME', 'Unsafe export path.');
    const key = segments.map(nameKey).join('/');
    if (keys.has(key)) throw new VaultError('INVALID_NAME', 'Duplicate export path.');
    keys.add(key); if (!directory) fileKeys.add(key);
    if (directory && file.bytes.length !== 0) throw new VaultError('INVALID_NAME', 'A directory cannot contain file bytes.');
    const nameBytes = encoder.encode(file.path).length;
    if (nameBytes > 65535 || file.bytes.length > 0xffffffff) throw new VaultError('UNSUPPORTED', 'This file requires ZIP64.');
    estimatedSize += 76 + 2 * nameBytes + file.bytes.length;
    if (estimatedSize > 512 * 1024 * 1024) throw new VaultError('UNSUPPORTED', 'This in-memory local exporter is limited to 512 MB. Streaming export is a later release gate.');
  }
  for (const key of keys) {
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i++) if (fileKeys.has(parts.slice(0, i).join('/'))) throw new VaultError('INVALID_NAME', 'An exported file cannot also be a parent directory.');
  }
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const seenPaths = new Set<string>();
  for (const file of files) {
    const segments = file.path.replace(/\/$/, '').split('/');
    if (!file.path || /[\u0000-\u001f\u007f]/.test(file.path) || file.path.startsWith('/') || file.path.includes('\\') || segments.some(part => !part || part === '..' || part === '.') || seenPaths.has(file.path)) throw new VaultError('INVALID_NAME', 'Unsafe export path.');
    seenPaths.add(file.path);
    const name = encoder.encode(file.path);
    if (name.length > 65535 || file.bytes.length > 0xffffffff) throw new VaultError('UNSUPPORTED', 'This file requires ZIP64.');
    const crc = crc32(file.bytes);
    const local = header(30);
    local.view.setUint32(0, 0x04034b50, true);
    local.view.setUint16(4, 20, true);
    local.view.setUint16(6, 0x0800, true);
    local.view.setUint16(12, 0x0021, true);
    local.view.setUint32(14, crc, true);
    local.view.setUint32(18, file.bytes.length, true);
    local.view.setUint32(22, file.bytes.length, true);
    local.view.setUint16(26, name.length, true);
    parts.push(local.bytes, name, file.bytes);
    const directory = header(46);
    directory.view.setUint32(0, 0x02014b50, true);
    directory.view.setUint16(4, 20, true);
    directory.view.setUint16(6, 20, true);
    directory.view.setUint16(8, 0x0800, true);
    directory.view.setUint16(14, 0x0021, true);
    directory.view.setUint32(16, crc, true);
    directory.view.setUint32(20, file.bytes.length, true);
    directory.view.setUint32(24, file.bytes.length, true);
    directory.view.setUint16(28, name.length, true);
    directory.view.setUint32(38, file.path.endsWith('/') ? 0x10 : 0, true);
    directory.view.setUint32(42, offset, true);
    central.push(directory.bytes, name);
    offset += local.bytes.length + name.length + file.bytes.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  if (offset + centralSize + 22 > 512 * 1024 * 1024) throw new VaultError('UNSUPPORTED', 'This in-memory local exporter is limited to 512 MB. Streaming export is a later release gate.');
  const end = header(22);
  end.view.setUint32(0, 0x06054b50, true);
  end.view.setUint16(8, files.length, true);
  end.view.setUint16(10, files.length, true);
  end.view.setUint32(12, centralSize, true);
  end.view.setUint32(16, offset, true);
  for (const part of central) parts.push(part);
  parts.push(end.bytes);
  const result = new Uint8Array(offset + centralSize + end.bytes.length);
  let at = 0;
  for (const part of parts) { result.set(part, at); at += part.length; }
  return result;
}


function safeImportedPath(path: string): void {
  const directory = path.endsWith('/');
  const trimmed = directory ? path.slice(0, -1) : path;
  const segments = trimmed.split('/');
  if (!trimmed || path.startsWith('/') || path.includes('\\') || segments.some(part => !part || part === '.' || part === '..')) {
    throw new VaultError('CORRUPT', 'ZIP contains an unsafe path.');
  }
  for (const segment of segments) validateName(segment);
}

/**
 * Reads the exact ZIP STORE subset produced by zipStore().
 * This intentionally does not pretend to be a general ZIP decompressor.
 */
export function readZipStore(bytes: Uint8Array): ExportFile[] {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 22) throw new VaultError('CORRUPT', 'Vault archive ZIP is truncated.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimum = Math.max(0, bytes.byteLength - 65_557);
  let endOffset = -1;
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) { endOffset = offset; break; }
  }
  if (endOffset < 0) throw new VaultError('CORRUPT', 'Vault archive ZIP has no end record.');

  const count = view.getUint16(endOffset + 10, true);
  const centralSize = view.getUint32(endOffset + 12, true);
  const centralOffset = view.getUint32(endOffset + 16, true);
  if (centralOffset + centralSize > endOffset || count > 65_535) throw new VaultError('CORRUPT', 'Vault archive ZIP directory is invalid.');

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const files: ExportFile[] = [];
  const seen = new Set<string>();
  let cursor = centralOffset;

  for (let index = 0; index < count; index++) {
    if (cursor + 46 > bytes.byteLength || view.getUint32(cursor, true) !== 0x02014b50) {
      throw new VaultError('CORRUPT', 'Vault archive ZIP central directory is truncated.');
    }
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const expectedCrc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    if (method !== 0 || compressedSize !== uncompressedSize) throw new VaultError('UNSUPPORTED', 'Vault restore supports only uncompressed Vault ZIP archives.');
    if ((flags & 0x0001) !== 0) throw new VaultError('UNSUPPORTED', 'Encrypted ZIP archives are not supported.');

    const nameFrom = cursor + 46;
    const nameTo = nameFrom + nameLength;
    if (nameTo > bytes.byteLength) throw new VaultError('CORRUPT', 'Vault archive ZIP filename is truncated.');
    let path: string;
    try { path = decoder.decode(bytes.subarray(nameFrom, nameTo)); }
    catch (error) { throw new VaultError('CORRUPT', 'Vault archive ZIP filename is not valid UTF-8.', { cause: error }); }
    safeImportedPath(path);
    if (seen.has(path)) throw new VaultError('CORRUPT', 'Vault archive ZIP contains a duplicate path.');
    seen.add(path);

    if (localOffset + 30 > bytes.byteLength || view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new VaultError('CORRUPT', 'Vault archive ZIP local header is invalid.');
    }
    const localMethod = view.getUint16(localOffset + 8, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    if (localMethod !== 0) throw new VaultError('UNSUPPORTED', 'Vault restore supports only ZIP STORE entries.');
    const dataFrom = localOffset + 30 + localNameLength + localExtraLength;
    const dataTo = dataFrom + compressedSize;
    if (dataTo > bytes.byteLength) throw new VaultError('CORRUPT', 'Vault archive ZIP file data is truncated.');
    const payload = bytes.slice(dataFrom, dataTo);
    if (crc32(payload) !== expectedCrc) throw new VaultError('CORRUPT', 'Vault archive ZIP CRC check failed for ' + path + '.');
    if (path.endsWith('/') && payload.byteLength !== 0) throw new VaultError('CORRUPT', 'Vault archive ZIP directory contains payload bytes.');
    files.push({ path, bytes: payload });

    cursor = nameTo + extraLength + commentLength;
  }

  if (cursor !== centralOffset + centralSize) throw new VaultError('CORRUPT', 'Vault archive ZIP central directory size does not match its entries.');
  return files;
}
