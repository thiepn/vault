import { VaultError } from '../domain/errors.js';
import type { VaultId } from '../domain/model.js';
import type { PublicBackendConfig } from '../services/runtime-config.js';
import type { Cursor, SealedOperation } from './protocol.js';
import { sha256Hex } from '../storage/blob-store.js';
import { validatePushResult, validateRemotePage, type RemotePushResult, type RemoteReplicationPage } from './remote-types.js';
import { validateSyncBackendCapabilities, type SyncBackendCapabilities } from './capabilities.js';
import type { DeviceId, OperationId } from '../domain/model.js';
import type { CanonicalEntityId } from '../domain/canonical.js';
import type { RemoteBlobId, SealedOperationV2 } from './protocol-v2.js';
import {
  validateBootstrapDescriptorV2,
  validateBootstrapPageV2,
  validateEncryptedPushResultV2,
  validateEncryptedRemotePageV2,
  type BootstrapDescriptorV2,
  type BootstrapPageV2,
  type EncryptedPushResultV2,
  type EncryptedRemotePageV2,
} from './remote-v2.js';

type FetchLike=typeof fetch;

const TUS_VERSION='1.0.0';
const TUS_CHUNK_BYTES=6*1024*1024;
const TUS_THRESHOLD_BYTES=6*1024*1024;
const MAX_TUS_RECOVERY_ATTEMPTS=5;

async function body(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return null; }
}
function message(payload:unknown,fallback:string):string{
  if(payload && typeof payload==='object'){
    const r=payload as Record<string,unknown>;
    for(const key of ['message','details','hint','code']) if(typeof r[key]==='string' && r[key]) return r[key] as string;
  }
  return fallback;
}
function utf8Base64(value:string):string{
  const bytes=new TextEncoder().encode(value);
  let binary='';
  for(const byte of bytes)binary+=String.fromCharCode(byte);
  return btoa(binary);
}

function tusMetadata(values:Record<string,string>):string{
  return Object.entries(values)
    .map(([key,value])=>`${key} ${utf8Base64(value)}`)
    .join(',');
}

function directStorageBase(projectUrl:string):string{
  const url=new URL(projectUrl);
  if(url.hostname.endsWith('.supabase.co')){
    const projectRef=url.hostname.slice(0,-'.supabase.co'.length);
    if(projectRef)return `${url.protocol}//${projectRef}.storage.supabase.co`;
  }
  return url.origin;
}

function storagePath(userId:string,vaultId:VaultId,sha256:string):string{
  return [userId,vaultId,sha256].map(encodeURIComponent).join('/');
}

export interface EncryptedBlobDescriptorV2 {
  status:'upload'|'ready';
  bucket:'vault-e2ee-blobs';
  path:string;
  blobId:RemoteBlobId;
  keyGeneration:number;
  ciphertextSize:number;
}

function encryptedBlobPath(vaultId:VaultId,keyGeneration:number,blobId:RemoteBlobId):string{
  if(!Number.isSafeInteger(keyGeneration)||keyGeneration<1) throw new VaultError('PROTOCOL','Invalid encrypted blob key generation.');
  if(!/^[A-Za-z0-9_-]{43}$/u.test(blobId)) throw new VaultError('PROTOCOL','Invalid encrypted BlobId.');
  return [vaultId,String(keyGeneration),blobId].map(encodeURIComponent).join('/');
}

function validateEncryptedBlobDescriptor(
  value:unknown,
  expected:{vaultId:VaultId;blobId:RemoteBlobId;keyGeneration:number;ciphertextSize:number},
):EncryptedBlobDescriptorV2{
  if(!value||typeof value!=='object') throw new VaultError('PROTOCOL','Encrypted blob descriptor is invalid.');
  const row=value as Record<string,unknown>;
  const keys=Object.keys(row).sort().join(',');
  if(keys!==['blobId','bucket','ciphertextSize','keyGeneration','path','status'].sort().join(',')){
    throw new VaultError('PROTOCOL','Encrypted blob descriptor contains unsupported fields.');
  }
  const path=encryptedBlobPath(expected.vaultId,expected.keyGeneration,expected.blobId);
  if((row.status!=='upload'&&row.status!=='ready')
    ||row.bucket!=='vault-e2ee-blobs'
    ||row.path!==path
    ||row.blobId!==expected.blobId
    ||row.keyGeneration!==expected.keyGeneration
    ||row.ciphertextSize!==expected.ciphertextSize){
    throw new VaultError('PROTOCOL','Encrypted blob descriptor does not match the requested object.');
  }
  return {
    status:row.status,
    bucket:'vault-e2ee-blobs',
    path,
    blobId:expected.blobId,
    keyGeneration:expected.keyGeneration,
    ciphertextSize:expected.ciphertextSize,
  };
}

