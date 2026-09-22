import { VaultError } from '../domain/errors.js';
import { activeKey, markdownName, validateName } from '../domain/paths.js';
import { nextVersion } from '../domain/integrity.js';
import type { AttachmentContent, Entry, EntryId, MarkdownContent, VaultId } from '../domain/model.js';
import { validateAttachmentBytes, validateAttachmentName } from '../media/attachments.js';
import { sha256Hex } from '../storage/blob-store.js';
import { storageDriver, type LocalStorageDriver } from '../storage/driver.js';
import type { A2Persistence } from '../storage/a2-persistence.js';
import type { RemoteEntrySnapshot } from './remote-types.js';
import type { SyncRemoteShadow } from './local-state.js';

export interface LocalReplicaEntry {
  entry: Entry;
  text: string | null;
  attachment: AttachmentContent | null;
}

function entryName(snapshot: RemoteEntrySnapshot): string {
  if (snapshot.kind==='markdown') return markdownName(snapshot.name);
  if (snapshot.kind==='attachment') return validateAttachmentName(snapshot.name);
  return validateName(snapshot.name);
}

function shadowRecord(ownerId:string,epoch:string,snapshot:RemoteEntrySnapshot):SyncRemoteShadow{
  return {
    entryId:snapshot.entryId,
    vaultId:snapshot.vaultId,
    ownerId,
    epoch,
    snapshot:structuredClone(snapshot),
    updatedAt:new Date().toISOString(),
  };
}

export class SyncReplicaStore {
  private readonly driver:LocalStorageDriver;
  constructor(
    database:IDBDatabase|LocalStorageDriver,
    private readonly a2?:Pick<A2Persistence,'syncEntry'|'markRepairNeeded'>,
  ){
    this.driver=storageDriver(database);
  }

  async read(entryId:EntryId):Promise<LocalReplicaEntry|null>{
    return this.driver.transaction(['entries','contents','attachments'],'readonly',async tx=>{
      const entry=await tx.store('entries').get<Entry>(entryId);
      if(!entry) return null;
      const content=entry.kind==='markdown' ? await tx.store('contents').get<MarkdownContent>(entryId) : undefined;
      const attachment=entry.kind==='attachment' ? await tx.store('attachments').get<AttachmentContent>(entryId) : undefined;
      if(entry.kind==='markdown' && (!content || content.localVersion!==entry.localVersion)) throw new VaultError('CORRUPT','Local Markdown replica is inconsistent.');
      if(entry.kind==='attachment' && (!attachment || attachment.size!==attachment.bytes.byteLength)) throw new VaultError('CORRUPT','Local attachment replica is inconsistent.');
      return {entry,text:content?.text ?? null,attachment:attachment ?? null};
    });
  }

  async matches(snapshot:RemoteEntrySnapshot):Promise<boolean>{
    const local=await this.read(snapshot.entryId);
    if(!local) return false;
    const {entry}=local;
    if(entry.vaultId!==snapshot.vaultId || entry.parentId!==snapshot.parentId || entry.name!==snapshot.name
      || entry.kind!==snapshot.kind || (entry.deletedAt===null)!==(snapshot.deletedAt===null)) return false;
    if(entry.kind==='markdown') return local.text===snapshot.text;
    if(entry.kind==='attachment'){
      if(!local.attachment || snapshot.attachmentSha256===null || snapshot.attachmentSize===null || snapshot.attachmentMimeType===null) return false;
      if(local.attachment.size!==snapshot.attachmentSize || local.attachment.mimeType!==snapshot.attachmentMimeType) return false;
      return await sha256Hex(local.attachment.bytes)===snapshot.attachmentSha256;
    }
    return true;
  }

  async needsAttachmentBytes(snapshot:RemoteEntrySnapshot, previous:SyncRemoteShadow|null):Promise<boolean>{
    if(snapshot.kind!=='attachment' || snapshot.attachmentSha256===null) return false;
    const local=await this.read(snapshot.entryId);
    if(!local?.attachment) return true;
    if(previous?.snapshot.kind==='attachment' && previous.snapshot.attachmentSha256===snapshot.attachmentSha256) return false;
    return await sha256Hex(local.attachment.bytes)!==snapshot.attachmentSha256;
  }

