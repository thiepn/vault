import { VaultError } from '../domain/errors.js';
import { asCanonicalId, canonicalIdFromEntry, entryIdFromCanonical } from '../domain/canonical.js';
import { markdownName, validateName } from '../domain/paths.js';
import type { EntryId, VaultId } from '../domain/model.js';
import type { VaultCryptoContext } from '../crypto/context.js';
import { bytesToHex } from '../crypto/encoding.js';
import { sha256, sha256Hex } from '../crypto/primitives.js';
import {
  MAX_ATTACHMENT_BYTES,
  normalizeAttachmentMimeType,
  validateAttachmentBytes,
  validateAttachmentName,
} from '../media/attachments.js';
import type { LocalReplicaEntry } from './replica-store.js';
import type {
  EncryptedEntityMutation,
  NameToken,
  RemoteBlobId,
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

export interface AttachmentPayloadV1 extends SyncPayloadBaseV1 {
  entityType: 'attachment';
  mimeType: string;
  size: number;
  plaintextSha256: string;
}

export type SyncPlaintextPayloadV1 = FolderPayloadV1 | NotePayloadV1 | AttachmentPayloadV1;

interface DecryptedSyncEntityBaseV2<
  T extends 'folder'|'note'|'attachment',
  P extends SyncPlaintextPayloadV1,
> {
  entityId: EntryId;
  vaultId: VaultId;
  entityType: T;
  remoteRevision: RemoteRevision;
  sequence: string;
  schemaVersion: number;
  parentId: EntryId | null;
  nameToken: NameToken;
  blobId: RemoteBlobId | null;
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
export type DecryptedAttachmentEntityV2 = DecryptedSyncEntityBaseV2<'attachment',AttachmentPayloadV1> & {
  blobId: RemoteBlobId;
};
export type DecryptedSyncEntityV2 =
  | DecryptedFolderEntityV2
  | DecryptedNoteEntityV2
  | DecryptedAttachmentEntityV2;

export interface SerializedLocalBlobV2 {
  blobId: RemoteBlobId;
  plaintextSha256: string;
  plaintextSize: number;
  bytes: Uint8Array;
}

export interface SerializedLocalEntityV2 {
  mutation: EncryptedEntityMutation;
  localVersion: number;
  plaintext: SyncPlaintextPayloadV1;
  stateHash: string;
  blob: SerializedLocalBlobV2 | null;
}

const encoder=new TextEncoder();
const decoder=new TextDecoder('utf-8',{fatal:true});
const sha256Pattern=/^[0-9a-f]{64}$/u;

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

async function stateHash(
  payload:SyncPlaintextPayloadV1,
  parentId:string|null,
  nameToken:NameToken,
  deleted:boolean,
):Promise<string>{
  return sha256Hex(encoder.encode(JSON.stringify([
    'vault/sync-state/v2',
    parentId ?? 'root',
    nameToken,
    deleted,
    payload,
  ])));
}

async function plaintextForLocal(
  local:LocalReplicaEntry,
  crypto:VaultCryptoContext,
):Promise<{payload:SyncPlaintextPayloadV1;blob:SerializedLocalBlobV2|null}>{
  const entry=local.entry;
  if(entry.kind==='directory'){
    return {
      payload:{
        format:'vault/entity-payload/v1',
        version:SYNC_ENTITY_PAYLOAD_VERSION,
        entityType:'folder',
        name:validateName(entry.name),
        createdAt:timestamp(entry.createdAt,'Folder creation time'),
        updatedAt:timestamp(entry.updatedAt,'Folder update time'),
        deletedAt:entry.deletedAt===null?null:timestamp(entry.deletedAt,'Folder deletion time'),
      },
      blob:null,
    };
  }
  if(entry.kind==='markdown'){
    if(local.text===null) throw new VaultError('CORRUPT','Local Markdown bytes are unavailable.');
    const name=markdownName(entry.name);
    if(name!==entry.name) throw new VaultError('CORRUPT','Canonical Markdown filename is not normalized.');
    return {
      payload:{
        format:'vault/entity-payload/v1',
        version:SYNC_ENTITY_PAYLOAD_VERSION,
        entityType:'note',
        name,
        createdAt:timestamp(entry.createdAt,'Note creation time'),
        updatedAt:timestamp(entry.updatedAt,'Note update time'),
        deletedAt:entry.deletedAt===null?null:timestamp(entry.deletedAt,'Note deletion time'),
        text:local.text,
      },
      blob:null,
    };
  }

  if(!local.attachment) throw new VaultError('CORRUPT','Local attachment bytes are unavailable.');
  validateAttachmentBytes(local.attachment.bytes);
  if(local.attachment.entryId!==entry.id||local.attachment.vaultId!==entry.vaultId
    ||local.attachment.size!==local.attachment.bytes.byteLength){
    throw new VaultError('CORRUPT','Local attachment metadata is inconsistent.');
  }
  const name=validateAttachmentName(entry.name);
  if(name!==entry.name) throw new VaultError('CORRUPT','Canonical attachment filename is not normalized.');
  const mimeType=normalizeAttachmentMimeType(name,local.attachment.mimeType);
  if(mimeType!==local.attachment.mimeType){
    throw new VaultError('CORRUPT','Canonical attachment MIME type is not normalized.');
  }
  const digest=await sha256(local.attachment.bytes);
  const plaintextSha256=bytesToHex(digest);
  const blobId=await crypto.blobId(digest);
  return {
    payload:{
      format:'vault/entity-payload/v1',
      version:SYNC_ENTITY_PAYLOAD_VERSION,
      entityType:'attachment',
      name,
      createdAt:timestamp(entry.createdAt,'Attachment creation time'),
      updatedAt:timestamp(entry.updatedAt,'Attachment update time'),
      deletedAt:entry.deletedAt===null?null:timestamp(entry.deletedAt,'Attachment deletion time'),
      mimeType,
      size:local.attachment.size,
      plaintextSha256,
    },
    blob:{
      blobId,
      plaintextSha256,
      plaintextSize:local.attachment.size,
      bytes:local.attachment.bytes.slice(),
    },
  };
}

export async function serializeLocalEntityV2(input:{
  local:LocalReplicaEntry;
  crypto:VaultCryptoContext;
  baseRemoteRevision:RemoteRevision|null;
}):Promise<SerializedLocalEntityV2>{
  const {local,crypto,baseRemoteRevision}=input;
  const entry=local.entry;
  if(entry.vaultId!==crypto.vaultId) throw new VaultError('ACCOUNT_MISMATCH','Vault crypto context does not match the local entity.');
  const prepared=await plaintextForLocal(local,crypto);
  const plaintext=prepared.payload;
  const entityType=plaintext.entityType;
  const entityId=canonicalIdFromEntry(entityType,entry.id);
  const parentId=entry.parentId;
  const canonicalParentId=parentId ? canonicalIdFromEntry('folder',parentId) : null;
  const nameToken=await crypto.nameToken(canonicalParentId,plaintext.name);
  const deleted=entry.deletedAt!==null;
  if(deleted!==(plaintext.deletedAt!==null)) throw new VaultError('CORRUPT','Local deletion state is inconsistent.');
  const blobId=prepared.blob?.blobId ?? null;
  const encrypted=await crypto.encryptEntity({
    entityId,
    entityType,
    schemaVersion:SYNC_ENTITY_SCHEMA_VERSION,
    parentId:canonicalParentId,
    nameToken,
    deleted,
    blobId,
    plaintext:payloadBytes(plaintext),
  });
  const hash=await stateHash(plaintext,parentId,nameToken,deleted);
  return {
    localVersion:entry.localVersion,
    plaintext,
    stateHash:hash,
    blob:prepared.blob,
    mutation:{
      kind:'put',
      entityId,
      entityType,
      baseRemoteRevision,
      schemaVersion:SYNC_ENTITY_SCHEMA_VERSION,
      structural:{parentId:canonicalParentId,nameToken,deleted,blobId},
      payload:encrypted,
    },
  };
}

function parsePayload(bytes:Uint8Array,expected:'folder'):FolderPayloadV1;
function parsePayload(bytes:Uint8Array,expected:'note'):NotePayloadV1;
function parsePayload(bytes:Uint8Array,expected:'attachment'):AttachmentPayloadV1;
function parsePayload(
  bytes:Uint8Array,
  expected:'folder'|'note'|'attachment',
):SyncPlaintextPayloadV1{
  let parsed:unknown;
  try{
    parsed=JSON.parse(decoder.decode(bytes)) as unknown;
  }catch{
    throw new VaultError('CORRUPT','Encrypted entity plaintext is not valid UTF-8 JSON.');
  }
  const row=object(parsed,'Encrypted entity plaintext');
  if(expected==='folder'){
    exactKeys(row,['format','version','entityType','name','createdAt','updatedAt','deletedAt'],'Encrypted folder plaintext');
  }else if(expected==='note'){
    exactKeys(row,['format','version','entityType','name','createdAt','updatedAt','deletedAt','text'],'Encrypted Note plaintext');
  }else{
    exactKeys(
      row,
      ['format','version','entityType','name','createdAt','updatedAt','deletedAt','mimeType','size','plaintextSha256'],
      'Encrypted attachment plaintext',
    );
  }
  if(row.format!=='vault/entity-payload/v1'||row.version!==SYNC_ENTITY_PAYLOAD_VERSION||row.entityType!==expected){
    throw new VaultError('PROTOCOL','Encrypted entity plaintext format/type is invalid.');
  }
  const rawName=row.name;
  if(typeof rawName!=='string') throw new VaultError('PROTOCOL','Encrypted entity filename is invalid.');
  const name=expected==='note'
    ? markdownName(rawName)
    : expected==='attachment'
      ? validateAttachmentName(rawName)
      : validateName(rawName);
  if(name!==rawName) throw new VaultError('PROTOCOL','Encrypted entity filename is not canonical.');
  const base={
    format:'vault/entity-payload/v1' as const,
    version:SYNC_ENTITY_PAYLOAD_VERSION,
    name,
    createdAt:timestamp(row.createdAt,'Encrypted entity creation time'),
    updatedAt:timestamp(row.updatedAt,'Encrypted entity update time'),
    deletedAt:deletedAt(row.deletedAt),
  };
  if(expected==='note'){
    if(typeof row.text!=='string') throw new VaultError('PROTOCOL','Encrypted Note Markdown is invalid.');
    return {...base,entityType:'note',text:row.text};
  }
  if(expected==='attachment'){
    if(typeof row.mimeType!=='string'||normalizeAttachmentMimeType(name,row.mimeType)!==row.mimeType){
      throw new VaultError('PROTOCOL','Encrypted attachment MIME type is invalid.');
    }
    if(typeof row.size!=='number'||!Number.isSafeInteger(row.size)||row.size<0||row.size>MAX_ATTACHMENT_BYTES){
      throw new VaultError('PROTOCOL','Encrypted attachment size is invalid.');
    }
    if(typeof row.plaintextSha256!=='string'||!sha256Pattern.test(row.plaintextSha256)){
      throw new VaultError('PROTOCOL','Encrypted attachment plaintext hash is invalid.');
    }
    return {
      ...base,
      entityType:'attachment',
      mimeType:row.mimeType,
      size:row.size,
      plaintextSha256:row.plaintextSha256,
    };
  }
  return {...base,entityType:'folder'};
}

export async function decryptRemoteEntityV2(input:{
  snapshot:EncryptedRemoteSnapshotV2;
  crypto:VaultCryptoContext;
}):Promise<DecryptedSyncEntityV2>{
  const {snapshot,crypto}=input;
  if(snapshot.vaultId!==crypto.vaultId) throw new VaultError('ACCOUNT_MISMATCH','Encrypted snapshot belongs to another Vault.');
  if(snapshot.entityType!=='folder'&&snapshot.entityType!=='note'&&snapshot.entityType!=='attachment'){
    throw new VaultError('UNSUPPORTED','Protocol v2 browser sync accepts encrypted Note/Folder/Attachment snapshots only.');
  }
  if(snapshot.payload.keyGeneration!==crypto.keyGeneration){
    throw new VaultError('PERMISSION','The selected Vault key generation cannot decrypt this entity.');
  }
  if(snapshot.structural.nameToken===null){
    throw new VaultError('PROTOCOL','Encrypted filesystem entity is missing its NameToken.');
  }
  const attachment=snapshot.entityType==='attachment';
  if(attachment!==(snapshot.structural.blobId!==null)){
    throw new VaultError('PROTOCOL','Encrypted attachment BlobId structural metadata is invalid.');
  }
  const bytes=await crypto.decryptEntity({
    entityId:snapshot.entityId,
    entityType:snapshot.entityType,
    schemaVersion:snapshot.schemaVersion,
    parentId:snapshot.structural.parentId,
    nameToken:snapshot.structural.nameToken,
    deleted:snapshot.structural.deleted,
    blobId:snapshot.structural.blobId,
    payload:snapshot.payload,
  });
  const entityId=entryIdFromCanonical(asCanonicalId(snapshot.entityType,snapshot.entityId));
  const parentId=snapshot.structural.parentId
    ? entryIdFromCanonical(asCanonicalId('folder',snapshot.structural.parentId))
    : null;
  const payload=parsePayload(bytes,snapshot.entityType);
  const expectedToken=await crypto.nameToken(snapshot.structural.parentId,payload.name);
  if(expectedToken!==snapshot.structural.nameToken){
    throw new VaultError('CORRUPT','Encrypted entity NameToken does not match its decrypted filename and parent.');
  }
  if(snapshot.structural.deleted!==(payload.deletedAt!==null)){
    throw new VaultError('CORRUPT','Encrypted entity deletion metadata does not match authenticated plaintext.');
  }

  const common={
    entityId,
    vaultId:snapshot.vaultId,
    remoteRevision:snapshot.remoteRevision,
    sequence:snapshot.sequence,
    schemaVersion:snapshot.schemaVersion,
    parentId,
    nameToken:snapshot.structural.nameToken,
    deleted:snapshot.structural.deleted,
    keyGeneration:snapshot.payload.keyGeneration,
    operationId:snapshot.operationId,
    updatedByDevice:snapshot.updatedByDevice,
    updatedAt:snapshot.updatedAt,
    stateHash:await stateHash(payload,parentId,snapshot.structural.nameToken,snapshot.structural.deleted),
  };

  if(snapshot.entityType==='note'){
    return {...common,entityType:'note',blobId:null,payload:payload as NotePayloadV1};
  }
  if(snapshot.entityType==='attachment'){
    const blobId=snapshot.structural.blobId;
    if(!blobId) throw new VaultError('PROTOCOL','Encrypted attachment snapshot is missing BlobId.');
    const attachmentPayload=payload as AttachmentPayloadV1;
    const expectedBlobId=await crypto.blobId(
      Uint8Array.from(attachmentPayload.plaintextSha256.match(/../gu)!.map(pair=>Number.parseInt(pair,16))),
    );
    if(expectedBlobId!==blobId){
      throw new VaultError('CORRUPT','Encrypted attachment BlobId does not match its authenticated plaintext hash.');
    }
    return {...common,entityType:'attachment',blobId,payload:attachmentPayload};
  }
  return {...common,entityType:'folder',blobId:null,payload:payload as FolderPayloadV1};
}

export function localMatchesDecryptedV2(local:LocalReplicaEntry|null,remote:DecryptedSyncEntityV2):boolean{
  if(!local) return false;
  const entry=local.entry;
  const expectedKind=remote.entityType==='note'
    ? 'markdown'
    : remote.entityType==='attachment'
      ? 'attachment'
      : 'directory';
  if(entry.id!==remote.entityId||entry.vaultId!==remote.vaultId||entry.kind!==expectedKind
    ||entry.parentId!==remote.parentId||entry.name!==remote.payload.name
    ||entry.createdAt!==remote.payload.createdAt||entry.updatedAt!==remote.payload.updatedAt
    ||entry.deletedAt!==remote.payload.deletedAt) return false;
  if(remote.entityType==='note') return local.text===remote.payload.text;
  if(remote.entityType==='attachment'){
    return !!local.attachment
      &&local.attachment.size===remote.payload.size
      &&local.attachment.mimeType===remote.payload.mimeType
      &&local.attachment.bytes.byteLength===remote.payload.size;
  }
  return true;
}

export function localEntityChangedSince(local:LocalReplicaEntry|null,expectedVersion:number):boolean{
  return !local || local.entry.localVersion!==expectedVersion;
}
