import * as Y from 'yjs';
import type { EntryId } from '../domain/model.js';

export interface CrdtBaseSnapshot {
  entryId:EntryId;
  revision:number;
  fingerprint:string;
  text:string;
}

export type CrdtTextSource='local'|'remote';

export interface LocalCrdtTransaction {
  beforeText:string;
  afterText:string;
  updates:readonly Uint8Array[];
}
export interface CrdtTextCallbacks {
  onText?:(text:string,source:CrdtTextSource)=>void;
  onUpdate?:(update:Uint8Array)=>void;
  onLocalTransaction?:(transaction:LocalCrdtTransaction)=>void;
}

const SEED_ORIGIN=Symbol('vault-crdt-seed');
const REMOTE_ORIGIN=Symbol('vault-crdt-remote');

function hash32(value:string):number{
  let hash=2166136261;
  for(let index=0;index<value.length;index++){
    hash^=value.charCodeAt(index);
    hash=Math.imul(hash,16777619);
  }
  const normalized=hash>>>0;
  return normalized===0 ? 1 : normalized;
}

function seedClientId(base:CrdtBaseSnapshot):number{
  return hash32(`${base.entryId}:${base.revision}:${base.fingerprint}`);
}

export function canonicalSeedUpdate(base:CrdtBaseSnapshot):Uint8Array{
  if(!Number.isSafeInteger(base.revision)||base.revision<1) throw new Error('CRDT base revision must be a positive integer.');
  if(!/^[0-9a-f]{8}$/u.test(base.fingerprint)) throw new Error('CRDT base fingerprint is invalid.');
  const seed=new Y.Doc({guid:`vault-seed:${base.entryId}:${base.revision}:${base.fingerprint}`});
  // This client ID belongs only to an isolated immutable seed document. Live
  // documents keep Yjs-generated unique client IDs.
  (seed as Y.Doc & {clientID:number}).clientID=seedClientId(base);
  const text=seed.getText('markdown');
  seed.transact(()=>{ if(base.text.length) text.insert(0,base.text); },SEED_ORIGIN);
  const update=Y.encodeStateAsUpdate(seed);
  seed.destroy();
  return update;
}

function newLiveDoc(avoidClientId:number):Y.Doc{
  for(let attempt=0;attempt<8;attempt++){
    const doc=new Y.Doc();
    if(doc.clientID!==avoidClientId) return doc;
    doc.destroy();
  }
  throw new Error('Could not allocate a unique Yjs client identity.');
}

function singleSplice(current:string,next:string):{from:number;deleteCount:number;insert:string}|null{
  if(current===next) return null;
  let prefix=0;
  const prefixLimit=Math.min(current.length,next.length);
  while(prefix<prefixLimit && current.charCodeAt(prefix)===next.charCodeAt(prefix)) prefix++;

  let suffix=0;
  const suffixLimit=Math.min(current.length-prefix,next.length-prefix);
  while(
    suffix<suffixLimit
    && current.charCodeAt(current.length-1-suffix)===next.charCodeAt(next.length-1-suffix)
  ) suffix++;

  return {
    from:prefix,
    deleteCount:current.length-prefix-suffix,
    insert:next.slice(prefix,next.length-suffix),
  };
}

export class CrdtTextDocument {
  readonly doc:Y.Doc;
  readonly text:Y.Text;
  readonly undoManager:Y.UndoManager;
  readonly localOrigin={kind:'vault-local-crdt'} as const;
  private destroyed=false;
  private captureUpdates:Uint8Array[]|null=null;

