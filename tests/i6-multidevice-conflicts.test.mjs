import test from 'node:test';
import assert from 'node:assert/strict';
import { activeKey } from '../build/core/domain/paths.js';
import {
  reconcileSyncEntityV2,
} from '../build/core/sync/reconcile-v2.js';
import {
  EncryptedReplicaStoreV2,
} from '../build/core/sync/replica-store-v2.js';
import {
  SyncConflictStoreV2,
  validateSyncConflictV2,
} from '../build/core/sync/conflict-store-v2.js';

const accountId='11111111-1111-4111-8111-111111111111';
const vaultId='22222222-2222-4222-8222-222222222222';
const deviceA='33333333-3333-4333-8333-333333333333';
const deviceB='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const epoch='44444444-4444-4444-8444-444444444444';
const noteId='55555555-5555-4555-8555-555555555555';
const noteOther='66666666-6666-4666-8666-666666666666';
const folderA='77777777-7777-4777-8777-777777777777';
const folderB='88888888-8888-4888-8888-888888888888';
const token='N'.repeat(43);
const hash='a'.repeat(64);
const at='2026-09-23T12:00:00.000Z';

function noteState(overrides={}){
  return {
    entryId:noteId,
    vaultId,
    entityType:'note',
    parentId:null,
    name:'Merge.md',
    createdAt:at,
    updatedAt:at,
    deletedAt:null,
    text:'alpha\n\nbeta\n\ngamma\n',
    ...overrides,
  };
}
function folderState(overrides={}){
  return {
    entryId:folderA,
    vaultId,
    entityType:'folder',
    parentId:null,
    name:'Folder',
    createdAt:at,
    updatedAt:at,
    deletedAt:null,
    text:null,
    ...overrides,
  };
}

test('I6 non-overlapping Markdown edits auto-merge without conflict markers',()=>{
  const base=noteState();
  const local=noteState({text:'alpha local\n\nbeta\n\ngamma\n',updatedAt:'2026-09-23T12:01:00.000Z'});
  const remote=noteState({text:'alpha\n\nbeta\n\ngamma remote\n',updatedAt:'2026-09-23T12:02:00.000Z'});
  const result=reconcileSyncEntityV2(base,local,remote);
  assert.equal(result.kind,'merged');
  assert.match(result.state.text,/alpha local/);
  assert.match(result.state.text,/gamma remote/);
  assert.doesNotMatch(result.state.text,/<<<<<<<|=======|>>>>>>>/u);
});

test('I6 overlapping Markdown edits remain explicit conflicts',()=>{
  const base=noteState();
  const local=noteState({text:'alpha LOCAL\n\nbeta\n\ngamma\n'});
  const remote=noteState({text:'alpha REMOTE\n\nbeta\n\ngamma\n'});
  const result=reconcileSyncEntityV2(base,local,remote);
  assert.equal(result.kind,'conflict');
  assert.equal(result.conflictKind,'markdown');
  assert.ok(result.markdownConflictIds.length>0);
});

test('I6 overlapping YAML frontmatter edits are never silently semantically merged',()=>{
  const base=noteState({text:'---\nstatus: open\n---\n\nBody\n'});
  const local=noteState({text:'---\nstatus: local\n---\n\nBody\n'});
  const remote=noteState({text:'---\nstatus: remote\n---\n\nBody\n'});
  const result=reconcileSyncEntityV2(base,local,remote);
  assert.equal(result.kind,'conflict');
  assert.equal(result.conflictKind,'markdown');
});

test('I6 rename plus remote body edit and move plus body edit auto-merge independently',()=>{
  const base=noteState({parentId:folderA});
  const renamed=noteState({parentId:folderA,name:'Renamed.md'});
  const remoteBody=noteState({parentId:folderA,text:'alpha\n\nbeta remote\n\ngamma\n'});
  const renameResult=reconcileSyncEntityV2(base,renamed,remoteBody);
  assert.equal(renameResult.kind,'merged');
  assert.equal(renameResult.state.name,'Renamed.md');
  assert.match(renameResult.state.text,/beta remote/);

  const moved=noteState({parentId:folderB});
  const moveResult=reconcileSyncEntityV2(base,moved,remoteBody);
  assert.equal(moveResult.kind,'merged');
  assert.equal(moveResult.state.parentId,folderB);
  assert.match(moveResult.state.text,/beta remote/);
});