export class SupabaseSyncTransport {
  constructor(
    private readonly config: PublicBackendConfig,
    private readonly token:()=>Promise<string|null>,
    private readonly request:FetchLike=(input,init)=>fetch(input,init),
  ) {}

  private async headers(contentType='application/json'): Promise<HeadersInit> {
    const token=await this.token();
    if(!token) throw new VaultError('ACCOUNT_MISMATCH','Sign in before synchronizing.');
    return {
      apikey:this.config.publishableKey,
      Authorization:`Bearer ${token}`,
      ...(contentType ? {'Content-Type':contentType} : {}),
    };
  }

  private async rpc(name:string,payload:object):Promise<unknown>{
    const response=await this.request(`${this.config.url}/rest/v1/rpc/${name}`,{
      method:'POST',
      headers:await this.headers(),
      body:JSON.stringify(payload),
    });
    const parsed=await body(response);
    if(!response.ok){
      if(response.status===409){
        const raw=parsed && typeof parsed==='object' ? parsed as Record<string,unknown> : null;
        const rawMessage=typeof raw?.message==='string' ? raw.message : '';
        try { return JSON.parse(rawMessage); } catch { /* fall through */ }
      }
      throw new VaultError(response.status===401||response.status===403?'ACCOUNT_MISMATCH':'CONFIGURATION',message(parsed,'Cloud synchronization request failed.'));
    }
    return parsed;
  }

  /**
   * I1 negotiation endpoint. It intentionally reports Protocol v2 contract
   * availability separately from whether encrypted content ingestion is live.
   */
  async capabilities():Promise<SyncBackendCapabilities>{
    const result=await this.rpc('vault_sync_capabilities_v2',{});
    return validateSyncBackendCapabilities(result);
  }

  async upgradeV2(vaultId:VaultId,deviceId:DeviceId):Promise<{vaultId:VaultId;epoch:string;protocolVersion:2}>{
    const result=await this.rpc('vault_sync_upgrade_v2',{p_vault_id:vaultId,p_device_id:deviceId});
    if(!result || typeof result!=='object') throw new VaultError('PROTOCOL','Protocol v2 upgrade response is invalid.');
    const row=result as Record<string,unknown>;
    if(row.vaultId!==vaultId || typeof row.epoch!=='string' || row.protocolVersion!==2){
      throw new VaultError('PROTOCOL','Protocol v2 upgrade response does not match this Vault.');
    }
    return {vaultId,epoch:row.epoch,protocolVersion:2};
  }

  async pullV2(vaultId:VaultId,epoch:string,deviceId:DeviceId,after:string,limit=500):Promise<EncryptedRemotePageV2>{
    if(!Number.isInteger(limit)||limit<1||limit>1000) throw new VaultError('PROTOCOL','Invalid Protocol v2 page size.');
    const result=await this.rpc('vault_sync_pull_v2',{
      p_vault_id:vaultId,p_epoch:epoch,p_device_id:deviceId,p_after:after,p_limit:limit,
    });
    return validateEncryptedRemotePageV2(result,{vaultId,epoch,after});
  }

  async pushV2(operation:SealedOperationV2):Promise<EncryptedPushResultV2>{
    const result=await this.rpc('vault_sync_push_v2',{p_wire:operation.wire,p_sha256:operation.sha256});
    return validateEncryptedPushResultV2(result,{operationId:operation.operationId as OperationId,vaultId:operation.vaultId});
  }

