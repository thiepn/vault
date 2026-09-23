import { VaultError } from '../domain/errors.js';
import { ensureTaskIdentityMarkers } from '../tasks/markdown.js';
import type { EntryId, VaultId } from '../domain/model.js';
import { buildMarkdownConflictPlan } from './conflict-resolution.js';

export type SyncEntityTypeV2 = 'note' | 'folder';

export interface SyncEntityStateV2 {
  entryId: EntryId;
  vaultId: VaultId;
  entityType: SyncEntityTypeV2;
  parentId: EntryId | null;
  name: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  text: string | null;
}

export type SyncConflictKindV2 =
  | 'markdown'
  | 'structure'
  | 'delete-edit'
  | 'name'
  | 'parent'
  | 'concurrent-create';

export type ReconcileResultV2 =
  | { kind: 'remote'; state: SyncEntityStateV2 }
  | { kind: 'local'; state: SyncEntityStateV2 }
  | { kind: 'converged'; state: SyncEntityStateV2 }
  | { kind: 'merged'; state: SyncEntityStateV2 }
  | {
      kind: 'conflict';
      conflictKind: SyncConflictKindV2;
      base: SyncEntityStateV2 | null;
      local: SyncEntityStateV2;
      remote: SyncEntityStateV2;
      markdownConflictIds: readonly string[];
    };

function sameScalar<T>(left:T,right:T):boolean{
  return Object.is(left,right);
}

function authoredEqual(left:SyncEntityStateV2,right:SyncEntityStateV2):boolean{
  return left.entryId===right.entryId
    && left.vaultId===right.vaultId
    && left.entityType===right.entityType
    && left.parentId===right.parentId
    && left.name===right.name
    && (left.deletedAt===null)===(right.deletedAt===null)
    && left.text===right.text;
}

function changedFromBase(base:SyncEntityStateV2,side:SyncEntityStateV2):boolean{
  return !authoredEqual(base,side);
}

function changedIgnoringDeletion(base:SyncEntityStateV2,side:SyncEntityStateV2):boolean{
  return base.parentId!==side.parentId
    || base.name!==side.name
    || base.text!==side.text;
}

function mergeScalar<T>(base:T,local:T,remote:T):{ok:true;value:T}|{ok:false}{
  if(sameScalar(local,remote)) return {ok:true,value:local};
  if(sameScalar(local,base)) return {ok:true,value:remote};
  if(sameScalar(remote,base)) return {ok:true,value:local};
  return {ok:false};
}

function latestTimestamp(...values:(string|null|undefined)[]):string{
  const valid=values.filter((value):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value)));
  if(!valid.length) return new Date().toISOString();
  return valid.sort((a,b)=>Date.parse(a)-Date.parse(b)).at(-1)!;
}

function ensureCompatibleIdentity(base:SyncEntityStateV2|null,local:SyncEntityStateV2,remote:SyncEntityStateV2):void{
  if(local.vaultId!==remote.vaultId) throw new VaultError('ACCOUNT_MISMATCH','Multi-device reconciliation crossed Vault identity.');
  if(local.entityType!==remote.entityType) throw new VaultError('PROTOCOL','Multi-device reconciliation cannot change entity type.');
  if(base){
    if(base.entryId!==local.entryId||base.entryId!==remote.entryId
      ||base.vaultId!==local.vaultId||base.entityType!==local.entityType){
      throw new VaultError('PROTOCOL','Multi-device reconciliation base identity is inconsistent.');
    }
  }else if(local.entryId!==remote.entryId){
    // Different identities can collide by NameToken, but that is represented
    // as an explicit name conflict by the page/apply layer rather than diff3.
    throw new VaultError('PROTOCOL','Concurrent-create reconciliation requires the same entity identity.');
  }
  if(local.entityType==='folder'&&(local.text!==null||remote.text!==null||base?.text!==null)){
    throw new VaultError('CORRUPT','Folder reconciliation cannot contain Markdown content.');
  }
  if(local.entityType==='note'&&(local.text===null||remote.text===null||(base&&base.text===null))){
    throw new VaultError('CORRUPT','Note reconciliation requires exact Markdown snapshots.');
  }
}

