import { VaultError } from '../domain/errors.js';
import type { VaultId } from '../domain/model.js';
import type { PublicBackendConfig } from '../services/runtime-config.js';
import type { Cursor, SealedOperation } from './protocol.js';
import { sha256Hex } from '../storage/blob-store.js';
import { validatePushResult, validateRemotePage, type RemotePushResult, type RemoteReplicationPage } from './remote-types.js';

type FetchLike=typeof fetch;

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
function storagePath(userId:string,vaultId:VaultId,sha256:string):string{
  return [userId,vaultId,sha256].map(encodeURIComponent).join('/');
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