  async ackV2(vaultId:VaultId,epoch:string,deviceId:DeviceId,through:string):Promise<void>{
    const result=await this.rpc('vault_sync_ack_v2',{
      p_vault_id:vaultId,p_epoch:epoch,p_device_id:deviceId,p_through:through,
    });
    if(!result || typeof result!=='object') throw new VaultError('PROTOCOL','Protocol v2 acknowledgement response is invalid.');
    const row=result as Record<string,unknown>;
    if(row.vaultId!==vaultId || row.epoch!==epoch || row.acknowledgedThrough!==through){
      throw new VaultError('PROTOCOL','Protocol v2 acknowledgement response does not match the durable local cursor.');
    }
  }

  async beginBootstrapV2(vaultId:VaultId,epoch:string,deviceId:DeviceId):Promise<BootstrapDescriptorV2>{
    const result=await this.rpc('vault_sync_begin_bootstrap_v2',{
      p_vault_id:vaultId,p_epoch:epoch,p_device_id:deviceId,
    });
    return validateBootstrapDescriptorV2(result,vaultId,epoch);
  }

  async bootstrapPageV2(
    vaultId:VaultId,
    epoch:string,
    deviceId:DeviceId,
    snapshotSequence:string,
    afterEntityId:CanonicalEntityId|null,
    limit=250,
  ):Promise<BootstrapPageV2>{
    if(!Number.isInteger(limit)||limit<1||limit>1000) throw new VaultError('PROTOCOL','Invalid Protocol v2 bootstrap page size.');
    const result=await this.rpc('vault_sync_bootstrap_page_v2',{
      p_vault_id:vaultId,
      p_epoch:epoch,
      p_device_id:deviceId,
      p_snapshot_sequence:snapshotSequence,
      p_after_entity_id:afterEntityId,
      p_limit:limit,
    });
    return validateBootstrapPageV2(result,{vaultId,epoch,snapshotSequence,afterEntityId});
  }

  async prepareBlobV2(
    vaultId:VaultId,
    deviceId:DeviceId,
    blobId:RemoteBlobId,
    keyGeneration:number,
    ciphertextSize:number,
  ):Promise<EncryptedBlobDescriptorV2>{
    if(!Number.isSafeInteger(ciphertextSize)||ciphertextSize<36||ciphertextSize>134217764){
      throw new VaultError('PROTOCOL','Invalid encrypted blob ciphertext size.');
    }
    const result=await this.rpc('vault_sync_prepare_blob_v2',{
      p_vault_id:vaultId,
      p_device_id:deviceId,
      p_blob_id:blobId,
      p_key_generation:keyGeneration,
      p_ciphertext_size:ciphertextSize,
    });
    return validateEncryptedBlobDescriptor(result,{vaultId,blobId,keyGeneration,ciphertextSize});
  }

  async commitBlobV2(
    vaultId:VaultId,
    deviceId:DeviceId,
    blobId:RemoteBlobId,
    keyGeneration:number,
    ciphertextSize:number,
  ):Promise<EncryptedBlobDescriptorV2>{
    const result=await this.rpc('vault_sync_commit_blob_v2',{
      p_vault_id:vaultId,
      p_device_id:deviceId,
      p_blob_id:blobId,
      p_key_generation:keyGeneration,
      p_ciphertext_size:ciphertextSize,
    });
    const descriptor=validateEncryptedBlobDescriptor(result,{vaultId,blobId,keyGeneration,ciphertextSize});
    if(descriptor.status!=='ready') throw new VaultError('PROTOCOL','Encrypted blob commit did not reach READY state.');
    return descriptor;
  }

