import { expect, test, type Page } from '@playwright/test';

async function confirmTextDialog(page:Page,value:string){
  const dialog=page.locator('.form-dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('#vault-dialog-input').fill(value);
  await dialog.locator('button[value="confirm"]').click();
  await expect(dialog).not.toBeVisible();
}

async function createVault(page:Page,name:string){
  await page.locator('.empty-state [data-command="vault.create"]').click();
  await confirmTextDialog(page,name);
}

async function createNote(page:Page,name:string,text:string){
  await page.locator('[data-command="file.create"]').click();
  await confirmTextDialog(page,name);
  const editor=page.locator('.cm-content');
  await editor.click();
  if(text) await page.keyboard.insertText(text);
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
    const all=<T=any>(store:string)=>new Promise<T[]>((resolve,reject)=>{
      const tx=db.transaction(store,'readonly');
      const req=tx.objectStore(store).getAll();
      req.onsuccess=()=>resolve(req.result);
      req.onerror=()=>reject(req.error);
    });
    const entries=await all<any>('entries');
    const entry=entries.find(row=>row.name===target || row.name===target+'.md');
    if(!entry){db.close();throw new Error('Entry not found: '+target);}
    const tx=db.transaction('contents','readonly');
    const req=tx.objectStore('contents').get(entry.id);
    const content=await new Promise<any>((resolve,reject)=>{
      req.onsuccess=()=>resolve(req.result);
      req.onerror=()=>reject(req.error);
    });
    db.close();
    return {entry,content};
  },name);
}

async function seedConflict(page:Page){
  const canonical=await currentEntry(page,'Canonical');
  const localCopy=await currentEntry(page,'Canonical conflict');
  const baseText='# Note\n\nShared paragraph.\n\nTail.\n';
  const localText='# Note\n\nLocal paragraph.\n\nTail.\n';
  const remoteText='# Note\n\nRemote paragraph.\n\nTail.\n';

  await page.evaluate(async input=>{
    const request=indexedDB.open('vault:local');
    const db:IDBDatabase=await new Promise((resolve,reject)=>{
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });
    const tx=db.transaction(['conflicts'],'readwrite');
    const store=tx.objectStore('conflicts');
    const timestamp=new Date().toISOString();
    store.put({
      id:input.canonical.entry.id+':2',
      vaultId:input.canonical.entry.vaultId,
      entryId:input.canonical.entry.id,
      conflictEntryId:input.localCopy.entry.id,
      ownerId:'phase22-test-owner',
      epoch:'phase22-test-epoch',
      baseRevision:1,
      remoteRevision:2,
      baseText:input.baseText,
      localText:input.localText,
      remoteText:input.remoteText,
      source:'pull',
      status:'open',
      createdAt:timestamp,
      updatedAt:timestamp,
      resolvedAt:null,
      resolutionText:null,
    });
    await new Promise<void>((resolve,reject)=>{
      tx.oncomplete=()=>resolve();
      tx.onabort=()=>reject(tx.error);
      tx.onerror=()=>reject(tx.error);
    });
    db.close();
  },{canonical,localCopy,baseText,localText,remoteText});

  return {canonical,localCopy,baseText,localText,remoteText};
}