  async apply(ownerId:string,epoch:string,snapshot:RemoteEntrySnapshot,attachmentBytes?:Uint8Array):Promise<void>{
    const name=entryName(snapshot);
    if(snapshot.kind==='attachment'){
      if(snapshot.attachmentSha256===null || snapshot.attachmentMimeType===null || snapshot.attachmentSize===null) throw new VaultError('PROTOCOL','Remote attachment snapshot is incomplete.');
      if(attachmentBytes){
        validateAttachmentBytes(attachmentBytes);
        if(attachmentBytes.byteLength!==snapshot.attachmentSize || await sha256Hex(attachmentBytes)!==snapshot.attachmentSha256) {
          throw new VaultError('CORRUPT','Downloaded attachment bytes do not match the remote snapshot.');
        }
      }
    }

    await this.driver.transaction(['vaults','entries','contents','attachments','dirty','remoteShadows'],'readwrite',async tx=>{
      if(!await tx.store('vaults').get(snapshot.vaultId)) throw new VaultError('NOT_FOUND','The local cloud Vault no longer exists.');
      const existing=await tx.store('entries').get<Entry>(snapshot.entryId);
      if(existing && (existing.vaultId!==snapshot.vaultId || existing.kind!==snapshot.kind)) throw new VaultError('PROTOCOL','Remote entry identity conflicts with a different local entry.');
      if(snapshot.parentId){
        const parent=await tx.store('entries').get<Entry>(snapshot.parentId);
        if(!parent || parent.vaultId!==snapshot.vaultId || parent.kind!=='directory' || parent.deletedAt!==null) {
          throw new VaultError('INVALID_PARENT','Remote entry references a folder that has not been synchronized yet.');
        }
      }

      const key=snapshot.deletedAt===null ? activeKey(snapshot.vaultId,snapshot.parentId,name) : undefined;
      if(key){
        const collision=await tx.store('entries').fromIndex<Entry>('activeKey',key);
        if(collision && collision.id!==snapshot.entryId) throw new VaultError('COLLISION','Remote change collides with an unsynchronized local path.');
      }

      const localVersion=existing ? nextVersion(existing.localVersion) : 1;
      const updated:Entry={
        id:snapshot.entryId,
        vaultId:snapshot.vaultId,
        parentId:snapshot.parentId,
        name,
        kind:snapshot.kind,
        createdAt:existing?.createdAt ?? snapshot.updatedAt,
        updatedAt:snapshot.updatedAt,
        localVersion,
        deletedAt:snapshot.deletedAt,
        deletionBatch:null,
        ...(key ? {activeKey:key} : {}),
      };
      await tx.store('entries').put(updated);

      if(snapshot.kind==='markdown'){
        await tx.store('contents').put({entryId:snapshot.entryId,text:snapshot.text!,localVersion} satisfies MarkdownContent);
        await tx.store('attachments').delete(snapshot.entryId);
      } else if(snapshot.kind==='attachment'){
        let bytes=attachmentBytes;
        if(!bytes){
          const existingAttachment=await tx.store('attachments').get<AttachmentContent>(snapshot.entryId);
          if(!existingAttachment) throw new VaultError('CORRUPT','Remote attachment bytes were not downloaded.');
          bytes=existingAttachment.bytes;
        }
        await tx.store('attachments').put({
          entryId:snapshot.entryId,
          vaultId:snapshot.vaultId,
          mimeType:snapshot.attachmentMimeType!,
          size:bytes.byteLength,
          bytes:bytes.slice(),
        } satisfies AttachmentContent);
        await tx.store('contents').delete(snapshot.entryId);
      } else {
        await tx.store('contents').delete(snapshot.entryId);
        await tx.store('attachments').delete(snapshot.entryId);
      }

      await tx.store('dirty').delete(snapshot.entryId);
      await tx.store('remoteShadows').put(shadowRecord(ownerId,epoch,snapshot));
    });

    if(this.a2){
      try { await this.a2.syncEntry(snapshot.entryId); }
      catch(error){ await this.a2.markRepairNeeded(error).catch(()=>undefined); }
    }
  }

  async recordShadow(ownerId:string,epoch:string,snapshot:RemoteEntrySnapshot):Promise<void>{
    await this.driver.transaction(['remoteShadows'],'readwrite',tx=>tx.store('remoteShadows').put(shadowRecord(ownerId,epoch,snapshot)));
  }

  async clearDirtyIfMatched(snapshot:RemoteEntrySnapshot):Promise<boolean>{
    if(!await this.matches(snapshot)) return false;
    await this.driver.transaction(['dirty'],'readwrite',tx=>tx.store('dirty').delete(snapshot.entryId));
    return true;
  }

  async localAttachmentHash(entryId:EntryId):Promise<{sha256:string;mimeType:string;size:number;bytes:Uint8Array}>{
    const local=await this.read(entryId);
    if(!local || local.entry.kind!=='attachment' || !local.attachment) throw new VaultError('NOT_FOUND','Local attachment is unavailable.');
    return {
      sha256:await sha256Hex(local.attachment.bytes),
      mimeType:local.attachment.mimeType,
      size:local.attachment.size,
      bytes:local.attachment.bytes.slice(),
    };
  }

  async listDirty(vaultId:VaultId):Promise<import('../domain/model.js').DirtyEntry[]>{
    return this.driver.transaction(['dirty'],'readonly',tx=>tx.store('dirty').allFromIndex('vaultId',vaultId));
  }
}