test('I6 divergent rename and move remain explicit structural conflicts',()=>{
  const base=noteState({parentId:folderA});
  const rename=reconcileSyncEntityV2(
    base,
    noteState({parentId:folderA,name:'Local.md'}),
    noteState({parentId:folderA,name:'Remote.md'}),
  );
  assert.equal(rename.kind,'conflict');
  assert.equal(rename.conflictKind,'name');

  const move=reconcileSyncEntityV2(
    base,
    noteState({parentId:folderB}),
    noteState({parentId:folderA}),
  );
  // remote == base in this case, so local move wins.
  assert.equal(move.kind,'local');

  const baseMoved=noteState({parentId:folderA});
  const trueMoveConflict=reconcileSyncEntityV2(
    baseMoved,
    noteState({parentId:folderB}),
    noteState({parentId:noteOther}),
  );
  assert.equal(trueMoveConflict.kind,'conflict');
  assert.equal(trueMoveConflict.conflictKind,'parent');
});

test('I6 delete/edit conflicts preserve both sides while delete/delete converges',()=>{
  const base=noteState();
  const deleted=noteState({deletedAt:'2026-09-23T13:00:00.000Z'});
  const edited=noteState({text:'alpha changed\n\nbeta\n\ngamma\n'});
  const conflict=reconcileSyncEntityV2(base,deleted,edited);
  assert.equal(conflict.kind,'conflict');
  assert.equal(conflict.conflictKind,'delete-edit');

  const both=reconcileSyncEntityV2(
    base,
    deleted,
    noteState({deletedAt:'2026-09-23T14:00:00.000Z'}),
  );
  assert.notEqual(both.kind,'conflict');
  assert.notEqual(both.state.deletedAt,null);
});

test('I6 merged Markdown preserves and de-duplicates embedded Task identities',()=>{
  const task='123e4567-e89b-7d12-a456-426614174000';
  const base=noteState({text:`# Tasks\n\n- [ ] one <!-- vault:task=${task} -->\n\nEnd\n`});
  const local=noteState({text:`# Tasks local\n\n- [ ] one <!-- vault:task=${task} -->\n\nEnd\n`});
  const remote=noteState({text:`# Tasks\n\n- [ ] one <!-- vault:task=${task} -->\n\nEnd remote\n`});
  const result=reconcileSyncEntityV2(base,local,remote);
  assert.equal(result.kind,'merged');
  const ids=[...result.state.text.matchAll(/vault:task=([0-9a-f-]+)/gu)].map(match=>match[1]);
  assert.equal(new Set(ids).size,ids.length);
  assert.ok(ids.includes(task));
});

