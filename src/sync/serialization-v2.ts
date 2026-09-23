import { VaultError } from '../domain/errors.js';
import { asCanonicalId, canonicalIdFromEntry, entryIdFromCanonical } from '../domain/canonical.js';
import { markdownName, validateName } from '../domain/paths.js';
import type { Entry, EntryId, VaultId } from '../domain/model.js';
import type { VaultCryptoContext } from '../crypto/context.js';
import { sha256Hex } from '../crypto/primitives.js';
import type { LocalReplicaEntry } from './replica-store.js';
import type {
  EncryptedEntityMutation,
  NameToken,
  RemoteRevision,
} from './protocol-v2.js';
import type { EncryptedRemoteSnapshotV2 } from './remote-v2.js';

export const SYNC_ENTITY_PAYLOAD_VERSION = 1 as const;
export const SYNC_ENTITY_SCHEMA_VERSION = 1 as const;

interface SyncPayloadBaseV1 {
  format: 'vault/entity-payload/v1';
  version: typeof SYNC_ENTITY_PAYLOAD_VERSION;
  name: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface FolderPayloadV1 extends SyncPayloadBaseV1 {
  entityType: 'folder';
}

export interface NotePayloadV1 extends SyncPayloadBaseV1 {
  entityType: 'note';
  text: string;
}

export type SyncPlaintextPayloadV1 = FolderPayloadV1 | NotePayloadV1;

interface DecryptedSyncEntityBaseV2<T extends 'folder'|'note',P extends SyncPlaintextPayloadV1> {
  entityId: EntryId;
  vaultId: VaultId;
  entityType: T;
  remoteRevision: RemoteRevision;
  sequence: string;
  schemaVersion: number;
  parentId: EntryId | null;
  nameToken: NameToken;
  deleted: boolean;
  keyGeneration: number;
  payload: P;
  operationId: EncryptedRemoteSnapshotV2['operationId'];
  updatedByDevice: EncryptedRemoteSnapshotV2['updatedByDevice'];
  updatedAt: string;
  stateHash: string;
}

export type DecryptedFolderEntityV2 = DecryptedSyncEntityBaseV2<'folder',FolderPayloadV1>;
export type DecryptedNoteEntityV2 = DecryptedSyncEntityBaseV2<'note',NotePayloadV1>;
export type DecryptedSyncEntityV2 = DecryptedFolderEntityV2 | DecryptedNoteEntityV2;

export interface SerializedLocalEntityV2 {
  mutation: EncryptedEntityMutation;
  localVersion: number;
  plaintext: SyncPlaintextPayloadV1;
  stateHash: string;
}

const encoder=new TextEncoder();
const decoder=new TextDecoder('utf-8',{fatal:true});

function exactKeys(value:Record<string,unknown>,keys:readonly string[],label:string):void{
  const expected=new Set(keys);
  for(const key of Object.keys(value)){
    if(!expected.has(key)) throw new VaultError('PROTOCOL',label+' contains unsupported field: '+key+'.');
  }
  for(const key of keys){
    if(!(key in value)) throw new VaultError('PROTOCOL',label+' is missing required field: '+key+'.');
  }
}

function object(value:unknown,label:string):Record<string,unknown>{
  if(typeof value!=='object'||value===null||Array.isArray(value)) throw new VaultError('PROTOCOL',label+' is invalid.');
  return value as Record<string,unknown>;
}

function timestamp(value:unknown,label:string):string{
  if(typeof value!=='string'||!value.includes('T')||!Number.isFinite(Date.parse(value))){
    throw new VaultError('PROTOCOL',label+' is invalid.');
  }
  return value;
}

function deletedAt(value:unknown):string|null{
  if(value===null) return null;
  return timestamp(value,'Encrypted entity deletion time');
}

function payloadBytes(payload:SyncPlaintextPayloadV1):Uint8Array{
  return encoder.encode(JSON.stringify(payload));
}

async function stateHash(payload:SyncPlaintextPayloadV1,parentId:string|null,nameToken:NameToken,deleted:boolean):Promise<string>{
  return sha256Hex(encoder.encode(JSON.stringify([
    'vault/sync-state/v2',
    parentId ?? 'root',
    nameToken,
    deleted,
    payload,
  ])));
}

function plaintextForLocal(local:LocalReplicaEntry):SyncPlaintextPayloadV1{
  const entry=local.entry;
  if(entry.kind==='directory'){
    return {
      format:'vault/entity-payload/v1',
      version:SYNC_ENTITY_PAYLOAD_VERSION,
      entityType:'folder',
      name:validateName(entry.name),
      createdAt:timestamp(entry.createdAt,'Folder creation time'),
      updatedAt:timestamp(entry.updatedAt,'Folder update time'),
      deletedAt:entry.deletedAt===null?null:timestamp(entry.deletedAt,'Folder deletion time'),
    };
  }
  if(entry.kind==='markdown'){
    if(local.text===null) throw new VaultError('CORRUPT','Local Markdown bytes are unavailable.');
    const name=markdownName(entry.name);
    if(name!==entry.name) throw new VaultError('CORRUPT','Canonical Markdown filename is not normalized.');
    return {
      format:'vault/entity-payload/v1',
      version:SYNC_ENTITY_PAYLOAD_VERSION,
      entityType:'note',
      name,
      createdAt:timestamp(entry.createdAt,'Note creation time'),
      updatedAt:timestamp(entry.updatedAt,'Note update time'),
      deletedAt:entry.deletedAt===null?null:timestamp(entry.deletedAt,'Note deletion time'),
      text:local.text,
    };
  }
  throw new VaultError('UNSUPPORTED','I5 synchronizes Notes and Folders only. Attachment replication begins in I7.');
}

export async function serializeLocalEntityV2(input:{
  local:LocalReplicaEntry;
  crypto:VaultCryptoContext;
  baseRemoteRevision:RemoteRevision|null;
}):Promise<SerializedLocalEntityV2>{
  const {local,crypto,baseRemoteRevision}=input;
  const entry=local.entry;
  if(entry.vaultId!==crypto.vaultId) throw new VaultError('ACCOUNT_MISMATCH','Vault crypto context does not match the local entity.');
  const plaintext=plaintextForLocal(local);
  const entityType=plaintext.entityType;
  const entityId=canonicalIdFromEntry(entityType,entry.id);
  const parentId=entry.parentId;
  const canonicalParentId=parentId ? canonicalIdFromEntry('folder',parentId) : null;
  const nameToken=await crypto.nameToken(canonicalParentId,plaintext.name);
  const deleted=entry.deletedAt!==null;
  if(deleted!==(plaintext.deletedAt!==null)) throw new VaultError('CORRUPT','Local deletion state is inconsistent.');
  const encrypted=await crypto.encryptEntity({
    entityId,
    entityType,
    schemaVersion:SYNC_ENTITY_SCHEMA_VERSION,
    parentId:canonicalParentId,
    nameToken,
    deleted,
    blobId:null,
    plaintext:payloadBytes(plaintext),
  });
  const hash=await stateHash(plaintext,parentId,nameToken,deleted);
  return {
    localVersion:entry.localVersion,
    plaintext,
    stateHash:hash,
    mutation:{
      kind:'put',
      entityId,
      entityType,
      baseRemoteRevision,
      schemaVersion:SYNC_ENTITY_SCHEMA_VERSION,
      structural:{parentId:canonicalParentId,nameToken,deleted,blobId:null},
      payload:encrypted,
    },
  };
}

function parsePayload(bytes:Uint8Array,expected:'folder'):FolderPayloadV1;
function parsePayload(bytes:Uint8Array,expected:'note'):NotePayloadV1;
function parsePayload(bytes:Uint8Array,expected:'folder'|'note'):SyncPlaintextPayloadV1{
  let parsed:unknown;
  try{
    parsed=JSON.parse(decoder.decode(bytes)) as unknown;
  }catch{
    throw new VaultError('CORRUPT','Encrypted entity plaintext is not valid UTF-8 JSON.');
  }
  const row=object(parsed,'Encrypted entity plaintext');
  if(expected==='folder'){
    exactKeys(row,['format','version','entityType','name','createdAt','updatedAt','deletedAt'],'Encrypted folder plaintext');
  }else{
    exactKeys(row,['format','version','entityType','name','createdAt','updatedAt','deletedAt','text'],'Encrypted Note plaintext');
  }
  if(row.format!=='vault/entity-payload/v1'||row.version!==SYNC_ENTITY_PAYLOAD_VERSION||row.entityType!==expected){
    throw new VaultError('PROTOCOL','Encrypted entity plaintext format/type is invalid.');
  }
  const rawName=row.name;
  if(typeof rawName!=='string') throw new VaultError('PROTOCOL','Encrypted entity filename is invalid.');
  const name=expected==='note'?markdownName(rawName):validateName(rawName);
  if(name!==rawName) throw new VaultError('PROTOCOL','Encrypted entity filename is not canonical.');
  const base={
    format:'vault/entity-payload/v1' as const,
    version:SYNC_ENTITY_PAYLOAD_VERSION,
    entityType:expected,
    name,
    createdAt:timestamp(row.createdAt,'Encrypted entity creation time'),
    updatedAt:timestamp(row.updatedAt,'Encrypted entity update time'),
    deletedAt:deletedAt(row.deletedAt),
  };
  if(expected==='note'){
    if(typeof row.text!=='string') throw new VaultError('PROTOCOL','Encrypted Note Markdown is invalid.');
    return {...base,entityType:'note',text:row.text};
  }
  return {...base,entityType:'folder'};
}

export async function decryptRemoteEntityV2(input:{
  snapshot:EncryptedRemoteSnapshotV2;
  crypto:VaultCryptoContext;
}):Promise<DecryptedSyncEntityV2>{
  const {snapshot,crypto}=input;
  if(snapshot.vaultId!==crypto.vaultId) throw new VaultError('ACCOUNT_MISMATCH','Encrypted snapshot belongs to another Vault.');
  if(snapshot.entityType!=='folder'&&snapshot.entityType!=='note'){
    throw new VaultError('UNSUPPORTED','I5 accepts encrypted Note/Folder snapshots only.');
  }
  if(snapshot.payload.keyGeneration!==crypto.keyGeneration){
    throw new VaultError('PERMISSION','The selected Vault key generation cannot decrypt this entity.');
  }
  if(snapshot.structural.nameToken===null||snapshot.structural.blobId!==null){
    throw new VaultError('PROTOCOL','Encrypted Note/Folder structural metadata is invalid.');
  }
  const bytes=await crypto.decryptEntity({
    entityId:snapshot.entityId,
    entityType:snapshot.entityType,
    schemaVersion:snapshot.schemaVersion,
    parentId:snapshot.structural.parentId,
    nameToken:snapshot.structural.nameToken,
    deleted:snapshot.structural.deleted,
    blobId:null,
    payload:snapshot.payload,
  });
  const entityId=entryIdFromCanonical(asCanonicalId(snapshot.entityType,snapshot.entityId));
  const parentId=snapshot.structural.parentId
    ? entryIdFromCanonical(asCanonicalId('folder',snapshot.structural.parentId))
    : null;

  if(snapshot.entityType==='note'){
    const payload=parsePayload(bytes,'note');
    const expectedToken=await crypto.nameToken(snapshot.structural.parentId,payload.name);
    if(expectedToken!==snapshot.structural.nameToken){
      throw new VaultError('CORRUPT','Encrypted entity NameToken does not match its decrypted filename and parent.');
    }
    if(snapshot.structural.deleted!==(payload.deletedAt!==null)){
      throw new VaultError('CORRUPT','Encrypted entity deletion metadata does not match authenticated plaintext.');
    }
    return {
      entityId,
      vaultId:snapshot.vaultId,
      entityType:'note',
      remoteRevision:snapshot.remoteRevision,
      sequence:snapshot.sequence,
      schemaVersion:snapshot.schemaVersion,
      parentId,
      nameToken:snapshot.structural.nameToken,
      deleted:snapshot.structural.deleted,
      keyGeneration:snapshot.payload.keyGeneration,
      payload,
      operationId:snapshot.operationId,
      updatedByDevice:snapshot.updatedByDevice,
      updatedAt:snapshot.updatedAt,
      stateHash:await stateHash(payload,parentId,snapshot.structural.nameToken,snapshot.structural.deleted),
    };
  }

  const payload=parsePayload(bytes,'folder');
  const expectedToken=await crypto.nameToken(snapshot.structural.parentId,payload.name);
  if(expectedToken!==snapshot.structural.nameToken){
    throw new VaultError('CORRUPT','Encrypted entity NameToken does not match its decrypted filename and parent.');
  }
  if(snapshot.structural.deleted!==(payload.deletedAt!==null)){
    throw new VaultError('CORRUPT','Encrypted entity deletion metadata does not match authenticated plaintext.');
  }
  return {
    entityId,
    vaultId:snapshot.vaultId,
    entityType:'folder',
    remoteRevision:snapshot.remoteRevision,
    sequence:snapshot.sequence,
    schemaVersion:snapshot.schemaVersion,
    parentId,
    nameToken:snapshot.structural.nameToken,
    deleted:snapshot.structural.deleted,
    keyGeneration:snapshot.payload.keyGeneration,
    payload,
    operationId:snapshot.operationId,
    updatedByDevice:snapshot.updatedByDevice,
    updatedAt:snapshot.updatedAt,
    stateHash:await stateHash(payload,parentId,snapshot.structural.nameToken,snapshot.structural.deleted),
  };
}

export function localMatchesDecryptedV2(local:LocalReplicaEntry|null,remote:DecryptedSyncEntityV2):boolean{
  if(!local) return false;
  const entry=local.entry;
  const expectedKind=remote.entityType==='note'?'markdown':'directory';
  if(entry.id!==remote.entityId||entry.vaultId!==remote.vaultId||entry.kind!==expectedKind
    ||entry.parentId!==remote.parentId||entry.name!==remote.payload.name
    ||entry.createdAt!==remote.payload.createdAt||entry.updatedAt!==remote.payload.updatedAt
    ||entry.deletedAt!==remote.payload.deletedAt) return false;
  return remote.entityType==='note' ? local.text===remote.payload.text : true;
}

export function localEntityChangedSince(local:LocalReplicaEntry|null,expectedVersion:number):boolean{
  return !local || local.entry.localVersion!==expectedVersion;
}
