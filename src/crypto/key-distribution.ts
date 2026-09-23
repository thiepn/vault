import { VaultError } from '../domain/errors.js';
import type { AccountId, DeviceId, VaultId } from '../domain/model.js';
import { VaultCryptoContext } from './context.js';
import {
  DEVICE_KEY_ALGORITHM,
  createDeviceVaultKeyEnvelope,
  deviceVmkConfirmation,
  generateDeviceKeyMaterial,
  importDevicePublicKey,
  openDeviceVaultKeyEnvelope,
  type DeviceKeyMaterial,
} from './device-keys.js';
import {
  createRecoveryVaultKeyEnvelope,
  decodeRecoverySecret,
  encodeRecoverySecret,
  generateRecoverySecret,
  openRecoveryVaultKeyEnvelope,
  recoverySecretFingerprint,
  recoverySecretProof,
} from './recovery.js';
import {
  deviceEnvelopeRecordId,
  deviceKeyRecordId,
  type DeviceKeyStore,
  type StoredDeviceEnvelope,
  type StoredDeviceKey,
} from './keyring.js';
import { generateVaultMasterKey } from './keys.js';
import type { DeviceAccessRequest, KeyRegistryPort, VaultKeyReadiness } from '../cloud/key-registry.js';

export interface GeneratedRecoverySecret {
  secret:Uint8Array;
  code:string;
  fingerprint:string;
}

export class KeyDistributionService {
  constructor(
    private readonly local:DeviceKeyStore,
    private readonly remote:KeyRegistryPort,
  ){}

  async generateRecoverySecret():Promise<GeneratedRecoverySecret>{
    const secret=generateRecoverySecret();
    return {
      secret,
      code:await encodeRecoverySecret(secret),
      fingerprint:await recoverySecretFingerprint(secret),
    };
  }

  async parseRecoveryCode(code:string):Promise<Uint8Array>{
    return decodeRecoverySecret(code);
  }

  async ensureDeviceKey(accountId:AccountId,deviceId:DeviceId):Promise<StoredDeviceKey>{
    const existing=await this.local.getDeviceKey(accountId,deviceId);
    if(existing){
      await this.remote.registerDeviceKey(accountId,deviceId,{
        algorithm:existing.algorithm,
        publicSpki:existing.publicSpki,
        fingerprint:existing.fingerprint,
      });
      return existing;
    }

    const generated=await generateDeviceKeyMaterial();
    const stored:StoredDeviceKey={
      id:deviceKeyRecordId(accountId,deviceId),
      accountId,
      deviceId,
      algorithm:DEVICE_KEY_ALGORITHM,
      publicSpki:generated.publicSpki,
      fingerprint:generated.fingerprint,
      privateKey:generated.privateKey,
      createdAt:new Date().toISOString(),
    };
    await this.local.putDeviceKey(stored);
    await this.remote.registerDeviceKey(accountId,deviceId,{
      algorithm:stored.algorithm,
      publicSpki:stored.publicSpki,
      fingerprint:stored.fingerprint,
    });
    return stored;
  }

  private async publicMaterial(stored:StoredDeviceKey):Promise<DeviceKeyMaterial>{
    const publicKey=await importDevicePublicKey({
      algorithm:stored.algorithm,
      publicSpki:stored.publicSpki,
      fingerprint:stored.fingerprint,
    });
    return {...stored,publicKey};
  }

  private async storeEnvelope(envelope:Omit<StoredDeviceEnvelope,'id'>):Promise<void>{
    await this.local.putEnvelope({
      ...envelope,
      id:deviceEnvelopeRecordId(envelope.accountId,envelope.vaultId,envelope.deviceId,envelope.keyGeneration),
    });
  }