function keyFor(store,value){
  switch(store){
    case 'vaults': case 'entries': case 'outbox': case 'revisions': case 'drafts':
    case 'migrationState': case 'backgroundRuntime': case 'remoteInbox': case 'conflicts':
    case 'syncConflicts': case 'entities': return value.id;
    case 'contents': case 'attachments': case 'dirty': case 'remoteShadows': return value.entryId;
    case 'syncCursors': return value.vaultId;
    case 'settings': return value.key;
    case 'noteBodies': return value.noteId;
    case 'blobPayloads': return value.hash;
    case 'knowledge': return value.entryId;
    default: return value.id ?? value.key;
  }
}
function indexValue(value,index){
  if(index==='vaultId') return value.vaultId;
  if(index==='activeKey') return value.activeKey;
  if(index==='entryId') return value.entryId;
  if(index==='status') return value.status;
  if(index==='vaultEntry') return [value.vaultId,value.entryId];
  return value[index];
}
class MemoryStore{
  constructor(data,name){this.data=data;this.name=name;}
  async get(key){const v=this.data.get(JSON.stringify(key))??this.data.get(key);return v===undefined?undefined:structuredClone(v);}
  async getAll(){return [...this.data.values()].map(value=>structuredClone(value));}
  async fromIndex(index,key){
    const v=[...this.data.values()].find(row=>{
      const actual=indexValue(row,index);
      return Array.isArray(actual)?JSON.stringify(actual)===JSON.stringify(key):actual===key;
    });
    return v===undefined?undefined:structuredClone(v);
  }
  async allFromIndex(index,key){
    return [...this.data.values()].filter(row=>{
      const actual=indexValue(row,index);
      return Array.isArray(actual)?JSON.stringify(actual)===JSON.stringify(key):actual===key;
    }).map(value=>structuredClone(value));
  }
  async add(value){
    const key=keyFor(this.name,value);
    if(this.data.has(key)) throw new Error('duplicate '+this.name);
    if(this.name==='entries'&&value.activeKey){
      const collision=[...this.data.values()].find(row=>row.activeKey===value.activeKey);
      if(collision) throw new Error('duplicate activeKey');
    }
    this.data.set(key,structuredClone(value));
  }
  async put(value){
    const key=keyFor(this.name,value);
    if(this.name==='entries'&&value.activeKey){
      const collision=[...this.data.entries()].find(([id,row])=>id!==key&&row.activeKey===value.activeKey);
      if(collision) throw new Error('duplicate activeKey');
    }
    this.data.set(key,structuredClone(value));
  }
  async delete(key){this.data.delete(key);}
}
class MemoryDriver{
  constructor(){
    this.stores=new Map([
      'vaults','entries','contents','attachments','dirty','outbox','revisions','drafts',
      'settings','remoteShadows','syncCursors','knowledge','entities','noteBodies',
      'blobPayloads','migrationState','backgroundRuntime','remoteInbox','conflicts','syncConflicts',
    ].map(name=>[name,new Map()]));
  }
  async transaction(names,mode,body){
    const working=new Map([...this.stores].map(([name,data])=>[
      name,
      mode==='readwrite'&&names.includes(name)
        ? new Map([...data].map(([key,value])=>[key,structuredClone(value)]))
        : data,
    ]));
    const result=await body({store:name=>new MemoryStore(working.get(name),name)});
    if(mode==='readwrite') for(const name of names)this.stores.set(name,working.get(name));
    return result;
  }
}

function vault(){
  return {
    id:vaultId,name:'Multi',createdAt:at,updatedAt:at,mode:'cloud',
    cloud:{
      accountId,authUserId:'auth',ownerAccountId:accountId,ownerAuthUserId:'auth',
      accessRole:'owner',projectRef:'test',remoteVaultId:vaultId,epoch,
      protocolVersion:2,deviceId:deviceA,adoptedAt:at,
    },
  };
}
function entryFromState(state,version=1){
  return {
    id:state.entryId,vaultId:state.vaultId,parentId:state.parentId,name:state.name,
    kind:state.entityType==='note'?'markdown':'directory',
    createdAt:state.createdAt,updatedAt:state.updatedAt,localVersion:version,
    deletedAt:state.deletedAt,deletionBatch:null,
    ...(state.deletedAt===null?{activeKey:activeKey(state.vaultId,state.parentId,state.name)}:{}),
  };
}
function shadowFromState(state,revision='1',sequence='1'){
  return {
    protocolVersion:2,entryId:state.entryId,vaultId:state.vaultId,accountId,epoch,
    entityType:state.entityType,remoteRevision:revision,remoteSequence:sequence,
    structural:{parentId:state.parentId,nameToken:token,deleted:state.deletedAt!==null,blobId:null},
    basePayload:{
      format:'vault/entity-payload/v1',version:1,entityType:state.entityType,name:state.name,
      createdAt:state.createdAt,updatedAt:state.updatedAt,deletedAt:state.deletedAt,
      ...(state.entityType==='note'?{text:state.text}:{}),
    },
    baseStateSha256:hash,encryptionVersion:1,keyGeneration:1,updatedAt:at,
  };
}
function eventFromState(state,revision='2',sequence='2',operationId='99999999-9999-4999-8999-999999999999'){
  return {
    entityId:state.entryId,vaultId,state:undefined,entityType:state.entityType,
    remoteRevision:revision,sequence,schemaVersion:1,parentId:state.parentId,
    nameToken:token,deleted:state.deletedAt!==null,keyGeneration:1,
    payload:{
      format:'vault/entity-payload/v1',version:1,entityType:state.entityType,name:state.name,
      createdAt:state.createdAt,updatedAt:state.updatedAt,deletedAt:state.deletedAt,
      ...(state.entityType==='note'?{text:state.text}:{}),
    },
    operationId,updatedByDevice:deviceB,updatedAt:state.updatedAt,stateHash:hash,
  };
}
function seedBase(driver,base,local=base,localVersion=1){
  driver.stores.get('vaults').set(vaultId,vault());
  driver.stores.get('entries').set(local.entryId,entryFromState(local,localVersion));
  if(local.entityType==='note'){
    driver.stores.get('contents').set(local.entryId,{entryId:local.entryId,text:local.text,localVersion});
  }
  driver.stores.get('remoteShadows').set(base.entryId,shadowFromState(base));
  driver.stores.get('syncCursors').set(vaultId,{
    protocolVersion:2,vaultId,accountId,epoch,cursor:'1',updatedAt:at,
  });
  if(localVersion>1){
    driver.stores.get('dirty').set(local.entryId,{
      entryId:local.entryId,vaultId,localVersion,changedAt:local.updatedAt,intent:local.deletedAt?'trash':'upsert',
    });
  }
}

