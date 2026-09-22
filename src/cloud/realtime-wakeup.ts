import { VaultError } from '../domain/errors.js';
import type { PublicBackendConfig } from '../services/runtime-config.js';

export type RealtimeWakeStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'retrying'
  | 'unauthenticated'
  | 'stopped';

export interface RealtimeWakeEvent {
  vaultId: string;
  sequence: string;
  operationId: string | null;
  entryId: string | null;
  revision: number | null;
  deviceId: string | null;
}

export interface RealtimeWakeCallbacks {
  onWake?: (event: RealtimeWakeEvent) => void;
  onStatus?: (status: RealtimeWakeStatus) => void;
}

type SocketFactory = (url: string) => WebSocket;

interface DesiredSubscription {
  vaultId: string;
  epoch: string;
  topic: string;
  wireTopic: string;
}

const UUID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CURSOR_PATTERN=/^(0|[1-9][0-9]*)$/u;
const RECONNECT_DELAYS=[1_000,2_000,5_000,10_000] as const;

function requireUuid(value:string,label:string):string{
  if(!UUID_PATTERN.test(value)) throw new VaultError('PROTOCOL',`Invalid realtime ${label}.`);
  return value.toLowerCase();
}

export function vaultRealtimeTopic(vaultId:string,epoch:string):string{
  return `vault:${requireUuid(vaultId,'Vault identity')}:${requireUuid(epoch,'epoch')}`;
}

export function realtimeSocketUrl(config:PublicBackendConfig):string{
  const url=new URL(config.url);
  if(url.protocol==='https:') url.protocol='wss:';
  else if(url.protocol==='http:') url.protocol='ws:';
  else throw new VaultError('CONFIGURATION','Realtime requires an HTTP(S) Supabase project URL.');
  url.pathname='/realtime/v1/websocket';
  url.search='';
  url.searchParams.set('apikey',config.publishableKey);
  url.searchParams.set('vsn','2.0.0');
  return url.toString();
}

function objectRecord(value:unknown):Record<string,unknown>|null{
  return value && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : null;
}

function optionalString(value:unknown):string|null{
  return typeof value==='string' && value.length ? value : null;
}

function wakeEvent(value:unknown,expectedVaultId:string):RealtimeWakeEvent|null{
  const outer=objectRecord(value);
  if(!outer || outer.event!=='sync_event') return null;
  const payload=objectRecord(outer.payload);
  if(!payload || payload.vaultId!==expectedVaultId || typeof payload.sequence!=='string' || !CURSOR_PATTERN.test(payload.sequence)) return null;
  const revision=typeof payload.revision==='number' && Number.isInteger(payload.revision) && payload.revision>=1
    ? payload.revision
    : null;
  return {
    vaultId:expectedVaultId,
    sequence:payload.sequence,
    operationId:optionalString(payload.operationId),
    entryId:optionalString(payload.entryId),
    revision,
    deviceId:optionalString(payload.deviceId),
  };
}

/**
 * Minimal Supabase Realtime/Phoenix client used only as a private authenticated
 * wake-up path. Canonical state still travels through Phase 15/16 pull/push RPCs.
 */
export class SupabaseRealtimeWakeup {
  private desired:DesiredSubscription|null=null;
  private socket:WebSocket|null=null;
  private status:RealtimeWakeStatus='idle';
  private generation=0;
  private ref=0;
  private joinRef:string|null=null;
  private joinMessageRef:string|null=null;
  private lastToken:string|null=null;
  private reconnectAttempt=0;
  private reconnectTimer:ReturnType<typeof setTimeout>|null=null;
  private heartbeatTimer:ReturnType<typeof setInterval>|null=null;
  private tokenTimer:ReturnType<typeof setInterval>|null=null;

  constructor(
    private readonly config:PublicBackendConfig,
    private readonly tokenProvider:()=>Promise<string|null>,
    private readonly callbacks:RealtimeWakeCallbacks={},
    private readonly socketFactory:SocketFactory=(url)=>new WebSocket(url),
  ){}

  get currentStatus():RealtimeWakeStatus{return this.status;}
  get currentTopic():string|null{return this.desired?.topic ?? null;}

  async subscribe(vaultId:string,epoch:string):Promise<void>{
    const topic=vaultRealtimeTopic(vaultId,epoch);
    if(this.desired?.topic===topic && ['connecting','connected','retrying'].includes(this.status)) return;
    this.resetSocket();
    this.desired={vaultId:requireUuid(vaultId,'Vault identity'),epoch:requireUuid(epoch,'epoch'),topic,wireTopic:`realtime:${topic}`};
    this.reconnectAttempt=0;
    await this.connect();
  }

  stop():void{
    this.desired=null;
    this.clearReconnect();
    this.resetSocket();
    this.setStatus('stopped');
  }

  private nextRef():string{
    this.ref=(this.ref+1)%2_000_000_000;
    return String(this.ref||1);
  }

  private setStatus(status:RealtimeWakeStatus):void{
    if(this.status===status) return;
    this.status=status;
    this.callbacks.onStatus?.(status);
  }

