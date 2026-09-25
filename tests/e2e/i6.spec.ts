import { expect, test, type Page } from '@playwright/test';

const accountId='11111111-1111-4111-8111-111111111111';
const authUserId='22222222-2222-4222-8222-222222222222';
const deviceId='33333333-3333-4333-8333-333333333333';
const epoch='44444444-4444-4444-8444-444444444444';
const conflictId='019c0000-0000-7000-8000-000000000099';
const nameToken='N'.repeat(43);
const stateHash='a'.repeat(64);

async function confirmTextDialog(page:Page,value:string){
  const dialog=page.locator('.form-dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('#vault-dialog-input').fill(value);
  await dialog.locator('button[value="confirm"]').click();
  await expect(dialog).not.toBeVisible();
}

async function createVault(page:Page,name:string){
  await page.goto('/');
  await page.locator('.empty-state [data-command="vault.create"]').click();
  await confirmTextDialog(page,name);
}

async function ensureSidebarOpen(page:Page){
  if(await page.locator('.sidebar-tabs').isVisible()) return;
  await page.locator('[data-action="files"]').click();
  await expect(page.locator('.workspace')).toHaveAttribute('data-sidebar-open','true');
}

async function createNote(page:Page,name:string,text:string){
  await ensureSidebarOpen(page);
  await page.locator('.sidebar [data-command="file.create"]').click();
  await confirmTextDialog(page,name);
  const editor=page.locator('.cm-content');
  await editor.click();
  await page.keyboard.insertText(text);
  await expect.poll(async()=>{
    try{return (await currentEntry(page,name)).content?.text ?? '';}
    catch{return '';}
  },{timeout:10_000}).toBe(text);
}

async function currentEntry(page:Page,name:string){
  return page.evaluate(async target=>{
    const request=indexedDB.open('vault:local');
    const db:IDBDatabase=await new Promise((resolve,reject)=>{
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });
    const tx=db.transaction(['entries','contents'],'readonly');
    const entriesReq=tx.objectStore('entries').getAll();
    const entries=await new Promise<any[]>((resolve,reject)=>{
      entriesReq.onsuccess=()=>resolve(entriesReq.result);
      entriesReq.onerror=()=>reject(entriesReq.error);
    });
    const entry=entries.find(row=>row.name===target || row.name===target+'.md');
    if(!entry){db.close();throw new Error('Entry not found: '+target);}
    const contentReq=tx.objectStore('contents').get(entry.id);
    const content=await new Promise<any>((resolve,reject)=>{
      contentReq.onsuccess=()=>resolve(contentReq.result);
      contentReq.onerror=()=>reject(contentReq.error);
    });
    await new Promise<void>((resolve,reject)=>{
      tx.oncomplete=()=>resolve();
      tx.onabort=()=>reject(tx.error);
      tx.onerror=()=>reject(tx.error);
    });
    db.close();
    return {entry,content};
  },name);
}

async function seedProtocolV2Conflict(page:Page,input:{
  noteName:string;
  baseText:string;
  localText:string;
  remoteText:string;
}){
  const current=await currentEntry(page,input.noteName);
  await page.evaluate(async args=>{
    const {current,baseText,localText,remoteText,accountId,authUserId,deviceId,epoch,conflictId,nameToken,stateHash}=args;
    const request=indexedDB.open('vault:local');
    const db:IDBDatabase=await new Promise((resolve,reject)=>{
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });

    const readTx=db.transaction('vaults','readonly');
    const vaultReq=readTx.objectStore('vaults').get(current.entry.vaultId);
    const vault=await new Promise<any>((resolve,reject)=>{
      vaultReq.onsuccess=()=>resolve(vaultReq.result);
      vaultReq.onerror=()=>reject(vaultReq.error);
    });
    await new Promise<void>((resolve,reject)=>{
      readTx.oncomplete=()=>resolve();
      readTx.onabort=()=>reject(readTx.error);
      readTx.onerror=()=>reject(readTx.error);
    });

    const now='2026-09-25T04:00:00.000Z';
    const state=(text:string)=>({
      entryId:current.entry.id,
      vaultId:current.entry.vaultId,
      entityType:'note',
      parentId:current.entry.parentId,
      name:current.entry.name,
      createdAt:current.entry.createdAt,
      updatedAt:now,
      deletedAt:null,
      text,
    });

    const writeTx=db.transaction(['vaults','contents','dirty','syncConflicts'],'readwrite');
    writeTx.objectStore('vaults').put({
      ...vault,
      mode:'cloud',
      cloud:{
        accountId,
        authUserId,
        ownerAccountId:accountId,
        ownerAuthUserId:authUserId,
        accessRole:'owner',
        projectRef:'bskfihouwdogrunnglbg',
        remoteVaultId:vault.id,
        epoch,
        protocolVersion:2,
        deviceId,
        adoptedAt:now,
      },
    });
    writeTx.objectStore('contents').put({...current.content,text:localText});
    writeTx.objectStore('dirty').put({
      entryId:current.entry.id,
      vaultId:current.entry.vaultId,
      localVersion:current.entry.localVersion,
      changedAt:now,
      intent:'upsert',
    });
    writeTx.objectStore('syncConflicts').put({
      protocolVersion:2,
      id:conflictId,
      vaultId:current.entry.vaultId,
      entryId:current.entry.id,
      accountId,
      epoch,
      entityType:'note',
      kind:'markdown',
      status:'open',
      baseRevision:'1',
      remoteRevision:'2',
      remoteSequence:'2',
      remoteNameToken:nameToken,
      remoteKeyGeneration:1,
      remoteStateSha256:stateHash,
      base:state(baseText),
      local:state(localText),
      remote:state(remoteText),
      markdownConflictIds:['paragraph:0'],
      source:'pull',
      resolution:null,
      resolutionText:null,
      createdAt:now,
      updatedAt:now,
      resolvedAt:null,
    });

    await new Promise<void>((resolve,reject)=>{
      writeTx.oncomplete=()=>resolve();
      writeTx.onabort=()=>reject(writeTx.error);
      writeTx.onerror=()=>reject(writeTx.error);
    });
    db.close();
  },{
    current,
    baseText:input.baseText,
    localText:input.localText,
    remoteText:input.remoteText,
    accountId,authUserId,deviceId,epoch,conflictId,nameToken,stateHash,
  });
  return current.entry.id as string;
}

async function conflictRecord(page:Page){
  return page.evaluate(async id=>{
    const request=indexedDB.open('vault:local');
    const db:IDBDatabase=await new Promise((resolve,reject)=>{
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });
    const tx=db.transaction('syncConflicts','readonly');
    const req=tx.objectStore('syncConflicts').get(id);
    const value=await new Promise<any>((resolve,reject)=>{
      req.onsuccess=()=>resolve(req.result);
      req.onerror=()=>reject(req.error);
    });
    db.close();
    return value;
  },conflictId);
}

test('I6 browser resolver can Keep Remote and retire the encrypted conflict',async({page})=>{
  const base='# Note\n\nShared paragraph.\n\nTail.\n';
  const local='# Note\n\nLocal paragraph.\n\nTail.\n';
  const remote='# Note\n\nRemote paragraph.\n\nTail.\n';

  await createVault(page,'I6 Keep Remote');
  await createNote(page,'Conflict',local);
  await seedProtocolV2Conflict(page,{noteName:'Conflict',baseText:base,localText:local,remoteText:remote});
  await page.reload();

  const conflicts=page.locator('[data-action="conflicts-open"]');
  await expect(conflicts).toBeVisible();
  await expect(conflicts.locator('.conflict-count')).toHaveText('1');
  await conflicts.click();

  const resolver=page.locator('.conflict-dialog');
  await expect(resolver).toBeVisible();
  await expect(resolver.locator('.conflict-intro')).toContainText('overlapping Markdown');
  await expect(resolver.locator('.conflict-hunk.needs-choice')).toContainText('Local paragraph');
  await expect(resolver.locator('.conflict-hunk.needs-choice')).toContainText('Remote paragraph');
  await expect(resolver.locator('[data-conflict-action="keep-remote"]')).toBeEnabled();

  await resolver.locator('[data-conflict-action="keep-remote"]').click();
  await expect(resolver).not.toBeVisible();
  await expect(conflicts).toBeHidden();

  expect((await currentEntry(page,'Conflict')).content.text).toBe(remote);
  const stored=await conflictRecord(page);
  expect(stored.status).toBe('resolved');
  expect(stored.resolution).toBe('keep-remote');
});

test('I6 browser manual merge becomes resolution-pending and remains conflict-blocked',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='chromium-desktop');

  const base='# Note\n\nShared paragraph.\n\nTail.\n';
  const local='# Note\n\nLocal paragraph.\n\nTail.\n';
  const remote='# Note\n\nRemote paragraph.\n\nTail.\n';

  await createVault(page,'I6 Manual');
  await createNote(page,'Manual',local);
  await seedProtocolV2Conflict(page,{noteName:'Manual',baseText:base,localText:local,remoteText:remote});
  await page.reload();
  await page.locator('[data-action="conflicts-open"]').click();

  const resolver=page.locator('.conflict-dialog');
  const choice=resolver.locator('.conflict-choice');
  await choice.selectOption('local');
  await expect(resolver.locator('#conflict-preview')).toHaveValue(local);
  await resolver.locator('[data-conflict-action="resolve"]').click();

  await expect(resolver).toBeVisible();
  await expect(resolver.locator('.conflict-status')).toContainText('remains conflict-blocked');
  await expect(resolver.locator('[data-conflict-action="keep-local"]')).toBeDisabled();
  const stored=await conflictRecord(page);
  expect(stored.status).toBe('resolution-pending');
  expect(stored.resolution).toBe('manual');
  expect(stored.resolutionText).toBe(local);
  expect((await currentEntry(page,'Manual')).content.text).toBe(local);
});
