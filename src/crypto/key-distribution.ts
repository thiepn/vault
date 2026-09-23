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
  type DeviceVaultKeyEnvelopeV1,
} from './device-keys.js';
import {
  createRecoveryVaultKeyEnvelope,
  decodeRecoverySecret,
  encodeRecoverySecret,
  generateRecoverySecret,
  openRecoveryVaultKeyEnvelope,
  recoverySecretFingerprint,
  recoverySecretProof,
  type RecoveryVaultKeyEnvelopeV1,
} from './recovery.js';
import {
  deviceEnvelopeRecordId,
  deviceKeyRecordId,
  type DeviceKeyStore,
  type StoredDeviceEnvelope,
  type StoredDeviceKey,
} from './keyring.js';
import { generateVaultMasterKey } from './keys.js';
import type {
  DeviceAccessRequest,
  KeyRegistryPort,
  RecoveryEnvelopeProof,
  VaultKeyReadiness,
} from '../cloud/key-registry.js';

export interface GeneratedRecoverySecret {
  secret:Uint8Array;
  code:string;
  fingerprint:string;
}

function ensureGeneration(value:number,label='Key generation'):number{
  if(!Number.isSafeInteger(value)||value<1) throw new VaultError('PROTOCOL',label+' must be a positive safe integer.');
  return value;
}