  async uploadEncryptedBlobV2(descriptor:EncryptedBlobDescriptorV2,bytes:Uint8Array):Promise<'uploaded'|'exists'>{
    if(!(bytes instanceof Uint8Array)||bytes.byteLength!==descriptor.ciphertextSize){
      throw new VaultError('PROTOCOL','Encrypted blob upload bytes do not match the prepared descriptor.');
    }
    if(bytes.byteLength>TUS_THRESHOLD_BYTES){
      return this.uploadEncryptedBlobTusV2(descriptor,bytes);
    }

    const response=await this.request(
      `${this.config.url}/storage/v1/object/${descriptor.bucket}/${descriptor.path}`,
      {
        method:'POST',
        headers:{
          ...await this.headers('application/octet-stream'),
          'x-upsert':'false',
          'cache-control':'no-store',
        },
        body:new Blob([bytes],{type:'application/octet-stream'}),
      },
    );
    if(response.ok) return 'uploaded';
    if(response.status===400||response.status===409) return 'exists';
    const parsed=await body(response);
    throw new VaultError(
      response.status===401||response.status===403?'ACCOUNT_MISMATCH':'CONFIGURATION',
      message(parsed,'Encrypted blob upload failed.'),
    );
  }

  private async uploadEncryptedBlobTusV2(
    descriptor:EncryptedBlobDescriptorV2,
    bytes:Uint8Array,
  ):Promise<'uploaded'|'exists'>{
    const token=await this.token();
    if(!token) throw new VaultError('ACCOUNT_MISMATCH','Sign in before synchronizing.');
    const authHeaders={
      apikey:this.config.publishableKey,
      Authorization:`Bearer ${token}`,
      'Tus-Resumable':TUS_VERSION,
    };
    const endpoint=`${directStorageBase(this.config.url)}/storage/v1/upload/resumable`;
    const creation=await this.request(endpoint,{
      method:'POST',
      headers:{
        ...authHeaders,
        'Upload-Length':String(bytes.byteLength),
        'Upload-Metadata':tusMetadata({
          bucketName:descriptor.bucket,
          objectName:descriptor.path,
          contentType:'application/octet-stream',
          cacheControl:'0',
        }),
        'x-upsert':'false',
      },
    });
    if(creation.status===400||creation.status===409)return 'exists';
    if(!creation.ok){
      const parsed=await body(creation);
      throw new VaultError(
        creation.status===401||creation.status===403?'ACCOUNT_MISMATCH':'CONFIGURATION',
        message(parsed,'Encrypted resumable blob upload could not be created.'),
      );
    }

    const location=creation.headers.get('location');
    if(!location) throw new VaultError('PROTOCOL','Encrypted resumable upload did not return a Location URL.');
    const uploadUrl=new URL(location,endpoint).toString();
    let offset=0;
    let recoveries=0;

    while(offset<bytes.byteLength){
      const end=Math.min(offset+TUS_CHUNK_BYTES,bytes.byteLength);
      const chunk=bytes.slice(offset,end);
      let response:Response;
      try{
        response=await this.request(uploadUrl,{
          method:'PATCH',
          headers:{
            ...authHeaders,
            'Upload-Offset':String(offset),
            'Content-Type':'application/offset+octet-stream',
          },
          body:chunk,
        });
      }catch(error){
        if(recoveries>=MAX_TUS_RECOVERY_ATTEMPTS)throw error;
        recoveries++;
        offset=await this.resumeTusOffset(uploadUrl,authHeaders,bytes.byteLength);
        if(offset===bytes.byteLength)return 'exists';
        continue;
      }

      if(response.status===409){
        try{
          offset=await this.resumeTusOffset(uploadUrl,authHeaders,bytes.byteLength);
          recoveries++;
          if(offset===bytes.byteLength||recoveries>MAX_TUS_RECOVERY_ATTEMPTS)return 'exists';
          continue;
        }catch{
          // A competing immutable upload may have completed this object path.
          // The caller authenticates/decrypts the existing object before reuse.
          return 'exists';
        }
      }
      if(!response.ok){
        const parsed=await body(response);
        throw new VaultError(
          response.status===401||response.status===403?'ACCOUNT_MISMATCH':'CONFIGURATION',
          message(parsed,'Encrypted resumable blob chunk upload failed.'),
        );
      }

      const nextRaw=response.headers.get('upload-offset');
      const next=nextRaw===null?end:Number(nextRaw);
      if(!Number.isSafeInteger(next)||next<=offset||next>end||next>bytes.byteLength){
        throw new VaultError('PROTOCOL','Encrypted resumable upload returned an invalid offset.');
      }
      offset=next;
      recoveries=0;
    }
    return 'uploaded';
  }

