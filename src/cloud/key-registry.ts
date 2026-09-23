import { VaultError } from '../domain/errors.js';
import type { AccountId, DeviceId, VaultId } from '../domain/model.js';
import type { PublicBackendConfig } from '../services/runtime-config.js';
import type { DevicePublicKeyDescriptor, DeviceVaultKeyEnvelopeV1 } from '../crypto/device-keys.js';
import type { RecoveryVaultKeyEnvelopeV1 } from '../crypto/recovery.js';

type FetchLike=typeof fetch;

export interface VaultKeyReadiness {
  vaultId:VaultId;
  deviceId:DeviceId;
  keyGeneration:number|null;
  deviceEnvelope:boolean;
  recoveryEnvelope:boolean;
  deviceAuthorized:boolean;
  ready:boolean;
}

export interface AuthorizedDeviceKey extends DevicePublicKeyDescriptor {
  accountId:AccountId;
  deviceId:DeviceId;
}

export interface DeviceAccessRequest {
  requestId:string;
  vaultId:VaultId;
  accountId:AccountId;
  deviceId:DeviceId;
  algorithm:'RSA-OAEP-3072-SHA256';
  publicSpki:string;
  publicKeyFingerprint:string;
  challenge:string;
  status:'pending'|'approved'|'confirmed'|'rejected'|'expired';
  createdAt:string;
  expiresAt:string;
}

export interface PendingDeviceAccess {
  requestId:string;
  challenge:string;
  activeGeneration:number;
  envelopes:DeviceVaultKeyEnvelopeV1[];
}

export interface RecoveryEnvelopeProof {
  envelope:RecoveryVaultKeyEnvelopeV1;
  recoveryProof:string;
}

export interface KeyRegistryPort {
  registerDeviceKey(accountId:AccountId,deviceId:DeviceId,descriptor:DevicePublicKeyDescriptor):Promise<void>;
  initializeVaultKeys(input:{
    accountId:AccountId;
    vaultId:VaultId;
    deviceId:DeviceId;
    deviceEnvelope:DeviceVaultKeyEnvelopeV1;
    recoveryEnvelope:RecoveryVaultKeyEnvelopeV1;
    recoveryProof:string;
  }):Promise<VaultKeyReadiness>;
  readiness(vaultId:VaultId,deviceId:DeviceId):Promise<VaultKeyReadiness>;
  deviceEnvelopes(vaultId:VaultId,deviceId:DeviceId):Promise<DeviceVaultKeyEnvelopeV1[]>;
  recoveryEnvelopes(vaultId:VaultId):Promise<RecoveryVaultKeyEnvelopeV1[]>;
  authorizedDevices(vaultId:VaultId,actorDeviceId:DeviceId):Promise<AuthorizedDeviceKey[]>;
  requestAccess(vaultId:VaultId,deviceId:DeviceId,publicKeyFingerprint:string):Promise<DeviceAccessRequest>;
  listAccessRequests(vaultId:VaultId,approverDeviceId:DeviceId):Promise<DeviceAccessRequest[]>;
  approveAccessRequest(input:{
    requestId:string;
    approverDeviceId:DeviceId;
    activeGeneration:number;
    envelopes:DeviceVaultKeyEnvelopeV1[];
    expectedConfirmation:string;
  }):Promise<void>;
  pendingAccess(requestId:string,deviceId:DeviceId):Promise<PendingDeviceAccess>;
  confirmAccess(requestId:string,deviceId:DeviceId,confirmation:string):Promise<VaultKeyReadiness>;
  recoverDevice(input:{
    vaultId:VaultId;
    deviceId:DeviceId;
    activeGeneration:number;
    envelopes:DeviceVaultKeyEnvelopeV1[];
    recoveryProofs:readonly {keyGeneration:number;recoveryProof:string}[];
  }):Promise<VaultKeyReadiness>;
  rotateVaultKey(input:{
    vaultId:VaultId;
    actorDeviceId:DeviceId;
    fromGeneration:number;
    toGeneration:number;
    deviceEnvelopes:DeviceVaultKeyEnvelopeV1[];
    recovery:RecoveryEnvelopeProof;
  }):Promise<VaultKeyReadiness>;
  rotateRecovery(input:{
    vaultId:VaultId;
    actorDeviceId:DeviceId;
    replacements:RecoveryEnvelopeProof[];
  }):Promise<void>;
}