test('Phase 22 resolves a semantic Markdown conflict and retires the untouched conflict copy',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='chromium-desktop');

  await page.goto('/');
  await createVault(page,'Conflict Test');
  await createNote(page,'Canonical','# Note\n\nRemote paragraph.\n\nTail.\n');
  await createNote(page,'Canonical conflict','# Note\n\nLocal paragraph.\n\nTail.\n');
  const seeded=await seedConflict(page);

  await page.reload();
  const conflicts=page.locator('[data-action="conflicts-open"]');
  await expect(conflicts).toBeVisible();
  await expect(conflicts.locator('.conflict-count')).toHaveText('1');
  await conflicts.click();

  const resolver=page.locator('.conflict-dialog');
  await expect(resolver).toBeVisible();
  await expect(resolver.locator('.conflict-meta')).toContainText('remote revision 2');
  await expect(resolver.locator('.conflict-hunk.needs-choice')).toHaveCount(1);
  await expect(resolver.locator('.conflict-hunk.needs-choice')).toContainText('Local paragraph');
  await expect(resolver.locator('.conflict-hunk.needs-choice')).toContainText('Remote paragraph');

  const choice=resolver.locator('.conflict-choice');
  await choice.selectOption('local');
  await expect(resolver.locator('#conflict-preview')).toHaveValue(seeded.localText);
  await expect(resolver.locator('[data-conflict-action="resolve"]')).toBeEnabled();
  await resolver.locator('[data-conflict-action="resolve"]').click();
  await expect(resolver).not.toBeVisible();

  const editor=page.locator('.cm-content');
  await expect(editor).toContainText('Local paragraph.');
  await expect(editor).not.toContainText('Remote paragraph.');
  await expect(conflicts).toBeHidden();

  const persisted=await page.evaluate(async ({canonicalId,copyId})=>{
    const request=indexedDB.open('vault:local');
    const db:IDBDatabase=await new Promise((resolve,reject)=>{
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });
    const get=(store:string,key:string)=>new Promise<any>((resolve,reject)=>{
      const tx=db.transaction(store,'readonly');
      const req=tx.objectStore(store).get(key);
      req.onsuccess=()=>resolve(req.result);
      req.onerror=()=>reject(req.error);
    });
    const [content,copy,conflict]=await Promise.all([
      get('contents',canonicalId),
      get('entries',copyId),
      get('conflicts',canonicalId+':2'),
    ]);
    db.close();
    return {content,copy,conflict};
  },{canonicalId:seeded.canonical.entry.id,copyId:seeded.localCopy.entry.id});

  expect(persisted.content.text).toBe(seeded.localText);
  expect(persisted.copy.deletedAt).not.toBeNull();
  expect(persisted.conflict.status).toBe('resolved');
  expect(persisted.conflict.resolutionText).toBe(seeded.localText);
});

test('Phase 22 refuses to overwrite a canonical note changed after conflict capture',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='chromium-desktop');

  await page.goto('/');
  await createVault(page,'Stale Conflict Test');
  await createNote(page,'Canonical','# Note\n\nRemote paragraph.\n\nTail.\n');
  await createNote(page,'Canonical conflict','# Note\n\nLocal paragraph.\n\nTail.\n');
  const seeded=await seedConflict(page);

  await page.reload();
  await page.locator('[data-action="conflicts-open"]').click();
  const resolver=page.locator('.conflict-dialog');
  await resolver.locator('.conflict-choice').selectOption('local');

  await page.evaluate(async ({entryId})=>{
    const request=indexedDB.open('vault:local');
    const db:IDBDatabase=await new Promise((resolve,reject)=>{
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });
    const readTx=db.transaction(['entries','contents'],'readonly');
    const entryReq=readTx.objectStore('entries').get(entryId);
    const contentReq=readTx.objectStore('contents').get(entryId);
    const [entry,content]=await Promise.all([
      new Promise<any>((resolve,reject)=>{entryReq.onsuccess=()=>resolve(entryReq.result);entryReq.onerror=()=>reject(entryReq.error);}),
      new Promise<any>((resolve,reject)=>{contentReq.onsuccess=()=>resolve(contentReq.result);contentReq.onerror=()=>reject(contentReq.error);}),
    ]);
    const nextVersion=entry.localVersion+1;
    const writeTx=db.transaction(['entries','contents'],'readwrite');
    writeTx.objectStore('entries').put({...entry,localVersion:nextVersion,updatedAt:new Date().toISOString()});
    writeTx.objectStore('contents').put({...content,text:'# Note\n\nNewer canonical work.\n',localVersion:nextVersion});
    await new Promise<void>((resolve,reject)=>{
      writeTx.oncomplete=()=>resolve();
      writeTx.onabort=()=>reject(writeTx.error);
      writeTx.onerror=()=>reject(writeTx.error);
    });
    db.close();
  },{entryId:seeded.canonical.entry.id});

  await resolver.locator('[data-conflict-action="resolve"]').click();
  await expect(page.locator('.error')).toContainText('canonical note changed');

  const status=await page.evaluate(async id=>{
    const request=indexedDB.open('vault:local');
    const db:IDBDatabase=await new Promise((resolve,reject)=>{
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });
    const tx=db.transaction('conflicts','readonly');
    const req=tx.objectStore('conflicts').get(id);
    const value=await new Promise<any>((resolve,reject)=>{
      req.onsuccess=()=>resolve(req.result);
      req.onerror=()=>reject(req.error);
    });
    db.close();
    return value?.status;
  },seeded.canonical.entry.id+':2');
  expect(status).toBe('open');
});