  constructor(
    readonly base:CrdtBaseSnapshot,
    private readonly callbacks:CrdtTextCallbacks={},
    seed=true,
  ){
    const seedId=seedClientId(base);
    this.doc=newLiveDoc(seedId);
    this.text=this.doc.getText('markdown');
    if(seed) Y.applyUpdate(this.doc,canonicalSeedUpdate(base),SEED_ORIGIN);
    this.undoManager=new Y.UndoManager(this.text,{
      trackedOrigins:new Set<unknown>([this.localOrigin]),
      captureTimeout:500,
    });

    this.text.observe((_event,transaction)=>{
      if(this.destroyed) return;
      const source:CrdtTextSource=transaction.origin===REMOTE_ORIGIN ? 'remote' : 'local';
      this.callbacks.onText?.(this.text.toString(),source);
    });
    this.doc.on('update',(update:Uint8Array,origin:unknown)=>{
      if(this.destroyed || origin===REMOTE_ORIGIN || origin===SEED_ORIGIN) return;
      const copy=update.slice();
      if(this.captureUpdates) this.captureUpdates.push(copy);
      this.callbacks.onUpdate?.(copy);
    });
  }

  get value():string{return this.text.toString();}

  applyLocalText(next:string):boolean{
    if(this.destroyed) return false;
    const before=this.text.toString();
    const splice=singleSplice(before,next);
    if(!splice) return false;
    this.captureUpdates=[];
    try{
      this.doc.transact(()=>{
        if(splice.deleteCount) this.text.delete(splice.from,splice.deleteCount);
        if(splice.insert) this.text.insert(splice.from,splice.insert);
      },this.localOrigin);
      this.emitLocalTransaction(before);
    }finally{
      this.captureUpdates=null;
    }
    return true;
  }

  applyRemoteUpdate(update:Uint8Array):void{
    if(this.destroyed || update.byteLength===0) return;
    Y.applyUpdate(this.doc,update,REMOTE_ORIGIN);
  }

  stateVector():Uint8Array{return Y.encodeStateVector(this.doc);}

  stateUpdate(remoteStateVector?:Uint8Array):Uint8Array{
    return remoteStateVector ? Y.encodeStateAsUpdate(this.doc,remoteStateVector) : Y.encodeStateAsUpdate(this.doc);
  }

  undo():boolean{
    if(this.destroyed || this.undoManager.undoStack.length===0) return false;
    const before=this.text.toString();
    this.captureUpdates=[];
    try{
      this.undoManager.undo();
      this.emitLocalTransaction(before);
    }finally{
      this.captureUpdates=null;
    }
    return true;
  }

  redo():boolean{
    if(this.destroyed || this.undoManager.redoStack.length===0) return false;
    const before=this.text.toString();
    this.captureUpdates=[];
    try{
      this.undoManager.redo();
      this.emitLocalTransaction(before);
    }finally{
      this.captureUpdates=null;
    }
    return true;
  }

  private emitLocalTransaction(beforeText:string):void{
    const afterText=this.text.toString();
    const updates=this.captureUpdates?.map(update=>update.slice())??[];
    if(beforeText===afterText||!updates.length) return;
    this.callbacks.onLocalTransaction?.({beforeText,afterText,updates});
  }

  stopCapturing():void{this.undoManager.stopCapturing();}

  destroy():void{
    if(this.destroyed) return;
    this.destroyed=true;
    this.undoManager.destroy();
    this.doc.destroy();
  }
}

export function bytesToBase64(bytes:Uint8Array):string{
  let binary='';
  const chunk=0x8000;
  for(let offset=0;offset<bytes.length;offset+=chunk){
    binary+=String.fromCharCode(...bytes.subarray(offset,Math.min(bytes.length,offset+chunk)));
  }
  return btoa(binary);
}

export function base64ToBytes(value:string,maxBytes=768*1024):Uint8Array{
  if(typeof value!=='string' || value.length>Math.ceil(maxBytes/3)*4+8 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)){
    throw new Error('Invalid CRDT binary payload.');
  }
  const binary=atob(value);
  if(binary.length>maxBytes) throw new Error('CRDT binary payload exceeds the allowed size.');
  const bytes=new Uint8Array(binary.length);
  for(let index=0;index<binary.length;index++) bytes[index]=binary.charCodeAt(index);
  return bytes;
}