function exactGenerationSet(envelopes:readonly {keyGeneration:number}[]):number[]{
  const generations=envelopes.map(row=>ensureGeneration(row.keyGeneration)).sort((a,b)=>a-b);
  for(let index=1;index<generations.length;index+=1){
    if(generations[index]===generations[index-1]) throw new VaultError('PROTOCOL','Duplicate Vault key generation.');
  }
  return generations;
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

  private assertEnvelopeSet(input:{
    accountId:AccountId;
    vaultId:VaultId;
    deviceId:DeviceId;
    fingerprint:string;
    envelopes:readonly DeviceVaultKeyEnvelopeV1[];
  }):number[]{
    if(!input.envelopes.length) throw new VaultError('PROTOCOL','At least one Device Vault-key envelope is required.');
    for(const envelope of input.envelopes){
      if(envelope.accountId!==input.accountId
        ||envelope.vaultId!==input.vaultId
        ||envelope.deviceId!==input.deviceId
        ||envelope.publicKeyFingerprint!==input.fingerprint){
        throw new VaultError('ACCOUNT_MISMATCH','Device Vault-key envelope set does not match its target identity.');
      }
    }
    return exactGenerationSet(input.envelopes);
  }

  async initializeVault(input:{
    accountId:AccountId;
    vaultId:VaultId;
    deviceId:DeviceId;
    recoverySecret:Uint8Array;
    keyGeneration?:number;
  }):Promise<{context:VaultCryptoContext;readiness:VaultKeyReadiness}>{
    const keyGeneration=ensureGeneration(input.keyGeneration ?? 1);
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
      if(!readiness.ready||readiness.keyGeneration!==keyGeneration){
        throw new VaultError('CONFIGURATION','Encrypted Vault is not ready: Device and Recovery envelopes must be durable at the active generation.');
      }
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
    this.assertEnvelopeSet({
      accountId:input.accountId,vaultId:input.vaultId,deviceId:input.deviceId,
      fingerprint:device.fingerprint,envelopes,
    });
    for(const envelope of envelopes) await this.storeEnvelope(envelope);
    return envelopes.length;
  }

  async requestAccess(input:{accountId:AccountId;vaultId:VaultId;deviceId:DeviceId}):Promise<DeviceAccessRequest>{
    const device=await this.ensureDeviceKey(input.accountId,input.deviceId);
    return this.remote.requestAccess(input.vaultId,input.deviceId,device.fingerprint);
  }

  /**
   * Trusted-device approval deliberately wraps every retained VMK generation.
   * A newly authorized Device can therefore decrypt old unchanged entity heads
   * and retained history after future VMK rotations.
   */
  async approveAccessRequest(input:{
    accountId:AccountId;
    approverDeviceId:DeviceId;
    request:DeviceAccessRequest;
  }):Promise<void>{
    if(input.request.accountId!==input.accountId) throw new VaultError('ACCOUNT_MISMATCH','Access request belongs to another Account.');
    const approver=await this.local.getDeviceKey(input.accountId,input.approverDeviceId);
    if(!approver) throw new VaultError('NOT_FOUND','Approving Device private key is unavailable.');
    await this.refreshDeviceEnvelopes({accountId:input.accountId,vaultId:input.request.vaultId,deviceId:input.approverDeviceId});
    const localEnvelopes=await this.local.listEnvelopes(input.accountId,input.request.vaultId,input.approverDeviceId);
    if(!localEnvelopes.length) throw new VaultError('NOT_FOUND','Approving Device holds no Vault-key generations.');
    const readiness=await this.remote.readiness(input.request.vaultId,input.approverDeviceId);
    if(!readiness.ready||readiness.keyGeneration===null) throw new VaultError('PERMISSION','Approving Device is not ready for this encrypted Vault.');
    if(!localEnvelopes.some(row=>row.keyGeneration===readiness.keyGeneration)){
      throw new VaultError('NOT_FOUND','Approving Device is missing the active Vault-key generation.');
    }

    const targetPublicKey=await importDevicePublicKey({
      algorithm:input.request.algorithm,
      publicSpki:input.request.publicSpki,
      fingerprint:input.request.publicKeyFingerprint,
    });
    const targetEnvelopes:DeviceVaultKeyEnvelopeV1[]=[];
    let expectedConfirmation:string|null=null;

    for(const localEnvelope of localEnvelopes){
      const vmk=await openDeviceVaultKeyEnvelope({envelope:localEnvelope,privateKey:approver.privateKey});
      try{
        targetEnvelopes.push(await createDeviceVaultKeyEnvelope({
          accountId:input.accountId,vaultId:input.request.vaultId,deviceId:input.request.deviceId,
          keyGeneration:localEnvelope.keyGeneration,publicKey:targetPublicKey,
          publicKeyFingerprint:input.request.publicKeyFingerprint,vmk,
        }));
        if(localEnvelope.keyGeneration===readiness.keyGeneration){
          expectedConfirmation=await deviceVmkConfirmation({
            vmk,accountId:input.accountId,vaultId:input.request.vaultId,deviceId:input.request.deviceId,
            keyGeneration:localEnvelope.keyGeneration,challenge:input.request.challenge,
          });
        }
      }finally{vmk.fill(0);}
    }

    if(!expectedConfirmation) throw new VaultError('NOT_FOUND','Active Vault-key generation could not be confirmed.');
    await this.remote.approveAccessRequest({
      requestId:input.request.requestId,
      approverDeviceId:input.approverDeviceId,
      activeGeneration:readiness.keyGeneration,
      envelopes:targetEnvelopes,
      expectedConfirmation,
    });
  }

  async completePendingAccess(input:{
    accountId:AccountId;
    requestId:string;
    deviceId:DeviceId;
  }):Promise<{context:VaultCryptoContext;readiness:VaultKeyReadiness}>{
    const device=await this.ensureDeviceKey(input.accountId,input.deviceId);
    const pending=await this.remote.pendingAccess(input.requestId,input.deviceId);
    const first=pending.envelopes[0];
    if(!first) throw new VaultError('PROTOCOL','Pending Device access contains no Vault-key envelopes.');
    const generations=this.assertEnvelopeSet({
      accountId:input.accountId,vaultId:first.vaultId,deviceId:input.deviceId,
      fingerprint:device.fingerprint,envelopes:pending.envelopes,
    });
    if(!generations.includes(pending.activeGeneration)) throw new VaultError('PROTOCOL','Pending Device access does not contain the active key generation.');

    const opened=new Map<number,Uint8Array>();
    try{
      for(const envelope of pending.envelopes){
        opened.set(envelope.keyGeneration,await openDeviceVaultKeyEnvelope({envelope,privateKey:device.privateKey}));
      }
      const active=opened.get(pending.activeGeneration);
      if(!active) throw new VaultError('CORRUPT','Active Vault-key generation could not be opened.');
      const confirmation=await deviceVmkConfirmation({
        vmk:active,accountId:input.accountId,vaultId:first.vaultId,deviceId:input.deviceId,
        keyGeneration:pending.activeGeneration,challenge:pending.challenge,
      });
      const readiness=await this.remote.confirmAccess(input.requestId,input.deviceId,confirmation);
      if(!readiness.deviceAuthorized||!readiness.ready||readiness.keyGeneration!==pending.activeGeneration){
        throw new VaultError('PERMISSION','Device key possession was not confirmed.');
      }
      for(const envelope of pending.envelopes) await this.storeEnvelope(envelope);
      return {
        context:new VaultCryptoContext(first.vaultId,pending.activeGeneration,active),
        readiness,
      };
    }finally{
      for(const key of opened.values()) key.fill(0);
    }
  }

  /**
   * Recovery restores all retained VMK generations before the server authorizes
   * the replacement Device. No old Device private key is required.
   */
  async recoverDevice(input:{
    accountId:AccountId;
    vaultId:VaultId;
    deviceId:DeviceId;
    recoverySecret:Uint8Array;
  }):Promise<{context:VaultCryptoContext;readiness:VaultKeyReadiness}>{
    const device=await this.ensureDeviceKey(input.accountId,input.deviceId);
    const material=await this.publicMaterial(device);
    const recoveryEnvelopes=await this.remote.recoveryEnvelopes(input.vaultId);
    if(!recoveryEnvelopes.length) throw new VaultError('NOT_FOUND','Recovery envelopes are unavailable for this Vault.');
    for(const envelope of recoveryEnvelopes){
      if(envelope.accountId!==input.accountId||envelope.vaultId!==input.vaultId){
        throw new VaultError('ACCOUNT_MISMATCH','Recovery envelope belongs to another Account/Vault.');
      }
    }
    const generations=exactGenerationSet(recoveryEnvelopes);
    const activeGeneration=generations.at(-1);
    if(activeGeneration===undefined) throw new VaultError('PROTOCOL','Recovery envelope generation set is empty.');

    const opened=new Map<number,Uint8Array>();
    const deviceEnvelopes:DeviceVaultKeyEnvelopeV1[]=[];
    const proofs:{keyGeneration:number;recoveryProof:string}[]=[];
    try{
      for(const recoveryEnvelope of recoveryEnvelopes){
        const generation=recoveryEnvelope.keyGeneration;
        const vmk=await openRecoveryVaultKeyEnvelope({secret:input.recoverySecret,envelope:recoveryEnvelope});
        opened.set(generation,vmk);
        deviceEnvelopes.push(await createDeviceVaultKeyEnvelope({
          accountId:input.accountId,vaultId:input.vaultId,deviceId:input.deviceId,keyGeneration:generation,
          publicKey:material.publicKey,publicKeyFingerprint:material.fingerprint,vmk,
        }));
        proofs.push({
          keyGeneration:generation,
          recoveryProof:await recoverySecretProof({
            secret:input.recoverySecret,accountId:input.accountId,vaultId:input.vaultId,keyGeneration:generation,
          }),
        });
      }
      const readiness=await this.remote.recoverDevice({
        vaultId:input.vaultId,
        deviceId:input.deviceId,
        activeGeneration,
        envelopes:deviceEnvelopes,
        recoveryProofs:proofs,
      });
      if(!readiness.deviceAuthorized||!readiness.ready||readiness.keyGeneration!==activeGeneration){
        throw new VaultError('PERMISSION','Recovery Secret possession was not accepted.');
      }
      for(const envelope of deviceEnvelopes) await this.storeEnvelope(envelope);
      const active=opened.get(activeGeneration);
      if(!active) throw new VaultError('CORRUPT','Recovered active Vault-key generation is missing.');
      return {context:new VaultCryptoContext(input.vaultId,activeGeneration,active),readiness};
    }finally{
      for(const key of opened.values()) key.fill(0);
    }
  }

  /**
   * VMK rotation creates one new random generation and atomically distributes
   * it to every currently authorized, non-revoked Device. Revoked Devices are
   * deliberately absent. Existing generations remain retained for old content.
   */
  async rotateVaultMasterKey(input:{
    accountId:AccountId;
    vaultId:VaultId;
    actorDeviceId:DeviceId;
    recoverySecret:Uint8Array;
  }):Promise<{context:VaultCryptoContext;readiness:VaultKeyReadiness}>{
    const readiness=await this.remote.readiness(input.vaultId,input.actorDeviceId);
    if(!readiness.ready||readiness.keyGeneration===null) throw new VaultError('PERMISSION','Current Device is not authorized for VMK rotation.');
    const fromGeneration=readiness.keyGeneration;
    const toGeneration=fromGeneration+1;
    if(!Number.isSafeInteger(toGeneration)) throw new VaultError('PROTOCOL','Vault key generation overflow.');

    const targets=await this.remote.authorizedDevices(input.vaultId,input.actorDeviceId);
    if(!targets.length) throw new VaultError('PROTOCOL','No authorized Devices are available for VMK rotation.');
    const vmk=generateVaultMasterKey();
    try{
      const deviceEnvelopes:DeviceVaultKeyEnvelopeV1[]=[];
      for(const target of targets){
        if(target.accountId!==input.accountId) throw new VaultError('ACCOUNT_MISMATCH','Cross-Account E2EE Device rotation is not enabled.');
        const publicKey=await importDevicePublicKey(target);
        deviceEnvelopes.push(await createDeviceVaultKeyEnvelope({
          accountId:input.accountId,vaultId:input.vaultId,deviceId:target.deviceId,keyGeneration:toGeneration,
          publicKey,publicKeyFingerprint:target.fingerprint,vmk,
        }));
      }
      const recoveryEnvelope=await createRecoveryVaultKeyEnvelope({
        secret:input.recoverySecret,accountId:input.accountId,vaultId:input.vaultId,keyGeneration:toGeneration,vmk,
      });
      const recoveryProof=await recoverySecretProof({
        secret:input.recoverySecret,accountId:input.accountId,vaultId:input.vaultId,keyGeneration:toGeneration,
      });
      const next=await this.remote.rotateVaultKey({
        vaultId:input.vaultId,
        actorDeviceId:input.actorDeviceId,
        fromGeneration,
        toGeneration,
        deviceEnvelopes,
        recovery:{envelope:recoveryEnvelope,recoveryProof},
      });
      if(!next.ready||next.keyGeneration!==toGeneration) throw new VaultError('CONFIGURATION','VMK rotation did not activate the new generation.');
      const own=deviceEnvelopes.find(row=>row.deviceId===input.actorDeviceId);
      if(!own) throw new VaultError('PROTOCOL','VMK rotation omitted the current Device.');
      await this.storeEnvelope(own);
      return {context:new VaultCryptoContext(input.vaultId,toGeneration,vmk),readiness:next};
    }finally{vmk.fill(0);}
  }

  /**
   * Recovery Secret rotation re-wraps every retained VMK generation in one
   * server transaction. Canonical content is not re-encrypted.
   */
  async rotateRecoverySecret(input:{
    accountId:AccountId;
    vaultId:VaultId;
    actorDeviceId:DeviceId;
  }):Promise<GeneratedRecoverySecret>{
    const actor=await this.local.getDeviceKey(input.accountId,input.actorDeviceId);
    if(!actor) throw new VaultError('NOT_FOUND','Current Device private key is unavailable.');
    await this.refreshDeviceEnvelopes({accountId:input.accountId,vaultId:input.vaultId,deviceId:input.actorDeviceId});
    const deviceEnvelopes=await this.local.listEnvelopes(input.accountId,input.vaultId,input.actorDeviceId);
    if(!deviceEnvelopes.length) throw new VaultError('NOT_FOUND','Current Device holds no Vault-key generations.');
    const generated=await this.generateRecoverySecret();
    const replacements:RecoveryEnvelopeProof[]=[];
    try{
      for(const deviceEnvelope of deviceEnvelopes){
        const vmk=await openDeviceVaultKeyEnvelope({envelope:deviceEnvelope,privateKey:actor.privateKey});
        try{
          const envelope:RecoveryVaultKeyEnvelopeV1=await createRecoveryVaultKeyEnvelope({
            secret:generated.secret,accountId:input.accountId,vaultId:input.vaultId,
            keyGeneration:deviceEnvelope.keyGeneration,vmk,
          });
          replacements.push({
            envelope,
            recoveryProof:await recoverySecretProof({
              secret:generated.secret,accountId:input.accountId,vaultId:input.vaultId,
              keyGeneration:deviceEnvelope.keyGeneration,
            }),
          });
        }finally{vmk.fill(0);}
      }
      await this.remote.rotateRecovery({
        vaultId:input.vaultId,
        actorDeviceId:input.actorDeviceId,
        replacements,
      });
      return generated;
    }catch(error){
      generated.secret.fill(0);
      throw error;
    }
  }
}
