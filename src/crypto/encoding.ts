import { VaultError } from '../domain/errors.js';

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type CanonicalContextScalar = string | number | boolean | null;

export function bytesToHex(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) throw new VaultError('PROTOCOL', 'Expected binary bytes.');
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex: string): Uint8Array {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-f]*$/iu.test(hex)) {
    throw new VaultError('PROTOCOL', 'Invalid hexadecimal byte string.');
  }
  const result = new Uint8Array(hex.length / 2);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) throw new VaultError('PROTOCOL', 'Expected binary bytes for base64url encoding.');
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const hasB = index + 1 < bytes.length;
    const hasC = index + 2 < bytes.length;
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    const value = (a << 16) | (b << 8) | c;
    output += BASE64[(value >>> 18) & 63];
    output += BASE64[(value >>> 12) & 63];
    if (hasB) output += BASE64[(value >>> 6) & 63];
    if (hasC) output += BASE64[value & 63];
  }
  return output.replace(/\+/gu, '-').replace(/\//gu, '_');
}

export function base64UrlDecode(value: string): Uint8Array {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value) || value.includes('=') || value.length % 4 === 1) {
    throw new VaultError('PROTOCOL', 'Invalid unpadded base64url value.');
  }
  const standard = value.replace(/-/gu, '+').replace(/_/gu, '/');
  const bytes: number[] = [];
  for (let index = 0; index < standard.length; index += 4) {
    const group = standard.slice(index, index + 4);
    let packed = 0;
    for (let offset = 0; offset < 4; offset += 1) {
      const character = group[offset];
      packed <<= 6;
      if (character !== undefined) {
        const digit = BASE64.indexOf(character);
        if (digit < 0) throw new VaultError('PROTOCOL', 'Invalid base64url digit.');
        packed |= digit;
      }
    }
    const count = group.length - 1;
    for (let byteIndex = 0; byteIndex < count; byteIndex += 1) {
      bytes.push((packed >>> (16 - byteIndex * 8)) & 0xff);
    }
  }
  const result = Uint8Array.from(bytes);
  if (base64UrlEncode(result) !== value) throw new VaultError('PROTOCOL', 'Non-canonical base64url value.');
  return result;
}

export function canonicalUuid(value: string, label = 'UUID'): string {
  if (!UUID_PATTERN.test(value)) throw new VaultError('PROTOCOL', label + ' is invalid.');
  return value.toLowerCase();
}

/**
 * Canonical cryptographic contexts are UTF-8 JSON arrays containing only scalar
 * values. IDs must already be canonicalized by callers. JSON arrays avoid
 * delimiter ambiguity while remaining independently implementable.
 */
export function canonicalContext(parts: readonly CanonicalContextScalar[]): Uint8Array {
  for (const part of parts) {
    if (typeof part === 'number' && (!Number.isSafeInteger(part) || !Number.isFinite(part) || Object.is(part, -0))) {
      throw new VaultError('PROTOCOL', 'Canonical cryptographic context contains an invalid number.');
    }
  }
  return new TextEncoder().encode(JSON.stringify(parts));
}