/**
 * Deterministic BASE/LOCAL/REMOTE reconciliation for authored Note/Folder state.
 * Timestamps are provenance, never independent conflict dimensions.
 */
export function reconcileSyncEntityV2(
  base:SyncEntityStateV2|null,
  local:SyncEntityStateV2,
  remote:SyncEntityStateV2,
):ReconcileResultV2{
  ensureCompatibleIdentity(base,local,remote);

  if(!base){
    if(authoredEqual(local,remote)) return {kind:'converged',state:remote};
    return {
      kind:'conflict',
      conflictKind:'concurrent-create',
      base:null,
      local,
      remote,
      markdownConflictIds:[],
    };
  }

  if(authoredEqual(local,remote)) return {kind:'converged',state:remote};
  if(authoredEqual(local,base)) return {kind:'remote',state:remote};
  if(authoredEqual(remote,base)) return {kind:'local',state:local};

  const baseDeleted=base.deletedAt!==null;
  const localDeleted=local.deletedAt!==null;
  const remoteDeleted=remote.deletedAt!==null;
  const localDeletionChanged=localDeleted!==baseDeleted;
  const remoteDeletionChanged=remoteDeleted!==baseDeleted;

  if(localDeletionChanged && !remoteDeletionChanged && changedIgnoringDeletion(base,remote)){
    return {
      kind:'conflict',conflictKind:'delete-edit',base,local,remote,markdownConflictIds:[],
    };
  }
  if(remoteDeletionChanged && !localDeletionChanged && changedIgnoringDeletion(base,local)){
    return {
      kind:'conflict',conflictKind:'delete-edit',base,local,remote,markdownConflictIds:[],
    };
  }
  if(localDeletionChanged && remoteDeletionChanged && localDeleted!==remoteDeleted){
    return {
      kind:'conflict',conflictKind:'delete-edit',base,local,remote,markdownConflictIds:[],
    };
  }

  const deleted=mergeScalar(baseDeleted,localDeleted,remoteDeleted);
  const parent=mergeScalar(base.parentId,local.parentId,remote.parentId);
  const name=mergeScalar(base.name,local.name,remote.name);
  if(!deleted.ok||!parent.ok||!name.ok){
    const conflictKind:SyncConflictKindV2=!name.ok?'name':!parent.ok?'parent':'structure';
    return {kind:'conflict',conflictKind,base,local,remote,markdownConflictIds:[]};
  }

  let text:string|null=null;
  let markdownConflictIds:readonly string[]=[];
  if(base.entityType==='note'){
    const plan=buildMarkdownConflictPlan(base.text!,local.text!,remote.text!);
    if(plan.conflictIds.length){
      markdownConflictIds=plan.conflictIds;
      return {kind:'conflict',conflictKind:'markdown',base,local,remote,markdownConflictIds};
    }
    text=ensureTaskIdentityMarkers(plan.autoMergedText!,{usedIds:new Set<string>()}).text;
  }

  const deletionWinner=deleted.value
    ? (localDeleted&&!baseDeleted?local.deletedAt:remoteDeleted&&!baseDeleted?remote.deletedAt:local.deletedAt??remote.deletedAt)
    : null;
  const merged:SyncEntityStateV2={
    entryId:local.entryId,
    vaultId:local.vaultId,
    entityType:local.entityType,
    parentId:parent.value,
    name:name.value,
    createdAt:base.createdAt,
    updatedAt:latestTimestamp(local.updatedAt,remote.updatedAt),
    deletedAt:deletionWinner,
    text,
  };

  if(authoredEqual(merged,remote)) return {kind:'remote',state:remote};
  if(authoredEqual(merged,local)) return {kind:'local',state:local};
  return {kind:'merged',state:merged};
}

export function syncEntityChangedFromBaseV2(base:SyncEntityStateV2,side:SyncEntityStateV2):boolean{
  return changedFromBase(base,side);
}

export function syncEntityAuthoredEqualV2(left:SyncEntityStateV2,right:SyncEntityStateV2):boolean{
  return authoredEqual(left,right);
}