function asObject(value:unknown,label:string):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)) throw new VaultError('PROTOCOL',label+' is invalid.');
  return value as Record<string,unknown>;
}
function uuid(value:unknown,label:string):string{
  if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) throw new VaultError('PROTOCOL',label+' is invalid.');
  return value;
}
function integer(value:unknown,label:string):number{
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1) throw new VaultError('PROTOCOL',label+' is invalid.');
  return value;
}
function token43(value:unknown,label:string):string{
  if(typeof value!=='string'||!/^[A-Za-z0-9_-]{43}$/u.test(value)) throw new VaultError('PROTOCOL',label+' is invalid.');
  return value;
}
function timestamp(value:unknown,label:string):string{
  if(typeof value!=='string'||!Number.isFinite(Date.parse(value))) throw new VaultError('PROTOCOL',label+' is invalid.');
  return value;
}
function mapEnvelope(value:unknown):DeviceVaultKeyEnvelopeV1{
  const r=asObject(value,'Device Vault-key envelope');
  if(r.version!==1||r.algorithm!=='RSA-OAEP-3072-SHA256'||typeof r.ciphertext!=='string'||!/^[A-Za-z0-9_-]{512}$/u.test(r.ciphertext)) throw new VaultError('PROTOCOL','Device Vault-key envelope is invalid.');
  return {
    version:1,
    accountId:uuid(r.accountId,'Envelope AccountId') as AccountId,
    vaultId:uuid(r.vaultId,'Envelope VaultId') as VaultId,
    deviceId:uuid(r.deviceId,'Envelope DeviceId') as DeviceId,
    keyGeneration:integer(r.keyGeneration,'Envelope key generation'),
    algorithm:'RSA-OAEP-3072-SHA256',
    publicKeyFingerprint:token43(r.publicKeyFingerprint,'Envelope public-key fingerprint'),
    ciphertext:r.ciphertext,
    createdAt:timestamp(r.createdAt,'Envelope creation time'),
  };
}
function mapRecoveryEnvelope(value:unknown):RecoveryVaultKeyEnvelopeV1{
  const r=asObject(value,'Recovery Vault-key envelope');
  if(r.version!==1||r.algorithm!=='A256GCM'||typeof r.nonce!=='string'||!/^[A-Za-z0-9_-]{16}$/u.test(r.nonce)
    ||typeof r.ciphertext!=='string'||!/^[A-Za-z0-9_-]{64}$/u.test(r.ciphertext)) throw new VaultError('PROTOCOL','Recovery Vault-key envelope is invalid.');
  return {
    version:1,
    accountId:uuid(r.accountId,'Recovery envelope AccountId') as AccountId,
    vaultId:uuid(r.vaultId,'Recovery envelope VaultId') as VaultId,
    keyGeneration:integer(r.keyGeneration,'Recovery envelope key generation'),
    algorithm:'A256GCM',
    nonce:r.nonce,
    ciphertext:r.ciphertext,
    createdAt:timestamp(r.createdAt,'Recovery envelope creation time'),
  };
}
function mapReadiness(value:unknown):VaultKeyReadiness{
  const r=asObject(value,'Vault key readiness');
  if(typeof r.deviceEnvelope!=='boolean'||typeof r.recoveryEnvelope!=='boolean'||typeof r.deviceAuthorized!=='boolean'||typeof r.ready!=='boolean') throw new VaultError('PROTOCOL','Vault key readiness is invalid.');
  return {
    vaultId:uuid(r.vaultId,'Readiness VaultId') as VaultId,
    deviceId:uuid(r.deviceId,'Readiness DeviceId') as DeviceId,
    keyGeneration:r.keyGeneration===null?null:integer(r.keyGeneration,'Readiness key generation'),
    deviceEnvelope:r.deviceEnvelope,
    recoveryEnvelope:r.recoveryEnvelope,
    deviceAuthorized:r.deviceAuthorized,
    ready:r.ready,
  };
}
function mapRequest(value:unknown):DeviceAccessRequest{
  const r=asObject(value,'Device access request');
  if(r.algorithm!=='RSA-OAEP-3072-SHA256'||typeof r.publicSpki!=='string'||typeof r.status!=='string'||!['pending','approved','confirmed','rejected','expired'].includes(r.status)) throw new VaultError('PROTOCOL','Device access request is invalid.');
  return {
    requestId:uuid(r.requestId,'Access request ID'),
    vaultId:uuid(r.vaultId,'Access request VaultId') as VaultId,
    accountId:uuid(r.accountId,'Access request AccountId') as AccountId,
    deviceId:uuid(r.deviceId,'Access request DeviceId') as DeviceId,
    algorithm:'RSA-OAEP-3072-SHA256',
    publicSpki:r.publicSpki,
    publicKeyFingerprint:token43(r.publicKeyFingerprint,'Access request fingerprint'),
    challenge:token43(r.challenge,'Access request challenge'),
    status:r.status as DeviceAccessRequest['status'],
    createdAt:timestamp(r.createdAt,'Access request creation time'),
    expiresAt:timestamp(r.expiresAt,'Access request expiry'),
  };
}
function mapAuthorizedDevice(value:unknown):AuthorizedDeviceKey{
  const r=asObject(value,'Authorized Device key');
  if(r.algorithm!=='RSA-OAEP-3072-SHA256'||typeof r.publicSpki!=='string'){
    throw new VaultError('PROTOCOL','Authorized Device key is invalid.');
  }
  return {
    accountId:uuid(r.accountId,'Authorized Device AccountId') as AccountId,
    deviceId:uuid(r.deviceId,'Authorized DeviceId') as DeviceId,
    algorithm:'RSA-OAEP-3072-SHA256',
    publicSpki:r.publicSpki,
    fingerprint:token43(r.fingerprint,'Authorized Device fingerprint'),
  };
}
function envelopeWire(envelope:DeviceVaultKeyEnvelopeV1):Record<string,unknown>{
  return {
    accountId:envelope.accountId,
    vaultId:envelope.vaultId,
    deviceId:envelope.deviceId,
    keyGeneration:envelope.keyGeneration,
    algorithm:envelope.algorithm,
    publicKeyFingerprint:envelope.publicKeyFingerprint,
    ciphertext:envelope.ciphertext,
  };
}
function recoveryWire(recovery:RecoveryEnvelopeProof):Record<string,unknown>{
  return {
    accountId:recovery.envelope.accountId,
    vaultId:recovery.envelope.vaultId,
    keyGeneration:recovery.envelope.keyGeneration,
    algorithm:recovery.envelope.algorithm,
    nonce:recovery.envelope.nonce,
    ciphertext:recovery.envelope.ciphertext,
    recoveryProof:recovery.recoveryProof,
  };
}
async function json(response:Response):Promise<unknown>{try{return await response.json();}catch{return null;}}
function message(payload:unknown,fallback:string):string{
  if(payload&&typeof payload==='object'){
    const r=payload as Record<string,unknown>;
    for(const key of ['message','details','hint','code']) if(typeof r[key]==='string'&&r[key]) return r[key] as string;
  }
  return fallback;
}