  async initializeVault(input:{
    accountId:AccountId;
    vaultId:VaultId;
    deviceId:DeviceId;
    recoverySecret:Uint8Array;
    keyGeneration?:number;
  }):Promise<{context:VaultCryptoContext;readiness:VaultKeyReadiness}>{
    const keyGeneration=input.keyGeneration ?? 1;
    const device=await this.ensureDeviceKey(input.accountId,input.deviceId);
    const material=await this.publicMaterial(device);
    const vmk=generateVaultMasterKey();
    try{
      const deviceEnvelope=await createDeviceVaultKeyEnvelope({
        accountId:input.accountId,vaultId:input.vaultId,deviceId:input.deviceId,keyGeneration,
        publicKey:material.publicKey,publicKeyFingerprint:material.fingerprint,vmk,
      });
      const recoveryEnvelope=await createRecoveryVaultKeyEnvelope({
        secret:input.recoverySecret,accountId:input.accountId,vaultId:input.vaultId,keyGeneration,vmk,
      });
      const recoveryProof=await recoverySecretProof({
        secret:input.recoverySecret,accountId:input.accountId,vaultId:input.vaultId,keyGeneration,
      });
      const readiness=await this.remote.initializeVaultKeys({
        accountId:input.accountId,vaultId:input.vaultId,deviceId:input.deviceId,
        deviceEnvelope,recoveryEnvelope,recoveryProof,
      });
      if(!readiness.ready) throw new VaultError('CONFIGURATION','Encrypted Vault is not ready: both Device and Recovery envelopes must be durable.');
      await this.storeEnvelope(deviceEnvelope);
      return {context:new VaultCryptoContext(input.vaultId,keyGeneration,vmk),readiness};
    }finally{
      vmk.fill(0);
    }
  }

  async unlockLocal(input:{
    accountId:AccountId;
    vaultId:VaultId;
    deviceId:DeviceId;
    keyGeneration?:number;
  }):Promise<VaultCryptoContext>{
    const device=await this.local.getDeviceKey(input.accountId,input.deviceId);
    if(!device) throw new VaultError('NOT_FOUND','This browser does not have the Device private key for this Account.');
    const envelopes=await this.local.listEnvelopes(input.accountId,input.vaultId,input.deviceId);
    const envelope=input.keyGeneration===undefined
      ? envelopes.at(-1)
      : envelopes.find(row=>row.keyGeneration===input.keyGeneration);
    if(!envelope) throw new VaultError('NOT_FOUND','This Device has no local Vault-key envelope for the requested generation.');
    const vmk=await openDeviceVaultKeyEnvelope({envelope,privateKey:device.privateKey});
    try{return new VaultCryptoContext(input.vaultId,envelope.keyGeneration,vmk);}
    finally{vmk.fill(0);}
  }

  async refreshDeviceEnvelopes(input:{accountId:AccountId;vaultId:VaultId;deviceId:DeviceId}):Promise<number>{
    const device=await this.local.getDeviceKey(input.accountId,input.deviceId);
    if(!device) throw new VaultError('NOT_FOUND','This browser does not have its Device key.');
    const envelopes=await this.remote.deviceEnvelopes(input.vaultId,input.deviceId);
    let stored=0;
    for(const envelope of envelopes){
      if(envelope.accountId!==input.accountId||envelope.deviceId!==input.deviceId||envelope.publicKeyFingerprint!==device.fingerprint){
        throw new VaultError('ACCOUNT_MISMATCH','Remote Device envelope does not match this Device cryptographic identity.');
      }
      await this.storeEnvelope(envelope);
      stored+=1;
    }
    return stored;
  }

  async requestAccess(input:{accountId:AccountId;vaultId:VaultId;deviceId:DeviceId}):Promise<DeviceAccessRequest>{
    const device=await this.ensureDeviceKey(input.accountId,input.deviceId);
    return this.remote.requestAccess(input.vaultId,input.deviceId,device.fingerprint);
  }

  async approveAccessRequest(input:{
    accountId:AccountId;
    approverDeviceId:DeviceId;
    request:DeviceAccessRequest;
    keyGeneration:number;
  }):Promise<void>{
    if(input.request.accountId!==input.accountId) throw new VaultError('ACCOUNT_MISMATCH','Access request belongs to another Account.');
    const approver=await this.local.getDeviceKey(input.accountId,input.approverDeviceId);
    if(!approver) throw new VaultError('NOT_FOUND','Approving Device private key is unavailable.');
    const localEnvelope=await this.local.getEnvelope(input.accountId,input.request.vaultId,input.approverDeviceId,input.keyGeneration);
    if(!localEnvelope) throw new VaultError('NOT_FOUND','Approving Device does not hold the requested Vault-key generation.');
    const vmk=await openDeviceVaultKeyEnvelope({envelope:localEnvelope,privateKey:approver.privateKey});
    try{
      const targetPublicKey=await importDevicePublicKey({
        algorithm:input.request.algorithm,
        publicSpki:input.request.publicSpki,
        fingerprint:input.request.publicKeyFingerprint,
      });
      const envelope=await createDeviceVaultKeyEnvelope({
        accountId:input.accountId,vaultId:input.request.vaultId,deviceId:input.request.deviceId,
        keyGeneration:input.keyGeneration,publicKey:targetPublicKey,
        publicKeyFingerprint:input.request.publicKeyFingerprint,vmk,
      });
      const expectedConfirmation=await deviceVmkConfirmation({
        vmk,accountId:input.accountId,vaultId:input.request.vaultId,deviceId:input.request.deviceId,
        keyGeneration:input.keyGeneration,challenge:input.request.challenge,
      });
      await this.remote.approveAccessRequest({
        requestId:input.request.requestId,
        approverDeviceId:input.approverDeviceId,
        envelope,
        expectedConfirmation,
      });
    }finally{vmk.fill(0);}
  }