  private clearReconnect():void{
    if(this.reconnectTimer!==null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer=null;
  }

  private clearLiveTimers():void{
    if(this.heartbeatTimer!==null) clearInterval(this.heartbeatTimer);
    if(this.tokenTimer!==null) clearInterval(this.tokenTimer);
    this.heartbeatTimer=null;
    this.tokenTimer=null;
  }

  private resetSocket():void{
    this.generation++;
    this.clearLiveTimers();
    const current=this.socket;
    this.socket=null;
    this.joinRef=null;
    this.joinMessageRef=null;
    this.lastToken=null;
    if(current && current.readyState<2){
      try{current.close(1000,'Vault realtime subscription changed.');}catch{ /* best effort */ }
    }
  }

  private scheduleReconnect():void{
    if(!this.desired || this.reconnectTimer!==null) return;
    this.setStatus('retrying');
    const delay=RECONNECT_DELAYS[Math.min(this.reconnectAttempt,RECONNECT_DELAYS.length-1)]!;
    this.reconnectAttempt++;
    this.reconnectTimer=setTimeout(()=>{
      this.reconnectTimer=null;
      void this.connect();
    },delay);
  }

  private async connect():Promise<void>{
    const desired=this.desired;
    if(!desired) return;
    this.clearReconnect();
    const generation=++this.generation;
    this.setStatus('connecting');

    let token:string|null;
    try{token=await this.tokenProvider();}
    catch{
      if(generation===this.generation) this.scheduleReconnect();
      return;
    }
    if(generation!==this.generation || !this.desired || this.desired.topic!==desired.topic) return;
    if(!token){
      this.setStatus('unauthenticated');
      return;
    }
    this.lastToken=token;

    const socket=this.socketFactory(realtimeSocketUrl(this.config));
    this.socket=socket;

    socket.addEventListener('open',()=>{
      if(generation!==this.generation || socket!==this.socket || !this.desired) return;
      this.joinRef=this.nextRef();
      this.joinMessageRef=this.nextRef();
      this.send([
        this.joinRef,
        this.joinMessageRef,
        desired.wireTopic,
        'phx_join',
        {
          config:{
            broadcast:{ack:false,self:false},
            presence:{enabled:false,key:''},
            postgres_changes:[],
            private:true,
          },
          access_token:token,
        },
      ]);
    });

    socket.addEventListener('message',(event:MessageEvent<unknown>)=>{
      if(generation!==this.generation || socket!==this.socket) return;
      this.handleMessage(event.data,desired);
    });

    socket.addEventListener('error',()=>{
      if(generation!==this.generation || socket!==this.socket) return;
      try{socket.close();}catch{this.scheduleReconnect();}
    });

    socket.addEventListener('close',()=>{
      if(generation!==this.generation || socket!==this.socket) return;
      this.socket=null;
      this.clearLiveTimers();
      this.joinRef=null;
      this.joinMessageRef=null;
      if(this.desired?.topic===desired.topic) this.scheduleReconnect();
    });
  }

  private send(frame:unknown[]):void{
    const socket=this.socket;
    if(!socket || socket.readyState!==1) return;
    socket.send(JSON.stringify(frame));
  }

  private handleMessage(data:unknown,desired:DesiredSubscription):void{
    if(typeof data!=='string') return;
    let frame:unknown;
    try{frame=JSON.parse(data) as unknown;}catch{return;}
    if(!Array.isArray(frame) || frame.length<5) return;
    const [,messageRef,topic,event,payload]=frame;
    if(typeof event!=='string') return;

    if(event==='phx_reply' && messageRef===this.joinMessageRef && topic===desired.wireTopic){
      const reply=objectRecord(payload);
      if(reply?.status==='ok'){
        this.reconnectAttempt=0;
        this.setStatus('connected');
        this.startLiveTimers(desired);
      }else{
        try{this.socket?.close();}catch{this.scheduleReconnect();}
      }
      return;
    }

    if(topic!==desired.wireTopic || event!=='broadcast') return;
    const wake=wakeEvent(payload,desired.vaultId);
    if(wake) this.callbacks.onWake?.(wake);
  }

  private startLiveTimers(desired:DesiredSubscription):void{
    this.clearLiveTimers();
    this.heartbeatTimer=setInterval(()=>{
      if(this.desired?.topic!==desired.topic) return;
      this.send([null,this.nextRef(),'phoenix','heartbeat',{}]);
    },25_000);
    this.tokenTimer=setInterval(()=>{
      void this.refreshToken(desired);
    },30_000);
  }

  private async refreshToken(desired:DesiredSubscription):Promise<void>{
    if(this.desired?.topic!==desired.topic || this.status!=='connected') return;
    try{
      const token=await this.tokenProvider();
      if(!token){
        this.setStatus('unauthenticated');
        this.resetSocket();
        return;
      }
      if(token===this.lastToken) return;
      this.lastToken=token;
      this.send([this.joinRef,this.nextRef(),desired.wireTopic,'access_token',{access_token:token}]);
    }catch{
      // Keep the live socket while the current JWT may still be valid. A later
      // heartbeat/token tick or socket close will retry through the normal path.
    }
  }
}
