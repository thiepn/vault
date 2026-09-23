import { VaultError } from '../domain/errors.js';
import type { AccountId, VaultId } from '../domain/model.js';
import { base64UrlDecode, base64UrlEncode, canonicalContext, canonicalUuid } from './encoding.js';
import { AES_GCM_NONCE_BYTES, aes256GcmDecrypt, aes256GcmEncrypt, deriveAes256GcmKey, randomBytes, sha256 } from './primitives.js';
import { assertVaultMasterKey } from './keys.js';

export const RECOVERY_SECRET_BYTES=32;
export const RECOVERY_ENVELOPE_ALGORITHM='A256GCM' as const;
const BASE32='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const RECOVERY_PREFIX='VLT1';

export interface RecoveryVaultKeyEnvelopeV1 {
  version:1;
  accountId:AccountId;
  vaultId:VaultId;
  keyGeneration:number;
  algorithm:typeof RECOVERY_ENVELOPE_ALGORITHM;
  nonce:string;
  ciphertext:string;
  createdAt:string;
}

function generation(value:number):number{
  if(!Number.isSafeInteger(value)||value<1) throw new VaultError('PROTOCOL','Vault key generation must be a positive integer.');
  return value;
}
function concat(...parts:Uint8Array[]):Uint8Array{
  const total=parts.reduce((sum,part)=>sum+part.byteLength,0);
  const output=new Uint8Array(total);
  let offset=0;
  for(const part of parts){output.set(part,offset);offset+=part.byteLength;}
  return output;
}
function base32Encode(bytes:Uint8Array):string{
  let bits=0,value=0,output='';
  for(const byte of bytes){
    value=(value<<8)|byte;
    bits+=8;
    while(bits>=5){output+=BASE32[(value>>>(bits-5))&31];bits-=5;}
  }
  if(bits>0) output+=BASE32[(value<<(5-bits))&31];
  return output;
}
function base32Decode(value:string):Uint8Array{
  if(!/^[A-Z2-7]+$/u.test(value)) throw new VaultError('PROTOCOL','Recovery code contains invalid base32 characters.');
  let bits=0,buffer=0;
  const bytes:number[]=[];
  for(const character of value){
    const digit=BASE32.indexOf(character);
    buffer=(buffer<<5)|digit;
    bits+=5;
    if(bits>=8){bytes.push((buffer>>>(bits-8))&255);bits-=8;}
  }
  if(bits>0 && (buffer & ((1<<bits)-1))!==0) throw new VaultError('PROTOCOL','Recovery code has non-canonical trailing bits.');
  return Uint8Array.from(bytes);
}

export function generateRecoverySecret():Uint8Array{
  return randomBytes(RECOVERY_SECRET_BYTES);
}
export function assertRecoverySecret(secret:Uint8Array):void{
  if(!(secret instanceof Uint8Array)||secret.byteLength!==RECOVERY_SECRET_BYTES) throw new VaultError('PROTOCOL','Recovery Secret must be exactly 256 bits.');
}

async function checksum(secret:Uint8Array):Promise<Uint8Array>{
  const digest=await sha256(concat(canonicalContext(['vault/recovery-secret-checksum/v1']),secret));
  return digest.slice(0,4);
}

export async function encodeRecoverySecret(secret:Uint8Array):Promise<string>{
  assertRecoverySecret(secret);
  const payload=concat(secret,await checksum(secret));
  const encoded=base32Encode(payload);
  const groups=encoded.match(/.{1,4}/gu) ?? [];
  return RECOVERY_PREFIX+'-'+groups.join('-');
}