test('I6 persisted conflict validation rejects cross-Vault REMOTE state before resolution or archive restore',()=>{
  const local=noteState({text:'LOCAL\n'});
  const base=noteState({text:'BASE\n'});
  const remote=noteState({text:'REMOTE\n'});
  const record={
    protocolVersion:2,
    id:'019c0000-0000-7000-8000-000000000098',
    vaultId,entryId:noteId,accountId,epoch,entityType:'note',kind:'markdown',
    status:'open',baseRevision:'1',remoteRevision:'2',remoteSequence:'2',
    remoteNameToken:token,remoteKeyGeneration:1,remoteStateSha256:hash,
    base,local,remote:{...remote,vaultId:'99999999-9999-4999-8999-999999999999'},
    markdownConflictIds:['block:0'],source:'pull',resolution:null,resolutionText:null,
    createdAt:at,updatedAt:at,resolvedAt:null,
  };
  assert.throws(
    ()=>validateSyncConflictV2(record),
    error=>error?.code==='CORRUPT'&&/REMOTE crossed Vault identity/u.test(error.message),
  );
});


test('I6 page apply auto-merges disjoint concurrent Markdown and advances clean base/cursor',async()=>{
  const driver=new MemoryDriver();
  const base=noteState();
  const local=noteState({text:'alpha LOCAL\n\nbeta\n\ngamma\n',updatedAt:'2026-09-23T12:01:00.000Z'});
  const remote=noteState({text:'alpha\n\nbeta\n\ngamma REMOTE\n',updatedAt:'2026-09-23T12:02:00.000Z'});
  seedBase(driver,base,local,2);
  const replica=new EncryptedReplicaStoreV2(driver);
  const result=await replica.applyPage({
    accountId,epoch,expectedAfter:'1',through:'2',events:[eventFromState(remote)],
  });
  assert.equal(result.autoMergedEntities,1);
  assert.equal(result.conflictsCaptured,0);
  assert.equal(driver.stores.get('syncCursors').get(vaultId).cursor,'2');
  assert.equal(driver.stores.get('remoteShadows').get(noteId).remoteRevision,'2');
  const body=driver.stores.get('contents').get(noteId).text;
  assert.match(body,/alpha LOCAL/);
  assert.match(body,/gamma REMOTE/);
  assert.ok(driver.stores.get('dirty').has(noteId));
});

