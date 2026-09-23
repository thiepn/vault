import { VaultError } from '../domain/errors.js';
import type { AccountId, DeviceId, VaultId } from '../domain/model.js';
import type { DeviceVaultKeyEnvelopeV1 } from './device-keys.js';

export interface StoredDeviceKey {
  id:string;
  accountId:AccountId;
  deviceId:DeviceId;
  algorithm:'RSA-OAEP-3072-SHA256';
  publicSpki:string;
  fingerprint:string;
  privateKey:CryptoKey;
  createdAt:string;
}
export interface StoredDeviceEnvelope extends DeviceVaultKeyEnvelopeV1 {
  id:string;
}

export interface DeviceKeyStore {
  getDeviceKey(accountId:AccountId,deviceId:DeviceId):Promise<StoredDeviceKey|null>;
  putDeviceKey(record:StoredDeviceKey):Promise<void>;
  getEnvelope(accountId:AccountId,vaultId:VaultId,deviceId:DeviceId,keyGeneration:number):Promise<StoredDeviceEnvelope|null>;
  putEnvelope(envelope:StoredDeviceEnvelope):Promise<void>;
  listEnvelopes(accountId:AccountId,vaultId:VaultId,deviceId:DeviceId):Promise<StoredDeviceEnvelope[]>;
}

export function deviceKeyRecordId(accountId:AccountId,deviceId:DeviceId):string{
  return accountId+'/'+deviceId;
}
export function deviceEnvelopeRecordId(accountId:AccountId,vaultId:VaultId,deviceId:DeviceId,keyGeneration:number):string{
  return accountId+'/'+vaultId+'/'+deviceId+'/'+keyGeneration;
}

export function keyringDatabaseName(projectRef:string):string{
  if(!/^[a-z0-9-]+$/iu.test(projectRef)) throw new VaultError('ACCOUNT_MISMATCH','Invalid keyring project identity.');
  return 'vault:keyring:'+projectRef.toLowerCase();
}

export async function openKeyringDatabase(projectRef:string):Promise<IDBDatabase>{
  if(typeof indexedDB==='undefined') throw new VaultError('UNSUPPORTED','IndexedDB is required to persist non-extractable Device keys.');
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(keyringDatabaseName(projectRef),1);
    request.onerror=()=>reject(request.error ?? new VaultError('STORAGE','Vault keyring could not be opened.'));
    request.onblocked=()=>reject(new VaultError('STORAGE','Another tab is blocking the Vault keyring upgrade.'));
    request.onupgradeneeded=()=>{
      const db=request.result;
      if(!db.objectStoreNames.contains('deviceKeys')){
        const keys=db.createObjectStore('deviceKeys',{keyPath:'id'});
        keys.createIndex('accountId','accountId');
      }
      if(!db.objectStoreNames.contains('deviceEnvelopes')){
        const envelopes=db.createObjectStore('deviceEnvelopes',{keyPath:'id'});
        envelopes.createIndex('accountVaultDevice',['accountId','vaultId','deviceId']);
      }
    };
    request.onsuccess=()=>{
      const db=request.result;
      db.onversionchange=()=>db.close();
      resolve(db);
    };
  });
}

function requestResult<T>(request:IDBRequest<T>):Promise<T>{
  return new Promise((resolve,reject)=>{
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error ?? new VaultError('STORAGE','Vault keyring request failed.'));
  });
}
function transactionDone(tx:IDBTransaction):Promise<void>{
  return new Promise((resolve,reject)=>{
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(tx.error ?? new VaultError('STORAGE','Vault keyring transaction failed.'));
    tx.onabort=()=>reject(tx.error ?? new VaultError('STORAGE','Vault keyring transaction was aborted.'));
  });
}

export class IndexedDbDeviceKeyStore implements DeviceKeyStore {
  constructor(private readonly database:IDBDatabase){}

  async getDeviceKey(accountId:AccountId,deviceId:DeviceId):Promise<StoredDeviceKey|null>{
    const tx=this.database.transaction('deviceKeys','readonly');
    const value=await requestResult(tx.objectStore('deviceKeys').get(deviceKeyRecordId(accountId,deviceId)) as IDBRequest<StoredDeviceKey|undefined>);
    await transactionDone(tx);
    return value ?? null;
  }

