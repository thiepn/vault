import { VaultError } from '../domain/errors.js';
import type { AccountId, DeviceId, VaultId } from '../domain/model.js';
import { base64UrlDecode, base64UrlEncode, canonicalContext, canonicalUuid } from './encoding.js';
import { deriveHmacSha256Key, sha256, signHmacSha256 } from './primitives.js';
import { assertVaultMasterKey } from './keys.js';

export const DEVICE_KEY_ALGORITHM = 'RSA-OAEP-3072-SHA256' as const;
const PUBLIC_EXPONENT = new Uint8Array([1, 0, 1]);

export interface DevicePublicKeyDescriptor {
  algorithm: typeof DEVICE_KEY_ALGORITHM;
  publicSpki: string;
  fingerprint: string;
}

export interface DeviceKeyMaterial extends DevicePublicKeyDescriptor {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

export interface DeviceVaultKeyEnvelopeV1 {
  version: 1;
  accountId: AccountId;
  vaultId: VaultId;
  deviceId: DeviceId;
  keyGeneration: number;
  algorithm: typeof DEVICE_KEY_ALGORITHM;
  publicKeyFingerprint: string;
  ciphertext: string;
  createdAt: string;
}

function keyGeneration(value:number):number{
  if(!Number.isSafeInteger(value)||value<1) throw new VaultError('PROTOCOL','Vault key generation must be a positive integer.');
  return value;
}

function assertFingerprint(value:string):void{
  if(!/^[A-Za-z0-9_-]{43}$/u.test(value)) throw new VaultError('PROTOCOL','Device public-key fingerprint is invalid.');
}

function assertRsaPublicKey(key:CryptoKey):void{
  const algorithm=key.algorithm as RsaHashedKeyAlgorithm;
  if(key.type!=='public'||key.algorithm.name!=='RSA-OAEP'||algorithm.modulusLength!==3072||algorithm.hash.name!=='SHA-256'){
    throw new VaultError('PROTOCOL','Device public key must be RSA-OAEP 3072-bit SHA-256.');
  }
}

function assertRsaPrivateKey(key:CryptoKey):void{
  const algorithm=key.algorithm as RsaHashedKeyAlgorithm;
  if(key.type!=='private'||key.algorithm.name!=='RSA-OAEP'||algorithm.modulusLength!==3072||algorithm.hash.name!=='SHA-256'||key.extractable){
    throw new VaultError('PROTOCOL','Device private key must be non-extractable RSA-OAEP 3072-bit SHA-256.');
  }
}

export async function generateDeviceKeyMaterial():Promise<DeviceKeyMaterial>{
  const pair=await crypto.subtle.generateKey({
    name:'RSA-OAEP',
    modulusLength:3072,
    publicExponent:PUBLIC_EXPONENT,
    hash:'SHA-256',
  },false,['encrypt','decrypt']) as CryptoKeyPair;
  assertRsaPrivateKey(pair.privateKey);
  assertRsaPublicKey(pair.publicKey);
  const publicSpkiBytes=new Uint8Array(await crypto.subtle.exportKey('spki',pair.publicKey));
  const fingerprint=base64UrlEncode(await sha256(publicSpkiBytes));
  return {
    algorithm:DEVICE_KEY_ALGORITHM,
    publicSpki:base64UrlEncode(publicSpkiBytes),
    fingerprint,
    privateKey:pair.privateKey,
    publicKey:pair.publicKey,
  };
}

export async function importDevicePublicKey(descriptor:DevicePublicKeyDescriptor):Promise<CryptoKey>{
  if(descriptor.algorithm!==DEVICE_KEY_ALGORITHM) throw new VaultError('PROTOCOL','Unsupported Device key algorithm.');
  assertFingerprint(descriptor.fingerprint);
  const spki=base64UrlDecode(descriptor.publicSpki);
  const actual=base64UrlEncode(await sha256(spki));
  if(actual!==descriptor.fingerprint) throw new VaultError('CORRUPT','Device public key fingerprint does not match its SPKI bytes.');
  const key=await crypto.subtle.importKey('spki',spki,{name:'RSA-OAEP',hash:'SHA-256'},true,['encrypt']);
  assertRsaPublicKey(key);
  return key;
}

export function deviceEnvelopeLabel(input:{
  accountId:AccountId;
  vaultId:VaultId;
  deviceId:DeviceId;
  keyGeneration:number;
  publicKeyFingerprint:string;
}):Uint8Array{
  assertFingerprint(input.publicKeyFingerprint);
  return canonicalContext([
    'vault/device-vmk-envelope/v1',
    canonicalUuid(input.accountId,'AccountId'),
    canonicalUuid(input.vaultId,'VaultId'),
    canonicalUuid(input.deviceId,'DeviceId'),
    keyGeneration(input.keyGeneration),
    input.publicKeyFingerprint,
  ]);
}

export async function createDeviceVaultKeyEnvelope(input:{
  accountId:AccountId;
  vaultId:VaultId;
  deviceId:DeviceId;
  keyGeneration:number;
  publicKey:CryptoKey;
  publicKeyFingerprint:string;
  vmk:Uint8Array;
  createdAt?:string;
}):Promise<DeviceVaultKeyEnvelopeV1>{
  assertVaultMasterKey(input.vmk);
  assertRsaPublicKey(input.publicKey);
  assertFingerprint(input.publicKeyFingerprint);
  const ciphertext=new Uint8Array(await crypto.subtle.encrypt({
    name:'RSA-OAEP',
    label:deviceEnvelopeLabel(input),
  },input.publicKey,input.vmk));
  return {
    version:1,
    accountId:input.accountId,
    vaultId:input.vaultId,
    deviceId:input.deviceId,
    keyGeneration:keyGeneration(input.keyGeneration),
    algorithm:DEVICE_KEY_ALGORITHM,
    publicKeyFingerprint:input.publicKeyFingerprint,
    ciphertext:base64UrlEncode(ciphertext),
    createdAt:input.createdAt ?? new Date().toISOString(),
  };
}

export async function openDeviceVaultKeyEnvelope(input:{
  envelope:DeviceVaultKeyEnvelopeV1;
  privateKey:CryptoKey;
}):Promise<Uint8Array>{
  const envelope=input.envelope;
  if(envelope.version!==1||envelope.algorithm!==DEVICE_KEY_ALGORITHM) throw new VaultError('PROTOCOL','Unsupported Device Vault-key envelope.');
  assertRsaPrivateKey(input.privateKey);
  assertFingerprint(envelope.publicKeyFingerprint);
  try{
    const plaintext=new Uint8Array(await crypto.subtle.decrypt({
      name:'RSA-OAEP',
      label:deviceEnvelopeLabel(envelope),
    },input.privateKey,base64UrlDecode(envelope.ciphertext)));
    assertVaultMasterKey(plaintext);
    return plaintext;
  }catch(error){
    if(error instanceof VaultError) throw error;
    throw new VaultError('CORRUPT','Device Vault-key envelope could not be authenticated/decrypted.');
  }
}

export async function deviceVmkConfirmation(input:{
  vmk:Uint8Array;
  accountId:AccountId;
  vaultId:VaultId;
  deviceId:DeviceId;
  keyGeneration:number;
  challenge:string;
}):Promise<string>{
  assertVaultMasterKey(input.vmk);
  const challenge=base64UrlDecode(input.challenge);
  if(challenge.byteLength!==32) throw new VaultError('PROTOCOL','Device access confirmation challenge must be 32 bytes.');
  const accountId=canonicalUuid(input.accountId,'AccountId');
  const vaultId=canonicalUuid(input.vaultId,'VaultId');
  const deviceId=canonicalUuid(input.deviceId,'DeviceId');
  const generation=keyGeneration(input.keyGeneration);
  const key=await deriveHmacSha256Key(
    input.vmk,
    canonicalContext(['vault/device-confirm-salt/v1',vaultId,generation]),
    canonicalContext(['vault/device-confirm-key/v1',accountId,vaultId,deviceId,generation]),
  );
  return base64UrlEncode(await signHmacSha256(
    key,
    canonicalContext(['vault/device-confirm/v1',accountId,vaultId,deviceId,generation,input.challenge]),
  ));
}

export function shortDeviceFingerprint(fingerprint:string):string{
  assertFingerprint(fingerprint);
  return [fingerprint.slice(0,4),fingerprint.slice(4,8),fingerprint.slice(8,12)].join('-');
}