export class SupabaseKeyRegistry implements KeyRegistryPort {
  constructor(
    private readonly config:PublicBackendConfig,
    private readonly token:()=>Promise<string|null>,
    private readonly request:FetchLike=(input,init)=>fetch(input,init),
  ){}

  private async rpc(name:string,payload:Record<string,unknown>):Promise<unknown>{
    const accessToken=await this.token();
    if(!accessToken) throw new VaultError('ACCOUNT_MISMATCH','Sign in before using encrypted Vault keys.');
    const response=await this.request(`${this.config.url}/rest/v1/rpc/${name}`,{
      method:'POST',
      headers:{apikey:this.config.publishableKey,Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json'},
      body:JSON.stringify(payload),
    });
    const parsed=await json(response);
    if(!response.ok) throw new VaultError(response.status===401||response.status===403?'PERMISSION':'CONFIGURATION',message(parsed,'Vault key-registry request failed.'));
    return parsed;
  }

  async registerDeviceKey(accountId:AccountId,deviceId:DeviceId,descriptor:DevicePublicKeyDescriptor):Promise<void>{
    await this.rpc('vault_key_register_device',{
      p_account_id:accountId,p_device_id:deviceId,p_algorithm:descriptor.algorithm,
      p_public_spki:descriptor.publicSpki,p_fingerprint:descriptor.fingerprint,
    });
  }

  async initializeVaultKeys(input:Parameters<KeyRegistryPort['initializeVaultKeys']>[0]):Promise<VaultKeyReadiness>{
    return mapReadiness(await this.rpc('vault_key_initialize_vault',{
      p_account_id:input.accountId,p_vault_id:input.vaultId,p_device_id:input.deviceId,
      p_key_generation:input.deviceEnvelope.keyGeneration,
      p_device_ciphertext:input.deviceEnvelope.ciphertext,
      p_public_key_fingerprint:input.deviceEnvelope.publicKeyFingerprint,
      p_recovery_nonce:input.recoveryEnvelope.nonce,
      p_recovery_ciphertext:input.recoveryEnvelope.ciphertext,
      p_recovery_proof:input.recoveryProof,
    }));
  }

  async readiness(vaultId:VaultId,deviceId:DeviceId):Promise<VaultKeyReadiness>{
    return mapReadiness(await this.rpc('vault_key_readiness',{p_vault_id:vaultId,p_device_id:deviceId}));
  }

  async deviceEnvelopes(vaultId:VaultId,deviceId:DeviceId):Promise<DeviceVaultKeyEnvelopeV1[]>{
    const value=await this.rpc('vault_key_device_envelopes',{p_vault_id:vaultId,p_device_id:deviceId});
    if(!Array.isArray(value)) throw new VaultError('PROTOCOL','Device envelope listing is invalid.');
    return value.map(mapEnvelope);
  }

  async recoveryEnvelopes(vaultId:VaultId):Promise<RecoveryVaultKeyEnvelopeV1[]>{
    const value=await this.rpc('vault_key_recovery_envelopes',{p_vault_id:vaultId});
    if(!Array.isArray(value)) throw new VaultError('PROTOCOL','Recovery envelope listing is invalid.');
    return value.map(mapRecoveryEnvelope);
  }

  async authorizedDevices(vaultId:VaultId,actorDeviceId:DeviceId):Promise<AuthorizedDeviceKey[]>{
    const value=await this.rpc('vault_key_authorized_devices',{p_vault_id:vaultId,p_actor_device_id:actorDeviceId});
    if(!Array.isArray(value)) throw new VaultError('PROTOCOL','Authorized Device listing is invalid.');
    return value.map(mapAuthorizedDevice);
  }

  async requestAccess(vaultId:VaultId,deviceId:DeviceId,publicKeyFingerprint:string):Promise<DeviceAccessRequest>{
    return mapRequest(await this.rpc('vault_key_request_access',{p_vault_id:vaultId,p_device_id:deviceId,p_fingerprint:publicKeyFingerprint}));
  }

  async listAccessRequests(vaultId:VaultId,approverDeviceId:DeviceId):Promise<DeviceAccessRequest[]>{
    const value=await this.rpc('vault_key_list_access_requests',{p_vault_id:vaultId,p_approver_device_id:approverDeviceId});
    if(!Array.isArray(value)) throw new VaultError('PROTOCOL','Device access-request listing is invalid.');
    return value.map(mapRequest);
  }

  async approveAccessRequest(input:Parameters<KeyRegistryPort['approveAccessRequest']>[0]):Promise<void>{
    await this.rpc('vault_key_approve_access_request_v2',{
      p_request_id:input.requestId,
      p_approver_device_id:input.approverDeviceId,
      p_active_generation:input.activeGeneration,
      p_envelopes:input.envelopes.map(envelopeWire),
      p_expected_confirmation:input.expectedConfirmation,
    });
  }

  async pendingAccess(requestId:string,deviceId:DeviceId):Promise<PendingDeviceAccess>{
    const r=asObject(await this.rpc('vault_key_pending_access_v2',{p_request_id:requestId,p_device_id:deviceId}),'Pending Device access');
    if(!Array.isArray(r.envelopes)) throw new VaultError('PROTOCOL','Pending Device envelopes are invalid.');
    return {
      requestId:uuid(r.requestId,'Pending request ID'),
      challenge:token43(r.challenge,'Pending access challenge'),
      activeGeneration:integer(r.activeGeneration,'Pending active key generation'),
      envelopes:r.envelopes.map(mapEnvelope),
    };
  }

  async confirmAccess(requestId:string,deviceId:DeviceId,confirmation:string):Promise<VaultKeyReadiness>{
    return mapReadiness(await this.rpc('vault_key_confirm_access',{
      p_request_id:requestId,p_device_id:deviceId,p_confirmation:confirmation,
    }));
  }

  async recoverDevice(input:Parameters<KeyRegistryPort['recoverDevice']>[0]):Promise<VaultKeyReadiness>{
    return mapReadiness(await this.rpc('vault_key_recover_device_v2',{
      p_vault_id:input.vaultId,
      p_device_id:input.deviceId,
      p_active_generation:input.activeGeneration,
      p_envelopes:input.envelopes.map(envelopeWire),
      p_recovery_proofs:input.recoveryProofs,
    }));
  }

  async rotateVaultKey(input:Parameters<KeyRegistryPort['rotateVaultKey']>[0]):Promise<VaultKeyReadiness>{
    return mapReadiness(await this.rpc('vault_key_rotate_vmk',{
      p_vault_id:input.vaultId,
      p_actor_device_id:input.actorDeviceId,
      p_from_generation:input.fromGeneration,
      p_to_generation:input.toGeneration,
      p_device_envelopes:input.deviceEnvelopes.map(envelopeWire),
      p_recovery:recoveryWire(input.recovery),
    }));
  }

  async rotateRecovery(input:Parameters<KeyRegistryPort['rotateRecovery']>[0]):Promise<void>{
    await this.rpc('vault_key_rotate_recovery',{
      p_vault_id:input.vaultId,
      p_actor_device_id:input.actorDeviceId,
      p_replacements:input.replacements.map(recoveryWire),
    });
  }
}
