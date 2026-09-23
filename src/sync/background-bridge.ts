import type { Vault } from '../domain/model.js';
import type { PublicBackendConfig } from '../services/runtime-config.js';
import type { SupabaseRestAuth, SupabaseStoredSession } from '../cloud/auth-rest.js';
import type { SyncEngine } from './engine.js';
import { BackgroundReplicationState, type BackgroundStatusRecord } from './background-state.js';

const TAG='vault-background-sync';
const PERIODIC_TAG='vault-periodic-sync';

interface SyncManagerLike { register(tag:string):Promise<void> }
interface PeriodicSyncManagerLike { register(tag:string,options:{minInterval:number}):Promise<void> }
type WorkerRegistration=ServiceWorkerRegistration & {
  sync?:SyncManagerLike;
  periodicSync?:PeriodicSyncManagerLike;
};

export interface BackgroundReplicationCapability {
  supported:boolean;
  periodicSupported:boolean;
  status:BackgroundStatusRecord|null;
}

function statusRecord(
  capability:BackgroundStatusRecord['capability'],
  previous:BackgroundStatusRecord|null,
  patch:Partial<BackgroundStatusRecord>={},
):BackgroundStatusRecord{
  return {
    id:'status',
    capability,
    lastAttemptAt:previous?.lastAttemptAt ?? null,
    lastSuccessAt:previous?.lastSuccessAt ?? null,
    lastError:previous?.lastError ?? null,
    stagedEvents:previous?.stagedEvents ?? 0,
    pushedOperations:previous?.pushedOperations ?? 0,
    updatedAt:new Date().toISOString(),
    ...patch,
  };
}

export class BackgroundReplicationBridge {
  constructor(
    private readonly state:BackgroundReplicationState,
    private readonly config:PublicBackendConfig,
    private readonly auth:SupabaseRestAuth,
    private readonly databaseName:string,
  ){}

  private async registration():Promise<WorkerRegistration|null>{
    if(typeof navigator==='undefined' || !('serviceWorker' in navigator)) return null;
    try {
      return await navigator.serviceWorker.getRegistration() as WorkerRegistration|null;
    } catch {
      return null;
    }
  }

  async mirrorSession(authUserId:string):Promise<boolean>{
    const session:SupabaseStoredSession|null=await this.auth.backgroundSession();
    if(!session){
      await this.state.clearRuntime();
      return false;
    }
    await this.state.putRuntime({
      id:'runtime',
      databaseName:this.databaseName,
      config:{...this.config},
      authUserId,
      session:{...session},
      updatedAt:new Date().toISOString(),
    });
    return true;
  }

  async clearSession():Promise<void>{
    await this.state.clearRuntime();
  }

  async capability():Promise<BackgroundReplicationCapability>{
    const registration=await this.registration();
    const supported=!!registration?.sync;
    const periodicSupported=!!registration?.periodicSync;
    const previous=await this.state.status();
    const capability:BackgroundStatusRecord['capability']=supported
      ? previous?.capability==='registered' ? 'registered' : 'available'
      : 'unsupported';
    if(!previous || previous.capability!==capability){
      await this.state.putStatus(statusRecord(capability,previous));
    }
    return {supported,periodicSupported,status:await this.state.status()};
  }

  async schedule():Promise<boolean>{
    const registration=await this.registration();
    const previous=await this.state.status();
    if(!registration?.sync){
      await this.state.putStatus(statusRecord('unsupported',previous));
      return false;
    }
    try{
      await registration.sync.register(TAG);
      await this.state.putStatus(statusRecord('registered',previous,{lastError:null}));
      return true;
    }catch(error){
      await this.state.putStatus(statusRecord('available',previous,{
        lastError:error instanceof Error ? error.message : 'Background Sync registration failed.',
      }));
      return false;
    }
  }

  async registerPeriodic():Promise<boolean>{
    const registration=await this.registration();
    if(!registration?.periodicSync) return false;
    try{
      await registration.periodicSync.register(PERIODIC_TAG,{minInterval:12*60*60*1000});
      return true;
    }catch{
      return false;
    }
  }

  async prepare(vault:Vault,authUserId:string,engine:SyncEngine):Promise<number>{
    if(!await this.mirrorSession(authUserId)) return 0;
    const pending=await engine.prepareBackground(vault,authUserId);
    if(pending>0) await this.schedule();
    return pending;
  }

  async runNow():Promise<boolean>{
    const registration=await this.registration();
    const worker=registration?.active;
    if(!worker) return false;
    return new Promise(resolve=>{
      const channel=new MessageChannel();
      const timeout=setTimeout(()=>resolve(false),15_000);
      channel.port1.onmessage=event=>{
        clearTimeout(timeout);
        resolve(event.data?.ok===true);
      };
      worker.postMessage({type:'RUN_BACKGROUND_SYNC'},[channel.port2]);
    });
  }
}
