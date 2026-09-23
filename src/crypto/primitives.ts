import { VaultError } from '../domain/errors.js';
import { bytesToHex } from './encoding.js';

export const SHA256_BYTES = 32;
export const AES_256_KEY_BYTES = 32;
export const AES_GCM_NONCE_BYTES = 12;
export const AES_GCM_TAG_BITS = 128;

function assertBytes(value: Uint8Array, label: string): void {
  if (!(value instanceof Uint8Array)) throw new VaultError('PROTOCOL', label + ' must be binary bytes.');
}

export function randomBytes(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 1 || length > 65536) {
    throw new VaultError('PROTOCOL', 'Invalid secure-random byte length.');
  }
  return crypto.getRandomValues(new Uint8Array(length));
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  assertBytes(bytes, 'SHA-256 input');
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return bytesToHex(await sha256(bytes));
}

export async function hmacSha256(keyBytes: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  assertBytes(keyBytes, 'HMAC key');
  assertBytes(data, 'HMAC input');
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

async function importHkdfMaterial(ikm: Uint8Array): Promise<CryptoKey> {
  assertBytes(ikm, 'HKDF input key material');
  if (!ikm.byteLength) throw new VaultError('PROTOCOL', 'HKDF input key material must not be empty.');
  return crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits', 'deriveKey']);
}

export async function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  lengthBytes: number,
): Promise<Uint8Array> {
  assertBytes(salt, 'HKDF salt');
  assertBytes(info, 'HKDF info');
  if (!Number.isSafeInteger(lengthBytes) || lengthBytes < 1 || lengthBytes > 8160) {
    throw new VaultError('PROTOCOL', 'HKDF output length is invalid for SHA-256.');
  }
  const material = await importHkdfMaterial(ikm);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    material,
    lengthBytes * 8,
  );
  return new Uint8Array(bits);
}

export async function deriveAes256GcmKey(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
): Promise<CryptoKey> {
  assertBytes(salt, 'HKDF salt');
  assertBytes(info, 'HKDF info');
  const material = await importHkdfMaterial(ikm);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function deriveHmacSha256Key(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
): Promise<CryptoKey> {
  assertBytes(salt, 'HKDF salt');
  assertBytes(info, 'HKDF info');
  const material = await importHkdfMaterial(ikm);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    material,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  );
}

export async function signHmacSha256(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  assertBytes(data, 'HMAC input');
  if (key.type !== 'secret' || key.algorithm.name !== 'HMAC') throw new VaultError('PROTOCOL', 'Expected an HMAC-SHA-256 CryptoKey.');
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

export async function aes256GcmEncrypt(
  key: CryptoKey,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  additionalData: Uint8Array,
): Promise<Uint8Array> {
  assertBytes(nonce, 'AES-GCM nonce');
  assertBytes(plaintext, 'AES-GCM plaintext');
  assertBytes(additionalData, 'AES-GCM additional data');
  if (nonce.byteLength !== AES_GCM_NONCE_BYTES) throw new VaultError('PROTOCOL', 'AES-GCM nonce must be exactly 12 bytes.');
  if (key.type !== 'secret' || key.algorithm.name !== 'AES-GCM') throw new VaultError('PROTOCOL', 'Expected an AES-GCM CryptoKey.');
  return new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData, tagLength: AES_GCM_TAG_BITS },
    key,
    plaintext,
  ));
}

export async function aes256GcmDecrypt(
  key: CryptoKey,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  additionalData: Uint8Array,
): Promise<Uint8Array> {
  assertBytes(nonce, 'AES-GCM nonce');
  assertBytes(ciphertext, 'AES-GCM ciphertext');
  assertBytes(additionalData, 'AES-GCM additional data');
  if (nonce.byteLength !== AES_GCM_NONCE_BYTES) throw new VaultError('PROTOCOL', 'AES-GCM nonce must be exactly 12 bytes.');
  if (key.type !== 'secret' || key.algorithm.name !== 'AES-GCM') throw new VaultError('PROTOCOL', 'Expected an AES-GCM CryptoKey.');
  try {
    return new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData, tagLength: AES_GCM_TAG_BITS },
      key,
      ciphertext,
    ));
  } catch {
    throw new VaultError('CORRUPT', 'Encrypted Vault payload failed authentication.');
  }
}