  private async resumeTusOffset(
    uploadUrl:string,
    authHeaders:Record<string,string>,
    totalBytes:number,
  ):Promise<number>{
    const response=await this.request(uploadUrl,{
      method:'HEAD',
      headers:authHeaders,
    });
    if(!response.ok){
      throw new VaultError(
        response.status===401||response.status===403?'ACCOUNT_MISMATCH':'CONFIGURATION',
        'Encrypted resumable upload could not recover its server offset.',
      );
    }
    const raw=response.headers.get('upload-offset');
    const offset=raw===null?Number.NaN:Number(raw);
    if(!Number.isSafeInteger(offset)||offset<0||offset>totalBytes){
      throw new VaultError('PROTOCOL','Encrypted resumable upload recovery returned an invalid offset.');
    }
    return offset;
  }

  async downloadEncryptedBlobV2(
    vaultId:VaultId,
    blobId:RemoteBlobId,
    keyGeneration:number,
  ):Promise<Uint8Array>{
    const path=encryptedBlobPath(vaultId,keyGeneration,blobId);
    const response=await this.request(
      `${this.config.url}/storage/v1/object/vault-e2ee-blobs/${path}`,
      {headers:await this.headers('')},
    );
    if(!response.ok){
      const parsed=await body(response);
      throw new VaultError(
        response.status===401||response.status===403?'ACCOUNT_MISMATCH':'CONFIGURATION',
        message(parsed,'Encrypted blob download failed.'),
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async pull(vaultId:VaultId,epoch:string,after:Cursor,limit=500):Promise<RemoteReplicationPage>{
    if(!Number.isInteger(limit)||limit<1||limit>1000) throw new VaultError('PROTOCOL','Invalid remote page size.');
    const result=await this.rpc('vault_sync_pull',{p_vault_id:vaultId,p_epoch:epoch,p_after:after,p_limit:limit});
    return validateRemotePage(result,{vaultId,epoch,after});
  }

  async push(operation:SealedOperation):Promise<RemotePushResult>{
    const result=await this.rpc('vault_sync_push',{p_wire:JSON.parse(operation.wire),p_sha256:operation.sha256});
    return validatePushResult(result,{operationId:operation.id,vaultId:operation.vaultId});
  }

  async uploadBlob(userId:string,vaultId:VaultId,sha256:string,mimeType:string,bytes:Uint8Array):Promise<void>{
    if(!/^[0-9a-f]{64}$/u.test(sha256)) throw new VaultError('PROTOCOL','Invalid attachment hash.');
    const path=storagePath(userId,vaultId,sha256);
    const response=await this.request(`${this.config.url}/storage/v1/object/vault-sync/${path}`,{
      method:'POST',
      headers:await this.headers(mimeType||'application/octet-stream'),
      body:new Blob([bytes],{type:mimeType||'application/octet-stream'}),
    });
    if(response.ok) return;
    if(response.status===400||response.status===409){
      const existing=await this.downloadBlob(userId,vaultId,sha256);
      if(existing.byteLength===bytes.byteLength && await sha256Hex(existing)===sha256) return;
    }
    const parsed=await body(response);
    throw new VaultError(response.status===401||response.status===403?'ACCOUNT_MISMATCH':'CONFIGURATION',message(parsed,'Attachment upload failed.'));
  }

  async downloadBlob(userId:string,vaultId:VaultId,sha256:string):Promise<Uint8Array>{
    if(!/^[0-9a-f]{64}$/u.test(sha256)) throw new VaultError('PROTOCOL','Invalid attachment hash.');
    const path=storagePath(userId,vaultId,sha256);
    const response=await this.request(`${this.config.url}/storage/v1/object/vault-sync/${path}`,{
      headers:await this.headers(''),
    });
    if(!response.ok){
      const parsed=await body(response);
      throw new VaultError(response.status===401||response.status===403?'ACCOUNT_MISMATCH':'CONFIGURATION',message(parsed,'Attachment download failed.'));
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}