test('I6 ordinary conflict is captured atomically while cursor advances and local stays editable',async()=>{
  const driver=new MemoryDriver();
  const base=noteState();
  const local=noteState({text:'alpha LOCAL\n\nbeta\n\ngamma\n',updatedAt:'2026-09-23T12:01:00.000Z'});
  const remote=noteState({text:'alpha REMOTE\n\nbeta\n\ngamma\n',updatedAt:'2026-09-23T12:02:00.000Z'});
  seedBase(driver,base,local,2);
  const replica=new EncryptedReplicaStoreV2(driver);
  const first=await replica.applyPage({
    accountId,epoch,expectedAfter:'1',through:'2',events:[eventFromState(remote)],
  });
  assert.equal(first.conflictsCaptured,1);
  assert.equal(driver.stores.get('syncCursors').get(vaultId).cursor,'2');
  assert.equal(driver.stores.get('contents').get(noteId).text,local.text);
  const shadow=driver.stores.get('remoteShadows').get(noteId);
  assert.equal(shadow.remoteRevision,'1');
  assert.equal(shadow.observedRemoteRevision,'2');

  const conflicts=new SyncConflictStoreV2(driver);
  const open=await conflicts.openForEntry(vaultId,noteId);
  assert.equal(open.baseRevision,'1');
  assert.equal(open.remoteRevision,'2');
  assert.equal(open.base.text,base.text);
  assert.equal(open.local.text,local.text);
  assert.equal(open.remote.text,remote.text);

  const editedLocal=driver.stores.get('entries').get(noteId);
  editedLocal.localVersion=3;
  editedLocal.updatedAt='2026-09-23T12:03:00.000Z';
  driver.stores.get('entries').set(noteId,editedLocal);
  driver.stores.get('contents').set(noteId,{entryId:noteId,text:'alpha USER EDIT\n\nbeta\n\ngamma\n',localVersion:3});
  driver.stores.get('dirty').set(noteId,{entryId:noteId,vaultId,localVersion:3,changedAt:editedLocal.updatedAt,intent:'upsert'});
  assert.equal(await replica.refreshConflictLocal(vaultId,noteId,accountId,epoch),true);
  assert.match((await conflicts.openForEntry(vaultId,noteId)).local.text,/USER EDIT/);
});

test('I6 later remote revisions update REMOTE but preserve the original BASE',async()=>{
  const driver=new MemoryDriver();
  const base=noteState();
  const local=noteState({text:'alpha LOCAL\n\nbeta\n\ngamma\n'});
  const remote2=noteState({text:'alpha REMOTE2\n\nbeta\n\ngamma\n'});
  seedBase(driver,base,local,2);
  const replica=new EncryptedReplicaStoreV2(driver);
  await replica.applyPage({accountId,epoch,expectedAfter:'1',through:'2',events:[eventFromState(remote2)]});

  const remote3=noteState({text:'alpha REMOTE3\n\nbeta\n\ngamma\n',updatedAt:'2026-09-23T12:04:00.000Z'});
  await replica.applyPage({
    accountId,epoch,expectedAfter:'2',through:'3',
    events:[eventFromState(remote3,'3','3','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')],
  });
  const open=await new SyncConflictStoreV2(driver).openForEntry(vaultId,noteId);
  assert.equal(open.base.text,base.text);
  assert.equal(open.remote.text,remote3.text);
  assert.equal(open.remoteRevision,'3');
  assert.equal(driver.stores.get('syncCursors').get(vaultId).cursor,'3');
});

test('I6 Keep Remote checkpoints/replaces local state and resolves the conflict',async()=>{
  const driver=new MemoryDriver();
  const base=noteState();
  const local=noteState({text:'alpha LOCAL\n\nbeta\n\ngamma\n'});
  const remote=noteState({text:'alpha REMOTE\n\nbeta\n\ngamma\n'});
  seedBase(driver,base,local,2);
  const replica=new EncryptedReplicaStoreV2(driver);
  await replica.applyPage({accountId,epoch,expectedAfter:'1',through:'2',events:[eventFromState(remote)]});
  const resolved=await replica.resolveConflict({vaultId,entryId:noteId,accountId,epoch,resolution:'keep-remote'});
  assert.equal(resolved.conflict.status,'resolved');
  assert.equal(driver.stores.get('contents').get(noteId).text,remote.text);
  assert.equal(driver.stores.get('remoteShadows').get(noteId).remoteRevision,'2');
  assert.equal(driver.stores.get('dirty').has(noteId),false);
});

test('I6 Keep Local rebases on latest remote and stays blocked until its own resolution event is observed',async()=>{
  const driver=new MemoryDriver();
  const base=noteState();
  const local=noteState({text:'alpha LOCAL\n\nbeta\n\ngamma\n'});
  const remote=noteState({text:'alpha REMOTE\n\nbeta\n\ngamma\n'});
  seedBase(driver,base,local,2);
  const replica=new EncryptedReplicaStoreV2(driver);
  await replica.applyPage({accountId,epoch,expectedAfter:'1',through:'2',events:[eventFromState(remote)]});
  const pending=await replica.resolveConflict({vaultId,entryId:noteId,accountId,epoch,resolution:'keep-local'});
  assert.equal(pending.conflict.status,'resolution-pending');
  assert.equal(driver.stores.get('remoteShadows').get(noteId).remoteRevision,'2');
  assert.ok(driver.stores.get('dirty').has(noteId));
  assert.equal(await replica.refreshConflictLocal(vaultId,noteId,accountId,epoch),true);
});

