import { VaultError } from '../domain/errors.js';
import type { PublicBackendConfig } from '../services/runtime-config.js';
import { base64ToBytes, bytesToBase64 } from '../collaboration/crdt-text.js';
import { realtimeSocketUrl } from './realtime-wakeup.js';

export type CrdtRealtimeStatus='idle'|'connecting'|'connected'|'retrying'|'unauthenticated'|'stopped';
export type CrdtEditorRole='owner'|'editor';

export interface CrdtRoomInput {
  vaultId:string;
  epoch:string;
  entryId:string;
  sessionId:string;
  role:CrdtEditorRole;
  baseRevision:number;
  baseFingerprint:string;
}

export interface CrdtRemoteUpdate {
  sessionId:string;
  baseRevision:number;
  baseFingerprint:string;
  update:Uint8Array;
}

export interface CrdtSyncRequest {
  requestId:string;
  sessionId:string;
  baseRevision:number;
  baseFingerprint:string;
  stateVector:Uint8Array;
}

export interface CrdtSyncResponse {
  requestId:string;
  sessionId:string;
  targetSessionId:string;
  baseRevision:number;
  baseFingerprint:string;
  replace:boolean;
  update:Uint8Array;
}

export interface CrdtRealtimeCallbacks {
  onStatus?:(status:CrdtRealtimeStatus)=>void;
  onConnected?:()=>void;
  onUpdate?:(message:CrdtRemoteUpdate)=>void;
  onSyncRequest?:(message:CrdtSyncRequest)=>void;
  onSyncResponse?:(message:CrdtSyncResponse)=>void;
}

type SocketFactory=(url:string)=>WebSocket;
interface DesiredRoom extends CrdtRoomInput {
  topic:string;
  wireTopic:string;
}

const UUID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const FINGERPRINT_PATTERN=/^[0-9a-f]{8}$/u;
const RECONNECT_DELAYS=[1_000,2_000,5_000,10_000] as const;

function record(value:unknown):Record<string,unknown>|null{
  return value!==null && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : null;
}
function uuid(value:string,label:string):string{
  if(!UUID_PATTERN.test(value)) throw new VaultError('PROTOCOL',`Invalid CRDT ${label}.`);
  return value.toLowerCase();
}
function baseRevision(value:unknown):number|null{
  return typeof value==='number' && Number.isSafeInteger(value) && value>=1 ? value : null;
}
function fingerprint(value:unknown):string|null{
  return typeof value==='string' && FINGERPRINT_PATTERN.test(value) ? value : null;
}

export function vaultCrdtTopic(vaultId:string,epoch:string,entryId:string):string{
  return `vault-edit:${uuid(vaultId,'Vault identity')}:${uuid(epoch,'epoch')}:${uuid(entryId,'entry identity')}`;
}

