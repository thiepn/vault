import { VaultError } from '../domain/errors.js';
import type { VaultId } from '../domain/model.js';
import type { RemoteBlobId } from '../sync/protocol-v2.js';
import { canonicalContext, canonicalUuid } from './encoding.js';
import { assertVaultMasterKey, deriveBlobEncryptionKey } from './keys.js';
import {
  AES_GCM_NONCE_BYTES,
  aes256GcmDecrypt,
  aes256GcmEncrypt,
  randomBytes,
} from './primitives.js';

export const BLOB_ENVELOPE_VERSION = 1 as const;
export const BLOB_ENVELOPE_HEADER_BYTES = 20;
const MAGIC = Uint8Array.of(0x56,0x42,0x4c,0x42); // VBLB
const ALGORITHM_AES_256_GCM = 1;
const RESERVED = 0;

function generation(value:number):number{
  if(!Number.isSafeInteger(value)||value<1) throw new VaultError('PROTOCOL','Blob key generation must be a positive safe integer.');
  return value;
}

function assertBlobId(blobId:RemoteBlobId):void{
  if(typeof blobId!=='string'||!/^[A-Za-z0-9_-]{43}$/u.test(blobId)){
    throw new VaultError('PROTOCOL','Encrypted BlobId is invalid.');
  }
}

export function blobAadV1(input:{
  vaultId:VaultId;
  blobId:RemoteBlobId;
  keyGeneration:number;
}):Uint8Array{
  assertBlobId(input.blobId);
  return canonicalContext([
    'vault/blob-aad/v1',
    canonicalUuid(input.vaultId,'VaultId'),
    input.blobId,
    generation(input.keyGeneration),
  ]);
}

export function encryptedBlobCiphertextSize(plaintextBytes:number):number{
  if(!Number.isSafeInteger(plaintextBytes)||plaintextBytes<0){
    throw new VaultError('PROTOCOL','Blob plaintext size is invalid.');
  }
  return BLOB_ENVELOPE_HEADER_BYTES + plaintextBytes + 16;
}

export async function encryptBlobPayloadV1(input:{
  vmk:Uint8Array;
  vaultId:VaultId;
  blobId:RemoteBlobId;
  keyGeneration:number;
  plaintext:Uint8Array;
}):Promise<Uint8Array>{
  assertVaultMasterKey(input.vmk);
  assertBlobId(input.blobId);
  if(!(input.plaintext instanceof Uint8Array)) throw new VaultError('PROTOCOL','Blob plaintext must be binary bytes.');
  const keyGeneration=generation(input.keyGeneration);
  const key=await deriveBlobEncryptionKey({
    vmk:input.vmk,
    vaultId:input.vaultId,
    blobId:input.blobId,
    keyGeneration,
  });
  const nonce=randomBytes(AES_GCM_NONCE_BYTES);
  const ciphertext=await aes256GcmEncrypt(key,nonce,input.plaintext,blobAadV1({
    vaultId:input.vaultId,blobId:input.blobId,keyGeneration,
  }));
  const result=new Uint8Array(BLOB_ENVELOPE_HEADER_BYTES+ciphertext.byteLength);
  result.set(MAGIC,0);
  result[4]=BLOB_ENVELOPE_VERSION;
  result[5]=ALGORITHM_AES_256_GCM;
  result[6]=AES_GCM_NONCE_BYTES;
  result[7]=RESERVED;
  // bytes 8..19 are the nonce; the generation is deliberately not duplicated
  // in the object because it is authenticated by both path/ref state and AAD.
  result.set(nonce,8);
  result.set(ciphertext,BLOB_ENVELOPE_HEADER_BYTES);
  return result;
}

export async function decryptBlobPayloadV1(input:{
  vmk:Uint8Array;
  vaultId:VaultId;
  blobId:RemoteBlobId;
  keyGeneration:number;
  envelope:Uint8Array;
}):Promise<Uint8Array>{
  assertVaultMasterKey(input.vmk);
  assertBlobId(input.blobId);
  if(!(input.envelope instanceof Uint8Array)||input.envelope.byteLength<BLOB_ENVELOPE_HEADER_BYTES+16){
    throw new VaultError('CORRUPT','Encrypted blob envelope is truncated.');
  }
  for(let index=0;index<MAGIC.length;index++){
    if(input.envelope[index]!==MAGIC[index]) throw new VaultError('CORRUPT','Encrypted blob envelope magic is invalid.');
  }
  if(input.envelope[4]!==BLOB_ENVELOPE_VERSION
    ||input.envelope[5]!==ALGORITHM_AES_256_GCM
    ||input.envelope[6]!==AES_GCM_NONCE_BYTES
    ||input.envelope[7]!==RESERVED){
    throw new VaultError('PROTOCOL','Encrypted blob envelope suite is unsupported.');
  }
  const keyGeneration=generation(input.keyGeneration);
  const nonce=input.envelope.slice(8,20);
  const ciphertext=input.envelope.slice(BLOB_ENVELOPE_HEADER_BYTES);
  const key=await deriveBlobEncryptionKey({
    vmk:input.vmk,
    vaultId:input.vaultId,
    blobId:input.blobId,
    keyGeneration,
  });
  return aes256GcmDecrypt(key,nonce,ciphertext,blobAadV1({
    vaultId:input.vaultId,blobId:input.blobId,keyGeneration,
  }));
}