test('I6 rejects a resolver decision when the conflict changed after the UI snapshot',async()=>{
  const driver=new MemoryDriver();
  const base=noteState();
  const local=noteState({text:'alpha LOCAL\n\nbeta\n\ngamma\n'});
  const remote=noteState({text:'alpha REMOTE\n\nbeta\n\ngamma\n'});
  seedBase(driver,base,local,2);
  const replica=new EncryptedReplicaStoreV2(driver);
  await replica.applyPage({accountId,epoch,expectedAfter:'1',through:'2',events:[eventFromState(remote)]});

  const store=new SyncConflictStoreV2(driver);
  const snapshot=await store.openForEntry(vaultId,noteId);
  assert.ok(snapshot);

  const stored=driver.stores.get('syncConflicts').get(snapshot.id);
  driver.stores.get('syncConflicts').set(snapshot.id,{
    ...stored,
    updatedAt:'2026-09-23T12:05:00.000Z',
  });

  await assert.rejects(
    ()=>replica.resolveConflict({
      vaultId,entryId:noteId,accountId,epoch,resolution:'keep-local',
      conflictId:snapshot.id,expectedUpdatedAt:snapshot.updatedAt,
    }),
    error=>error?.code==='STALE_WRITE'&&/changed after the resolver opened/u.test(error.message),
  );
  assert.equal((await store.openForEntry(vaultId,noteId)).status,'open');
  assert.equal(driver.stores.get('contents').get(noteId).text,local.text);
});


test('I6 rejects manual resolution when LOCAL changed after the resolver snapshot',async()=>{
  const driver=new MemoryDriver();
  const base=noteState();
  const local=noteState({text:'alpha LOCAL\n\nbeta\n\ngamma\n'});
  const remote=noteState({text:'alpha REMOTE\n\nbeta\n\ngamma\n'});
  seedBase(driver,base,local,2);
  const replica=new EncryptedReplicaStoreV2(driver);
  await replica.applyPage({accountId,epoch,expectedAfter:'1',through:'2',events:[eventFromState(remote)]});

  const store=new SyncConflictStoreV2(driver);
  const snapshot=await store.openForEntry(vaultId,noteId);
  assert.ok(snapshot);

  const entry=driver.stores.get('entries').get(noteId);
  driver.stores.get('entries').set(noteId,{
    ...entry,
    localVersion:entry.localVersion+1,
    updatedAt:'2026-09-23T12:06:00.000Z',
  });
  driver.stores.get('contents').set(noteId,{
    entryId:noteId,
    text:'alpha NEWER LOCAL\n\nbeta\n\ngamma\n',
    localVersion:entry.localVersion+1,
  });

  await assert.rejects(
    ()=>replica.resolveConflict({
      vaultId,entryId:noteId,accountId,epoch,resolution:'manual',
      manualText:'alpha STALE MANUAL\n\nbeta\n\ngamma\n',
      conflictId:snapshot.id,expectedUpdatedAt:snapshot.updatedAt,
    }),
    error=>error?.code==='STALE_WRITE'&&/local entity changed after the resolver opened/u.test(error.message),
  );
  assert.equal(driver.stores.get('contents').get(noteId).text,'alpha NEWER LOCAL\n\nbeta\n\ngamma\n');
  assert.equal((await store.openForEntry(vaultId,noteId)).status,'open');
});


