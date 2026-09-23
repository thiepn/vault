import { VaultError } from '../domain/errors.js';
import type { PublicBackendConfig } from '../services/runtime-config.js';
import { realtimeSocketUrl } from './realtime-wakeup.js';

export type CollaborationStatus='idle'|'connecting'|'connected'|'retrying'|'unauthenticated'|'stopped';
export type CollaborationRole='owner'|'editor'|'viewer';
export type CollaborationMode='none'|'source'|'live'|'reading'|'attachment'|'folder';

export interface CollaborationPresence {
  version:1;
  vaultId:string;
  userId:string;
  deviceId:string;
  sessionId:string;
  role:CollaborationRole;
  entryId:string|null;
  mode:CollaborationMode;
  onlineAt:string;
}

export interface CollaborationCursor {
  version:1;
  vaultId:string;
  entryId:string;
  userId:string;
  deviceId:string;
  sessionId:string;
  position:number;
  from:number;
  to:number;
  documentFingerprint:string;
  at:string;
}

export interface CollaborationCallbacks {
  onStatus?:(status:CollaborationStatus)=>void;
  onPresence?:(participants:readonly CollaborationPresence[])=>void;
  onCursor?:(cursor:CollaborationCursor)=>void;
}

export interface CollaborationSessionInput {
  vaultId:string;
  epoch:string;
  userId:string;
  deviceId:string;
  sessionId:string;
  role:CollaborationRole;
  entryId:string|null;
  mode:CollaborationMode;
}

type SocketFactory=(url:string)=>WebSocket;
interface DesiredSession extends CollaborationSessionInput {
  topic:string;
  wireTopic:string;
}

const UUID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MODES=new Set<CollaborationMode>(['none','source','live','reading','attachment','folder']);
const ROLES=new Set<CollaborationRole>(['owner','editor','viewer']);
const RECONNECT_DELAYS=[1_000,2_000,5_000,10_000] as const;
const CURSOR_INTERVAL_MS=100;