  async putDeviceKey(record:StoredDeviceKey):Promise<void>{
    const existing=await this.getDeviceKey(record.accountId,record.deviceId);
    if(existing){
      if(existing.fingerprint!==record.fingerprint||existing.publicSpki!==record.publicSpki){
        throw new VaultError('ACCOUNT_MISMATCH','Silent Device public-key replacement is forbidden.');
      }
      return;
    }
    if(record.privateKey.extractable||record.privateKey.type!=='private') throw new VaultError('PROTOCOL','Persisted Device private key must be non-extractable.');
    const tx=this.database.transaction('deviceKeys','readwrite');
    tx.objectStore('deviceKeys').add(record);
    await transactionDone(tx);
  }

  async getEnvelope(accountId:AccountId,vaultId:VaultId,deviceId:DeviceId,keyGeneration:number):Promise<StoredDeviceEnvelope|null>{
    const tx=this.database.transaction('deviceEnvelopes','readonly');
    const value=await requestResult(tx.objectStore('deviceEnvelopes').get(deviceEnvelopeRecordId(accountId,vaultId,deviceId,keyGeneration)) as IDBRequest<StoredDeviceEnvelope|undefined>);
    await transactionDone(tx);
    return value ?? null;
  }

  async putEnvelope(envelope:StoredDeviceEnvelope):Promise<void>{
    const existing=await this.getEnvelope(envelope.accountId,envelope.vaultId,envelope.deviceId,envelope.keyGeneration);
    if(existing){
      if(existing.ciphertext!==envelope.ciphertext||existing.publicKeyFingerprint!==envelope.publicKeyFingerprint){
        throw new VaultError('CORRUPT','A Device Vault-key envelope identity was reused with different bytes.');
      }
      return;
    }
    const tx=this.database.transaction('deviceEnvelopes','readwrite');
    tx.objectStore('deviceEnvelopes').add(envelope);
    await transactionDone(tx);
  }

  async listEnvelopes(accountId:AccountId,vaultId:VaultId,deviceId:DeviceId):Promise<StoredDeviceEnvelope[]>{
    const tx=this.database.transaction('deviceEnvelopes','readonly');
    const index=tx.objectStore('deviceEnvelopes').index('accountVaultDevice');
    const rows=await requestResult(index.getAll(IDBKeyRange.only([accountId,vaultId,deviceId])) as IDBRequest<StoredDeviceEnvelope[]>);
    await transactionDone(tx);
    return rows.sort((a,b)=>a.keyGeneration-b.keyGeneration);
  }
}

export class MemoryDeviceKeyStore implements DeviceKeyStore {
  private readonly keys=new Map<string,StoredDeviceKey>();
  private readonly envelopes=new Map<string,StoredDeviceEnvelope>();

  async getDeviceKey(accountId:AccountId,deviceId:DeviceId):Promise<StoredDeviceKey|null>{
    return this.keys.get(deviceKeyRecordId(accountId,deviceId)) ?? null;
  }
  async putDeviceKey(record:StoredDeviceKey):Promise<void>{
    const id=deviceKeyRecordId(record.accountId,record.deviceId);
    const existing=this.keys.get(id);
    if(existing && (existing.fingerprint!==record.fingerprint||existing.publicSpki!==record.publicSpki)){
      throw new VaultError('ACCOUNT_MISMATCH','Silent Device public-key replacement is forbidden.');
    }
    if(!existing)this.keys.set(id,record);
  }
  async getEnvelope(accountId:AccountId,vaultId:VaultId,deviceId:DeviceId,keyGeneration:number):Promise<StoredDeviceEnvelope|null>{
    return this.envelopes.get(deviceEnvelopeRecordId(accountId,vaultId,deviceId,keyGeneration)) ?? null;
  }
  async putEnvelope(envelope:StoredDeviceEnvelope):Promise<void>{
    const existing=this.envelopes.get(envelope.id);
    if(existing && (existing.ciphertext!==envelope.ciphertext||existing.publicKeyFingerprint!==envelope.publicKeyFingerprint)){
      throw new VaultError('CORRUPT','A Device Vault-key envelope identity was reused with different bytes.');
    }
    if(!existing)this.envelopes.set(envelope.id,envelope);
  }
  async listEnvelopes(accountId:AccountId,vaultId:VaultId,deviceId:DeviceId):Promise<StoredDeviceEnvelope[]>{
    return [...this.envelopes.values()]
      .filter(row=>row.accountId===accountId&&row.vaultId===vaultId&&row.deviceId===deviceId)
      .sort((a,b)=>a.keyGeneration-b.keyGeneration);
  }
}