export class SupabaseCrdtRealtime {
  private desired:DesiredRoom|null=null;
  private socket:WebSocket|null=null;
  private status:CrdtRealtimeStatus='idle';
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
    private readonly callbacks:CrdtRealtimeCallbacks={},
    private readonly socketFactory:SocketFactory=(url)=>new WebSocket(url),
  ){}

  get currentStatus():CrdtRealtimeStatus{return this.status;}
  get currentSessionId():string|null{return this.desired?.sessionId ?? null;}

  async subscribe(input:CrdtRoomInput):Promise<void>{
    const normalized:CrdtRoomInput={
      vaultId:uuid(input.vaultId,'Vault identity'),
      epoch:uuid(input.epoch,'epoch'),
      entryId:uuid(input.entryId,'entry identity'),
      sessionId:uuid(input.sessionId,'session identity'),
      role:input.role,
      baseRevision:input.baseRevision,
      baseFingerprint:input.baseFingerprint,
    };
    if(normalized.role!=='owner' && normalized.role!=='editor') throw new VaultError('PERMISSION','Viewer memberships cannot publish live text edits.');
    if(!Number.isSafeInteger(normalized.baseRevision)||normalized.baseRevision<1 || !FINGERPRINT_PATTERN.test(normalized.baseFingerprint)){
      throw new VaultError('PROTOCOL','Invalid CRDT base snapshot.');
    }
    const topic=vaultCrdtTopic(normalized.vaultId,normalized.epoch,normalized.entryId);
    if(this.desired?.topic===topic && this.desired.sessionId===normalized.sessionId
      && this.desired.baseRevision===normalized.baseRevision && this.desired.baseFingerprint===normalized.baseFingerprint
      && ['connecting','connected','retrying'].includes(this.status)) return;
    this.stop(false);
    this.desired={...normalized,topic,wireTopic:`realtime:${topic}`};
    this.reconnectAttempt=0;
    await this.connect();
  }

  publishUpdate(update:Uint8Array):void{
    const desired=this.desired;
    if(!desired || this.status!=='connected' || update.byteLength===0) return;
    this.broadcast('crdt-update',{
      version:1,
      sessionId:desired.sessionId,
      baseRevision:desired.baseRevision,
      baseFingerprint:desired.baseFingerprint,
      update:bytesToBase64(update),
    });
  }

  requestSync(stateVector:Uint8Array):string|null{
    const desired=this.desired;
    if(!desired || this.status!=='connected') return null;
    const requestId=crypto.randomUUID();
    this.broadcast('crdt-sync-request',{
      version:1,
      requestId,
      sessionId:desired.sessionId,
      baseRevision:desired.baseRevision,
      baseFingerprint:desired.baseFingerprint,
      stateVector:bytesToBase64(stateVector),
    });
    return requestId;
  }

  respondSync(request:CrdtSyncRequest,update:Uint8Array,replace:boolean):void{
    const desired=this.desired;
    if(!desired || this.status!=='connected') return;
    this.broadcast('crdt-sync-response',{
      version:1,
      requestId:request.requestId,
      sessionId:desired.sessionId,
      targetSessionId:request.sessionId,
      baseRevision:desired.baseRevision,
      baseFingerprint:desired.baseFingerprint,
      replace,
      update:bytesToBase64(update),
    });
  }

  stop(notify=true):void{
    this.desired=null;
    this.clearReconnect();
    this.resetSocket();
    if(notify) this.setStatus('stopped');
  }

  private nextRef():string{
    this.ref=(this.ref+1)%2_000_000_000;
    return String(this.ref||1);
  }
  private setStatus(status:CrdtRealtimeStatus):void{
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
      try{current.close(1000,'Vault CRDT subscription changed.');}catch{ /* best effort */ }
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
    catch{if(generation===this.generation) this.scheduleReconnect(); return;}
    if(generation!==this.generation || this.desired?.topic!==desired.topic) return;
    if(!token){this.setStatus('unauthenticated'); return;}
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
    if(!this.socket || this.socket.readyState!==1) return;
    this.socket.send(JSON.stringify(frame));
  }
  private broadcast(event:string,payload:Record<string,unknown>):void{
    const desired=this.desired;
    if(!desired || !this.joinRef) return;
    this.send([
      this.joinRef,
      this.nextRef(),
      desired.wireTopic,
      'broadcast',
      {type:'broadcast',event,payload},
    ]);
  }

  private handleMessage(data:unknown,desired:DesiredRoom):void{
    if(typeof data!=='string') return;
    let frame:unknown;
    try{frame=JSON.parse(data) as unknown;}catch{return;}
    if(!Array.isArray(frame)||frame.length<5) return;
    const [,messageRef,topic,event,payload]=frame;
    if(typeof event!=='string') return;

    if(event==='phx_reply' && messageRef===this.joinMessageRef && topic===desired.wireTopic){
      const reply=record(payload);
      if(reply?.status==='ok'){
        this.reconnectAttempt=0;
        this.setStatus('connected');
        this.startLiveTimers(desired);
        this.callbacks.onConnected?.();
      }else{
        try{this.socket?.close();}catch{this.scheduleReconnect();}
      }
      return;
    }
    if(topic!==desired.wireTopic) return;
    if(event==='phx_error' || event==='phx_close'){
      try{this.socket?.close();}catch{this.scheduleReconnect();}
      return;
    }
    if(event==='system'){
      const system=record(payload);
      if(system?.status==='error'){
        try{this.socket?.close();}catch{this.scheduleReconnect();}
      }
      return;
    }
    if(event!=='broadcast') return;
    const outer=record(payload);
    if(!outer || typeof outer.event!=='string') return;
    const body=record(outer.payload);
    if(!body || body.version!==1) return;

    const sessionId=typeof body.sessionId==='string' && UUID_PATTERN.test(body.sessionId) ? body.sessionId.toLowerCase() : null;
    if(!sessionId || sessionId===desired.sessionId) return;
    const revision=baseRevision(body.baseRevision);
    const baseFp=fingerprint(body.baseFingerprint);
    if(revision===null || baseFp===null) return;

    try{
      if(outer.event==='crdt-update' && typeof body.update==='string'){
        this.callbacks.onUpdate?.({
          sessionId,
          baseRevision:revision,
          baseFingerprint:baseFp,
          update:base64ToBytes(body.update),
        });
        return;
      }
      if(outer.event==='crdt-sync-request'
        && typeof body.requestId==='string' && UUID_PATTERN.test(body.requestId)
        && typeof body.stateVector==='string'){
        this.callbacks.onSyncRequest?.({
          requestId:body.requestId.toLowerCase(),
          sessionId,
          baseRevision:revision,
          baseFingerprint:baseFp,
          stateVector:base64ToBytes(body.stateVector,128*1024),
        });
        return;
      }
      if(outer.event==='crdt-sync-response'
        && typeof body.requestId==='string' && UUID_PATTERN.test(body.requestId)
        && typeof body.targetSessionId==='string' && UUID_PATTERN.test(body.targetSessionId)
        && body.targetSessionId.toLowerCase()===desired.sessionId
        && typeof body.replace==='boolean'
        && typeof body.update==='string'){
        this.callbacks.onSyncResponse?.({
          requestId:body.requestId.toLowerCase(),
          sessionId,
          targetSessionId:desired.sessionId,
          baseRevision:revision,
          baseFingerprint:baseFp,
          replace:body.replace,
          update:base64ToBytes(body.update),
        });
      }
    }catch{
      // Malformed/oversized ephemeral collaboration frames are discarded.
    }
  }

  private startLiveTimers(desired:DesiredRoom):void{
    this.clearLiveTimers();
    this.heartbeatTimer=setInterval(()=>{
      if(this.desired?.topic!==desired.topic) return;
      this.send([null,this.nextRef(),'phoenix','heartbeat',{}]);
    },25_000);
    this.tokenTimer=setInterval(()=>void this.refreshToken(desired),30_000);
  }
  private async refreshToken(desired:DesiredRoom):Promise<void>{
    if(this.desired?.topic!==desired.topic || this.status!=='connected') return;
    try{
      const token=await this.tokenProvider();
      if(!token){this.setStatus('unauthenticated'); this.resetSocket(); return;}
      if(token===this.lastToken) return;
      this.lastToken=token;
      this.send([this.joinRef,this.nextRef(),desired.wireTopic,'access_token',{access_token:token}]);
    }catch{/* keep current JWT/socket until normal reconnect path */}
  }
}