function record(value:unknown):Record<string,unknown>|null{
  return value!==null && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : null;
}
function uuid(value:string,label:string):string{
  if(!UUID_PATTERN.test(value)) throw new VaultError('PROTOCOL',`Invalid collaboration ${label}.`);
  return value.toLowerCase();
}
function optionalUuid(value:unknown):string|null{
  if(value===null) return null;
  return typeof value==='string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}
function timestamp(value:unknown):string|null{
  return typeof value==='string' && Number.isFinite(Date.parse(value)) ? value : null;
}

export function vaultCollaborationTopic(vaultId:string,epoch:string):string{
  return `vault-collab:${uuid(vaultId,'Vault identity')}:${uuid(epoch,'epoch')}`;
}

export function validateCollaborationPresence(value:unknown,expectedVaultId:string):CollaborationPresence|null{
  const row=record(value);
  if(!row || row.version!==1 || row.vaultId!==expectedVaultId
    || typeof row.userId!=='string' || !UUID_PATTERN.test(row.userId)
    || typeof row.deviceId!=='string' || !UUID_PATTERN.test(row.deviceId)
    || typeof row.sessionId!=='string' || !UUID_PATTERN.test(row.sessionId)
    || typeof row.role!=='string' || !ROLES.has(row.role as CollaborationRole)
    || typeof row.mode!=='string' || !MODES.has(row.mode as CollaborationMode)) return null;
  const entryId=optionalUuid(row.entryId);
  if(row.entryId!==null && entryId===null) return null;
  const onlineAt=timestamp(row.onlineAt);
  if(!onlineAt) return null;
  return {
    version:1,
    vaultId:expectedVaultId,
    userId:row.userId.toLowerCase(),
    deviceId:row.deviceId.toLowerCase(),
    sessionId:row.sessionId.toLowerCase(),
    role:row.role as CollaborationRole,
    entryId,
    mode:row.mode as CollaborationMode,
    onlineAt,
  };
}

export function validateCollaborationCursor(value:unknown,expectedVaultId:string):CollaborationCursor|null{
  const row=record(value);
  if(!row || row.version!==1 || row.vaultId!==expectedVaultId
    || typeof row.entryId!=='string' || !UUID_PATTERN.test(row.entryId)
    || typeof row.userId!=='string' || !UUID_PATTERN.test(row.userId)
    || typeof row.deviceId!=='string' || !UUID_PATTERN.test(row.deviceId)
    || typeof row.sessionId!=='string' || !UUID_PATTERN.test(row.sessionId)
    || typeof row.position!=='number' || !Number.isSafeInteger(row.position) || row.position<0
    || typeof row.from!=='number' || !Number.isSafeInteger(row.from) || row.from<0
    || typeof row.to!=='number' || !Number.isSafeInteger(row.to) || row.to<row.from
    || row.position<row.from || row.position>row.to
    || typeof row.documentFingerprint!=='string' || !/^[0-9a-f]{8}$/u.test(row.documentFingerprint)) return null;
  const at=timestamp(row.at);
  if(!at) return null;
  return {
    version:1,
    vaultId:expectedVaultId,
    entryId:row.entryId.toLowerCase(),
    userId:row.userId.toLowerCase(),
    deviceId:row.deviceId.toLowerCase(),
    sessionId:row.sessionId.toLowerCase(),
    position:row.position,
    from:row.from,
    to:row.to,
    documentFingerprint:row.documentFingerprint,
    at,
  };
}

export class SupabaseCollaborationRealtime {
  private desired:DesiredSession|null=null;
  private socket:WebSocket|null=null;
  private status:CollaborationStatus='idle';
  private generation=0;
  private ref=0;
  private joinRef:string|null=null;
  private joinMessageRef:string|null=null;
  private lastToken:string|null=null;
  private reconnectAttempt=0;
  private reconnectTimer:ReturnType<typeof setTimeout>|null=null;
  private heartbeatTimer:ReturnType<typeof setInterval>|null=null;
  private tokenTimer:ReturnType<typeof setInterval>|null=null;
  private cursorTimer:ReturnType<typeof setTimeout>|null=null;
  private lastCursorSentAt=0;
  private pendingCursor:CollaborationCursor|null=null;
  private presenceState=new Map<string,Map<string,CollaborationPresence>>();

  constructor(
    private readonly config:PublicBackendConfig,
    private readonly tokenProvider:()=>Promise<string|null>,
    private readonly callbacks:CollaborationCallbacks={},
    private readonly socketFactory:SocketFactory=(url)=>new WebSocket(url),
  ){}

  get currentStatus():CollaborationStatus{return this.status;}
  get currentTopic():string|null{return this.desired?.topic ?? null;}
  get participants():readonly CollaborationPresence[]{return this.flattenPresence();}

  async subscribe(input:CollaborationSessionInput):Promise<void>{
    const normalized:CollaborationSessionInput={
      ...input,
      vaultId:uuid(input.vaultId,'Vault identity'),
      epoch:uuid(input.epoch,'epoch'),
      userId:uuid(input.userId,'user identity'),
      deviceId:uuid(input.deviceId,'device identity'),
      sessionId:uuid(input.sessionId,'session identity'),
      entryId:input.entryId===null ? null : uuid(input.entryId,'entry identity'),
    };
    if(!ROLES.has(normalized.role) || !MODES.has(normalized.mode)) throw new VaultError('PROTOCOL','Invalid collaboration session state.');
    const topic=vaultCollaborationTopic(normalized.vaultId,normalized.epoch);
    if(this.desired?.topic===topic && this.desired.sessionId===normalized.sessionId){
      this.desired={...normalized,topic,wireTopic:`realtime:${topic}`};
      if(this.status==='connected'){ this.trackPresence(); return; }
      if(this.status==='connecting' || this.status==='retrying') return;
      this.resetSocket();
      this.reconnectAttempt=0;
      await this.connect();
      return;
    }
    this.stop(false);
    this.desired={...normalized,topic,wireTopic:`realtime:${topic}`};
    this.reconnectAttempt=0;
    await this.connect();
  }

  updateContext(input:Pick<CollaborationSessionInput,'entryId'|'mode'|'role'>):void{
    if(!this.desired) return;
    if(!ROLES.has(input.role) || !MODES.has(input.mode)) throw new VaultError('PROTOCOL','Invalid collaboration context.');
    this.desired={
      ...this.desired,
      entryId:input.entryId===null ? null : uuid(input.entryId,'entry identity'),
      mode:input.mode,
      role:input.role,
    };
    if(this.status==='connected') this.trackPresence();
  }

  publishCursor(cursor:Omit<CollaborationCursor,'version'|'vaultId'|'userId'|'deviceId'|'sessionId'|'at'>):void{
    const desired=this.desired;
    if(!desired || this.status!=='connected') return;
    const parsed=validateCollaborationCursor({
      version:1,
      vaultId:desired.vaultId,
      userId:desired.userId,
      deviceId:desired.deviceId,
      sessionId:desired.sessionId,
      entryId:cursor.entryId,
      position:cursor.position,
      from:cursor.from,
      to:cursor.to,
      documentFingerprint:cursor.documentFingerprint,
      at:new Date().toISOString(),
    },desired.vaultId);
    if(!parsed) return;
    this.pendingCursor=parsed;
    const elapsed=Date.now()-this.lastCursorSentAt;
    if(elapsed>=CURSOR_INTERVAL_MS){
      this.flushCursor();
      return;
    }
    if(this.cursorTimer===null){
      this.cursorTimer=setTimeout(()=>{
        this.cursorTimer=null;
        this.flushCursor();
      },CURSOR_INTERVAL_MS-elapsed);
    }
  }

  stop(notify=true):void{
    this.desired=null;
    this.clearReconnect();
    this.resetSocket();
    this.presenceState.clear();
    this.pendingCursor=null;
    if(this.cursorTimer!==null) clearTimeout(this.cursorTimer);
    this.cursorTimer=null;
    if(notify){
      this.emitPresence();
      this.setStatus('stopped');
    }
  }

  private nextRef():string{
    this.ref=(this.ref+1)%2_000_000_000;
    return String(this.ref||1);
  }

  private setStatus(status:CollaborationStatus):void{
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
      try{current.close(1000,'Vault collaboration subscription changed.');}catch{ /* best effort */ }
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
            presence:{enabled:true,key:desired.sessionId},
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
      this.presenceState.clear();
      this.emitPresence();
      if(this.desired?.topic===desired.topic) this.scheduleReconnect();
    });
  }

  private send(frame:unknown[]):void{
    if(!this.socket || this.socket.readyState!==1) return;
    this.socket.send(JSON.stringify(frame));
  }

  private trackPresence():void{
    const desired=this.desired;
    if(!desired || !this.joinRef || this.status!=='connected') return;
    const payload:CollaborationPresence={
      version:1,
      vaultId:desired.vaultId,
      userId:desired.userId,
      deviceId:desired.deviceId,
      sessionId:desired.sessionId,
      role:desired.role,
      entryId:desired.entryId,
      mode:desired.mode,
      onlineAt:new Date().toISOString(),
    };
    this.send([
      this.joinRef,
      this.nextRef(),
      desired.wireTopic,
      'presence',
      {type:'presence',event:'track',payload},
    ]);
  }

  private handleMessage(data:unknown,desired:DesiredSession):void{
    if(typeof data!=='string') return;
    let frame:unknown;
    try{frame=JSON.parse(data) as unknown;}catch{return;}
    if(!Array.isArray(frame) || frame.length<5) return;
    const [,messageRef,topic,event,payload]=frame;
    if(typeof event!=='string') return;

    if(event==='phx_reply' && messageRef===this.joinMessageRef && topic===desired.wireTopic){
      const reply=record(payload);
      if(reply?.status==='ok'){
        this.reconnectAttempt=0;
        this.setStatus('connected');
        this.startLiveTimers(desired);
        this.trackPresence();
      }else{
        try{this.socket?.close();}catch{this.scheduleReconnect();}
      }
      return;
    }
    if(topic!==desired.wireTopic) return;
    if(event==='presence_state'){this.replacePresence(payload,desired.vaultId); return;}
    if(event==='presence_diff'){this.applyPresenceDiff(payload,desired.vaultId); return;}
    if(event==='broadcast'){
      const outer=record(payload);
      if(!outer || outer.event!=='cursor') return;
      const cursor=validateCollaborationCursor(outer.payload,desired.vaultId);
      if(cursor && cursor.sessionId!==desired.sessionId) this.callbacks.onCursor?.(cursor);
      return;
    }
    if(event==='phx_error' || event==='phx_close'){
      try{this.socket?.close();}catch{this.scheduleReconnect();}
      return;
    }
    if(event==='system'){
      const system=record(payload);
      if(system?.status==='error'){
        try{this.socket?.close();}catch{this.scheduleReconnect();}
      }
    }
  }

  private replacePresence(value:unknown,vaultId:string):void{
    const root=record(value);
    if(!root) return;
    const next=new Map<string,Map<string,CollaborationPresence>>();
    for(const [key,raw] of Object.entries(root)){
      const row=record(raw);
      if(!row || !Array.isArray(row.metas)) continue;
      for(const meta of row.metas){
        const parsed=validateCollaborationPresence(meta,vaultId);
        const metaRow=record(meta);
        const ref=metaRow?.phx_ref;
        if(!parsed || parsed.sessionId!==key || typeof ref!=='string' || !ref) continue;
        let refs=next.get(key);
        if(!refs){refs=new Map(); next.set(key,refs);}
        refs.set(ref,parsed);
      }
    }
    this.presenceState=next;
    this.emitPresence();
  }

  private applyPresenceDiff(value:unknown,vaultId:string):void{
    const diff=record(value);
    if(!diff) return;
    const joins=record(diff.joins)??{};
    const leaves=record(diff.leaves)??{};
    for(const [key,raw] of Object.entries(joins)){
      const row=record(raw);
      if(!row || !Array.isArray(row.metas)) continue;
      let refs=this.presenceState.get(key);
      if(!refs){refs=new Map(); this.presenceState.set(key,refs);}
      for(const meta of row.metas){
        const parsed=validateCollaborationPresence(meta,vaultId);
        const metaRow=record(meta);
        const ref=metaRow?.phx_ref;
        if(parsed && parsed.sessionId===key && typeof ref==='string' && ref) refs.set(ref,parsed);
      }
    }
    for(const [key,raw] of Object.entries(leaves)){
      const row=record(raw);
      if(!row || !Array.isArray(row.metas)) continue;
      const refs=this.presenceState.get(key);
      if(!refs) continue;
      for(const meta of row.metas){
        const metaRow=record(meta);
        const ref=metaRow?.phx_ref;
        if(typeof ref==='string') refs.delete(ref);
      }
      if(refs.size===0) this.presenceState.delete(key);
    }
    this.emitPresence();
  }

  private flattenPresence():CollaborationPresence[]{
    const bySession=new Map<string,CollaborationPresence>();
    for(const refs of this.presenceState.values()){
      for(const presence of refs.values()) bySession.set(presence.sessionId,presence);
    }
    return [...bySession.values()].sort((a,b)=>a.userId.localeCompare(b.userId)||a.sessionId.localeCompare(b.sessionId));
  }

  private emitPresence():void{
    this.callbacks.onPresence?.(this.flattenPresence());
  }

  private flushCursor():void{
    const desired=this.desired;
    const cursor=this.pendingCursor;
    this.pendingCursor=null;
    if(!desired || !cursor || this.status!=='connected' || !this.joinRef) return;
    this.lastCursorSentAt=Date.now();
    this.send([
      this.joinRef,
      this.nextRef(),
      desired.wireTopic,
      'broadcast',
      {type:'broadcast',event:'cursor',payload:cursor},
    ]);
  }

  private startLiveTimers(desired:DesiredSession):void{
    this.clearLiveTimers();
    this.heartbeatTimer=setInterval(()=>{
      if(this.desired?.topic!==desired.topic) return;
      this.send([null,this.nextRef(),'phoenix','heartbeat',{}]);
    },25_000);
    this.tokenTimer=setInterval(()=>void this.refreshToken(desired),30_000);
  }

  private async refreshToken(desired:DesiredSession):Promise<void>{
    if(this.desired?.topic!==desired.topic || this.status!=='connected') return;
    try{
      const token=await this.tokenProvider();
      if(!token){this.setStatus('unauthenticated'); this.resetSocket(); return;}
      if(token===this.lastToken) return;
      this.lastToken=token;
      this.send([this.joinRef,this.nextRef(),desired.wireTopic,'access_token',{access_token:token}]);
    }catch{/* keep current socket until token expiry/connection failure */}
  }
}