  async completePendingAccess(input:{
    accountId:AccountId;
    requestId:string;
    deviceId:DeviceId;
  }):Promise<{context:VaultCryptoContext;readiness:VaultKeyReadiness}>{
    const device=await this.ensureDeviceKey(input.accountId,input.deviceId);
    const pending=await this.remote.pendingAccess(input.requestId,input.deviceId);
    if(pending.envelope.accountId!==input.accountId||pending.envelope.deviceId!==input.deviceId||pending.envelope.publicKeyFingerprint!==device.fingerprint){
      throw new VaultError('ACCOUNT_MISMATCH','Pending Vault access targets another Device identity.');
    }
    const vmk=await openDeviceVaultKeyEnvelope({envelope:pending.envelope,privateKey:device.privateKey});
    try{
      const confirmation=await deviceVmkConfirmation({
        vmk,accountId:input.accountId,vaultId:pending.envelope.vaultId,deviceId:input.deviceId,
        keyGeneration:pending.envelope.keyGeneration,challenge:pending.challenge,
      });
      const readiness=await this.remote.confirmAccess(input.requestId,input.deviceId,confirmation);
      if(!readiness.deviceAuthorized) throw new VaultError('PERMISSION','Device key possession was not confirmed.');
      await this.storeEnvelope(pending.envelope);
      return {
        context:new VaultCryptoContext(pending.envelope.vaultId,pending.envelope.keyGeneration,vmk),
        readiness,
      };
    }finally{vmk.fill(0);}
  }

  async recoverDevice(input:{
    accountId:AccountId;
    vaultId:VaultId;
    deviceId:DeviceId;
    keyGeneration:number;
    recoverySecret:Uint8Array;
  }):Promise<{context:VaultCryptoContext;readiness:VaultKeyReadiness}>{
    const device=await this.ensureDeviceKey(input.accountId,input.deviceId);
    const material=await this.publicMaterial(device);
    const recoveryEnvelope=await this.remote.recoveryEnvelope(input.vaultId,input.keyGeneration);
    if(!recoveryEnvelope||recoveryEnvelope.accountId!==input.accountId) throw new VaultError('NOT_FOUND','Recovery envelope is unavailable for this Account/Vault generation.');
    const vmk=await openRecoveryVaultKeyEnvelope({secret:input.recoverySecret,envelope:recoveryEnvelope});
    try{
      const deviceEnvelope=await createDeviceVaultKeyEnvelope({
        accountId:input.accountId,vaultId:input.vaultId,deviceId:input.deviceId,keyGeneration:input.keyGeneration,
        publicKey:material.publicKey,publicKeyFingerprint:material.fingerprint,vmk,
      });
      const proof=await recoverySecretProof({
        secret:input.recoverySecret,accountId:input.accountId,vaultId:input.vaultId,keyGeneration:input.keyGeneration,
      });
      const readiness=await this.remote.recoverDevice({
        vaultId:input.vaultId,deviceId:input.deviceId,envelope:deviceEnvelope,recoveryProof:proof,
      });
      if(!readiness.deviceAuthorized) throw new VaultError('PERMISSION','Recovery Secret possession was not accepted.');
      await this.storeEnvelope(deviceEnvelope);
      return {context:new VaultCryptoContext(input.vaultId,input.keyGeneration,vmk),readiness};
    }finally{vmk.fill(0);}
  }
}