export async function decodeRecoverySecret(value:string):Promise<Uint8Array>{
  if(typeof value!=='string') throw new VaultError('PROTOCOL','Recovery code is invalid.');
  const compact=value.trim().toUpperCase().replace(/[\s-]+/gu,'');
  if(!compact.startsWith(RECOVERY_PREFIX)) throw new VaultError('PROTOCOL','Recovery code version is invalid.');
  const payload=base32Decode(compact.slice(RECOVERY_PREFIX.length));
  if(payload.byteLength!==RECOVERY_SECRET_BYTES+4) throw new VaultError('PROTOCOL','Recovery code length is invalid.');
  const secret=payload.slice(0,RECOVERY_SECRET_BYTES);
  const expected=await checksum(secret);
  const actual=payload.slice(RECOVERY_SECRET_BYTES);
  if(!actual.every((byte,index)=>byte===expected[index])) throw new VaultError('CORRUPT','Recovery code checksum is invalid.');
  return secret;
}

function recoveryAad(input:{accountId:AccountId;vaultId:VaultId;keyGeneration:number}):Uint8Array{
  return canonicalContext([
    'vault/recovery-envelope/v1',
    canonicalUuid(input.accountId,'AccountId'),
    canonicalUuid(input.vaultId,'VaultId'),
    generation(input.keyGeneration),
  ]);
}
async function recoveryKey(input:{secret:Uint8Array;accountId:AccountId;vaultId:VaultId;keyGeneration:number}):Promise<CryptoKey>{
  assertRecoverySecret(input.secret);
  const accountId=canonicalUuid(input.accountId,'AccountId');
  const vaultId=canonicalUuid(input.vaultId,'VaultId');
  const keyGeneration=generation(input.keyGeneration);
  return deriveAes256GcmKey(
    input.secret,
    canonicalContext(['vault/recovery-envelope-salt/v1',accountId,vaultId,keyGeneration]),
    canonicalContext(['vault/recovery-envelope-key/v1',accountId,vaultId,keyGeneration]),
  );
}

export async function createRecoveryVaultKeyEnvelope(input:{
  secret:Uint8Array;
  accountId:AccountId;
  vaultId:VaultId;
  keyGeneration:number;
  vmk:Uint8Array;
  createdAt?:string;
}):Promise<RecoveryVaultKeyEnvelopeV1>{
  assertRecoverySecret(input.secret);
  assertVaultMasterKey(input.vmk);
  const nonce=randomBytes(AES_GCM_NONCE_BYTES);
  const key=await recoveryKey(input);
  const ciphertext=await aes256GcmEncrypt(key,nonce,input.vmk,recoveryAad(input));
  return {
    version:1,
    accountId:input.accountId,
    vaultId:input.vaultId,
    keyGeneration:generation(input.keyGeneration),
    algorithm:RECOVERY_ENVELOPE_ALGORITHM,
    nonce:base64UrlEncode(nonce),
    ciphertext:base64UrlEncode(ciphertext),
    createdAt:input.createdAt ?? new Date().toISOString(),
  };
}

export async function openRecoveryVaultKeyEnvelope(input:{
  secret:Uint8Array;
  envelope:RecoveryVaultKeyEnvelopeV1;
}):Promise<Uint8Array>{
  assertRecoverySecret(input.secret);
  if(input.envelope.version!==1||input.envelope.algorithm!==RECOVERY_ENVELOPE_ALGORITHM) throw new VaultError('PROTOCOL','Unsupported recovery Vault-key envelope.');
  const nonce=base64UrlDecode(input.envelope.nonce);
  if(nonce.byteLength!==AES_GCM_NONCE_BYTES) throw new VaultError('PROTOCOL','Recovery envelope nonce is invalid.');
  const key=await recoveryKey({
    secret:input.secret,
    accountId:input.envelope.accountId,
    vaultId:input.envelope.vaultId,
    keyGeneration:input.envelope.keyGeneration,
  });
  const vmk=await aes256GcmDecrypt(key,nonce,base64UrlDecode(input.envelope.ciphertext),recoveryAad(input.envelope));
  assertVaultMasterKey(vmk);
  return vmk;
}

export async function recoverySecretFingerprint(secret:Uint8Array):Promise<string>{
  assertRecoverySecret(secret);
  return base64UrlEncode(await sha256(concat(canonicalContext(['vault/recovery-secret-fingerprint/v1']),secret)));
}