test('I6 cross-ID same-name create becomes durable name conflict and Keep Both preserves both entities',async()=>{
  const driver=new MemoryDriver();
  const local=noteState({entryId:noteId,name:'Same.md',text:'LOCAL\n'});
  driver.stores.get('vaults').set(vaultId,vault());
  driver.stores.get('entries').set(noteId,entryFromState(local,1));
  driver.stores.get('contents').set(noteId,{entryId:noteId,text:local.text,localVersion:1});
  driver.stores.get('dirty').set(noteId,{entryId:noteId,vaultId,localVersion:1,changedAt:at,intent:'upsert'});
  driver.stores.get('syncCursors').set(vaultId,{protocolVersion:2,vaultId,accountId,epoch,cursor:'0',updatedAt:at});

  const remote=noteState({entryId:noteOther,name:'Same.md',text:'REMOTE\n',updatedAt:'2026-09-23T12:02:00.000Z'});
  const replica=new EncryptedReplicaStoreV2(driver);
  const applied=await replica.applyPage({
    accountId,epoch,expectedAfter:'0',through:'1',events:[eventFromState(remote,'1','1')],
  });
  assert.equal(applied.conflictsCaptured,1);
  assert.equal(driver.stores.get('entries').has(noteOther),false);
  assert.equal(driver.stores.get('syncCursors').get(vaultId).cursor,'1');

  const open=await new SyncConflictStoreV2(driver).openForEntry(vaultId,noteId);
  assert.equal(open.kind,'name');
  assert.equal(open.remote.entryId,noteOther);

  const resolved=await replica.resolveConflict({
    vaultId,entryId:noteId,accountId,epoch,resolution:'keep-both',
  });
  assert.equal(resolved.conflict.status,'resolved');
  assert.ok(driver.stores.get('entries').has(noteOther));
  assert.notEqual(driver.stores.get('entries').get(noteId).name,'Same.md');
  assert.equal(driver.stores.get('entries').get(noteOther).name,'Same.md');
  assert.ok(driver.stores.get('dirty').has(noteId));
});

test('I6 Keep Both on one Note identity creates a UUIDv7 local copy and rekeys Task IDs',async()=>{
  const driver=new MemoryDriver();
  const task='123e4567-e89b-7d12-a456-426614174000';
  const base=noteState({text:`- [ ] base <!-- vault:task=${task} -->\n`});
  const local=noteState({text:`- [ ] local <!-- vault:task=${task} -->\n`});
  const remote=noteState({text:`- [ ] remote <!-- vault:task=${task} -->\n`});
  seedBase(driver,base,local,2);
  const replica=new EncryptedReplicaStoreV2(driver);
  await replica.applyPage({accountId,epoch,expectedAfter:'1',through:'2',events:[eventFromState(remote)]});
  const result=await replica.resolveConflict({vaultId,entryId:noteId,accountId,epoch,resolution:'keep-both'});
  assert.equal(result.conflict.status,'resolved');
  assert.match(result.createdCopyId,/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.equal(driver.stores.get('contents').get(noteId).text,remote.text);
  const copy=driver.stores.get('entries').get(result.createdCopyId);
  const copyBody=driver.stores.get('contents').get(result.createdCopyId).text;
  assert.match(copy.name,/conflict/u);
  assert.doesNotMatch(copyBody,new RegExp(task,'u'));
  assert.ok(driver.stores.get('dirty').has(result.createdCopyId));
});

function rng(seed){
  let state=seed>>>0;
  return ()=>{state=(1664525*state+1013904223)>>>0;return state/0x100000000;};
}

test('I6 seeded disjoint-edit simulations converge without unexplained divergence',()=>{
  for(let seed=1;seed<=250;seed++){
    const random=rng(seed);
    const paragraphs=Array.from({length:8},(_,index)=>`p${index}\n`);
    const left=Math.floor(random()*4);
    const right=4+Math.floor(random()*4);
    const base=noteState({text:paragraphs.join('\n')});
    const localParts=[...paragraphs];
    const remoteParts=[...paragraphs];
    localParts[left]=`local-${seed}-${left}\n`;
    remoteParts[right]=`remote-${seed}-${right}\n`;
    const result=reconcileSyncEntityV2(
      base,
      noteState({text:localParts.join('\n')}),
      noteState({text:remoteParts.join('\n')}),
    );
    assert.notEqual(result.kind,'conflict',`seed ${seed} unexpectedly conflicted`);
    assert.match(result.state.text,new RegExp(`local-${seed}-${left}`,'u'));
    assert.match(result.state.text,new RegExp(`remote-${seed}-${right}`,'u'));
  }
});
