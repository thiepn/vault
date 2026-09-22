import { expect, test, type Browser, type Page, type Route } from '@playwright/test';

const PROJECT='https://bskfihouwdogrunnglbg.supabase.co';
const userId='11111111-1111-4111-8111-111111111111';
const accountId='22222222-2222-4222-8222-222222222222';
const epoch='33333333-3333-4333-8333-333333333333';
const remoteDeviceId='99999999-9999-4999-8999-999999999999';
const ACCESS='phase15-access-token';
const REFRESH='phase15-refresh-token';

const corsHeaders={
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Headers':'authorization,apikey,content-type,prefer',
  'Access-Control-Allow-Methods':'GET,POST,PATCH,OPTIONS',
};

function clone(value){ return structuredClone(value); }
function now(){ return new Date().toISOString(); }
function json(route:Route,body:unknown,status=200){
  return route.fulfill({status,contentType:'application/json',headers:corsHeaders,body:JSON.stringify(body)});
}

class MockSyncCloud {
  adopted=false;
  remoteVaultId='';
  remoteVaultName='';
  devices=new Map<string,string>();
  entries=new Map<string,any>();
  events:any[]=[];
  operations=new Map<string,{sha:string;result:any}>();
  blobs=new Map<string,Buffer>();
  uploadCount=0;
  downloadCount=0;

  emit(operationId:string,deviceId:string,kind:string,snapshot:any){
    const event={
      sequence:String(this.events.length+1),
      operationId,entryId:snapshot.entryId,revision:snapshot.revision,kind,deviceId,snapshot:clone(snapshot),
    };
    this.events.push(event);
    return event.sequence;
  }

  remoteWriteByName(name:string,text:string){
    const row=[...this.entries.values()].find(entry=>entry.name===name && entry.kind==='markdown');
    if(!row) throw new Error('remote note not found: '+name);
    const snapshot={...row,text,revision:row.revision+1,updatedAt:now(),updatedByDevice:remoteDeviceId};
    this.entries.set(snapshot.entryId,clone(snapshot));
    this.emit(crypto.randomUUID(),remoteDeviceId,'write',snapshot);
  }

  async attach(page:Page){
    await page.route(PROJECT+'/**',async route=>{
      const request=route.request();
      const url=new URL(request.url());
      if(request.method()==='OPTIONS') return route.fulfill({status:204,headers:corsHeaders,body:''});

      if(url.pathname==='/auth/v1/token' && url.searchParams.get('grant_type')==='password'){
        return json(route,{access_token:ACCESS,refresh_token:REFRESH,expires_in:3600});
      }
      if(url.pathname==='/auth/v1/user'){
        return json(route,{id:userId,email:'sync@example.test'});
      }
      if(url.pathname==='/auth/v1/logout') return route.fulfill({status:204,headers:corsHeaders,body:''});

      if(url.pathname==='/rest/v1/vault_accounts' && request.method()==='POST'){
        return json(route,[{id:accountId,auth_user_id:userId,created_at:'2026-09-22T12:00:00.000Z'}],201);
      }

      if(url.pathname==='/rest/v1/vault_cloud_devices' && request.method()==='POST'){
        const body=JSON.parse(request.postData()??'{}');
        this.devices.set(body.id,body.label);
        return json(route,[{
          id:body.id,account_id:accountId,auth_user_id:userId,label:body.label,platform:'web',
          created_at:'2026-09-22T12:00:00.000Z',last_seen_at:now(),revoked_at:null,
        }],201);
      }
      if(url.pathname==='/rest/v1/vault_cloud_devices' && request.method()==='GET'){
        return json(route,[...this.devices].map(([id,label])=>({
          id,account_id:accountId,auth_user_id:userId,label,platform:'web',
          created_at:'2026-09-22T12:00:00.000Z',last_seen_at:now(),revoked_at:null,
        })));
      }

      if(url.pathname==='/rest/v1/rpc/vault_accessible_vaults' && request.method()==='POST'){
        return json(route,this.adopted?[{
          id:this.remoteVaultId,account_id:accountId,auth_user_id:userId,
          owner_account_id:accountId,owner_auth_user_id:userId,access_role:'owner',
          name:this.remoteVaultName,epoch,protocol_version:1,
          created_at:'2026-09-22T12:00:00.000Z',updated_at:now(),disabled_at:null,
        }]:[]);
      }

      if(url.pathname==='/rest/v1/rpc/vault_share_members' && request.method()==='POST'){
        return json(route,this.adopted?[{
          vault_id:this.remoteVaultId,account_id:accountId,auth_user_id:userId,role:'owner',
          created_at:'2026-09-22T12:00:00.000Z',updated_at:now(),
        }]:[]);
      }

      if(url.pathname==='/rest/v1/vault_cloud_vaults' && request.method()==='POST'){
        const body=JSON.parse(request.postData()??'{}');
        this.remoteVaultId=body.id;
        this.remoteVaultName=body.name;
        this.adopted=true;
        return json(route,[{
          id:this.remoteVaultId,account_id:accountId,auth_user_id:userId,name:this.remoteVaultName,epoch,
          protocol_version:1,created_at:'2026-09-22T12:00:00.000Z',updated_at:now(),disabled_at:null,
        }],201);
      }
      if(url.pathname==='/rest/v1/vault_cloud_vaults' && request.method()==='GET'){
        return json(route,this.adopted?[{
          id:this.remoteVaultId,account_id:accountId,auth_user_id:userId,name:this.remoteVaultName,epoch,
          protocol_version:1,created_at:'2026-09-22T12:00:00.000Z',updated_at:now(),disabled_at:null,
        }]:[]);
      }

      if(url.pathname==='/rest/v1/rpc/vault_sync_pull' && request.method()==='POST'){
        const body=JSON.parse(request.postData()??'{}');
        expect(body.p_vault_id).toBe(this.remoteVaultId);
        expect(body.p_epoch).toBe(epoch);
        const start=Number(body.p_after);
        const selected=this.events.slice(start,start+(body.p_limit??500));
        return json(route,{
          protocolVersion:1,vaultId:this.remoteVaultId,epoch,after:String(body.p_after),
          through:selected.length?selected[selected.length-1].sequence:String(body.p_after),
          highWatermark:String(this.events.length),
          events:clone(selected),
        });
      }

      if(url.pathname==='/rest/v1/rpc/vault_sync_push' && request.method()==='POST'){
        const envelope=JSON.parse(request.postData()??'{}');
        const operation=envelope.p_wire;
        const prior=this.operations.get(operation.id);
        if(prior){
          expect(prior.sha).toBe(envelope.p_sha256);
          return json(route,clone(prior.result));
        }
        const snapshots=[];
        let through=String(this.events.length);
        for(const mutation of operation.mutations){
          let current=this.entries.get(mutation.entryId);
          if(mutation.kind==='create'){
            if(current) return json(route,{message:JSON.stringify({status:'conflict',reason:'exists',entryId:mutation.entryId,current})},409);
            if([...this.entries.values()].some(row=>row.deletedAt===null && row.parentId===mutation.parentId && row.name.toLowerCase()===mutation.name.toLowerCase())){
              return json(route,{message:JSON.stringify({status:'conflict',reason:'path',entryId:mutation.entryId,current:null})},409);
            }
            const attachment=mutation.entryKind==='attachment'?mutation.attachment:null;
            if(attachment){
              const key=userId+'/'+this.remoteVaultId+'/'+attachment.sha256;
              if(!this.blobs.has(key)) throw new Error('attachment operation arrived before blob upload');
            }
            current={
              entryId:mutation.entryId,vaultId:this.remoteVaultId,parentId:mutation.parentId,name:mutation.name,
              kind:mutation.entryKind,revision:1,deletedAt:null,updatedAt:now(),updatedByDevice:operation.deviceId,
              text:mutation.entryKind==='markdown'?mutation.text:null,
              attachmentSha256:attachment?.sha256??null,
              attachmentMimeType:attachment?.mimeType??null,
              attachmentSize:attachment?.size??null,
            };
          } else {
            if(!current || current.revision!==mutation.baseRevision){
              return json(route,{message:JSON.stringify({status:'conflict',reason:'revision',entryId:mutation.entryId,current:current??null})},409);
            }
            current={...current,revision:current.revision+1,updatedAt:now(),updatedByDevice:operation.deviceId};
            if(mutation.kind==='write') current.text=mutation.text;
            if(mutation.kind==='move'){ current.parentId=mutation.parentId; current.name=mutation.name; }
            if(mutation.kind==='trash') current.deletedAt=now();
            if(mutation.kind==='restore') current.deletedAt=null;
          }
          this.entries.set(current.entryId,clone(current));
          through=this.emit(operation.id,operation.deviceId,mutation.kind,current);
          snapshots.push(clone(current));
        }
        const result={status:'ok',operationId:operation.id,through,snapshots};
        this.operations.set(operation.id,{sha:envelope.p_sha256,result:clone(result)});
        return json(route,result);
      }

      const storagePrefix='/storage/v1/object/vault-sync/';
      if(url.pathname.startsWith(storagePrefix)){
        const path=url.pathname.slice(storagePrefix.length).split('/').map(decodeURIComponent).join('/');
        if(request.method()==='POST'){
          const bytes=request.postDataBuffer()??Buffer.alloc(0);
          this.blobs.set(path,Buffer.from(bytes));
          this.uploadCount++;
          return json(route,{Key:path},201);
        }
        if(request.method()==='GET'){
          const bytes=this.blobs.get(path);
          if(!bytes) return json(route,{message:'not found'},404);
          this.downloadCount++;
          return route.fulfill({status:200,headers:{...corsHeaders,'Content-Type':'application/octet-stream'},body:bytes});
        }
      }

      throw new Error('Unexpected Phase 15 cloud request: '+request.method()+' '+request.url());
    });
  }
}

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
  await expect(page.locator('#vault-vault option:checked')).toHaveText(name);
}
async function ensureSidebarOpen(page:Page){
  if(await page.locator('.sidebar-tabs').isVisible()) return;
  await page.locator('[data-action="files"]').click();
  await expect(page.locator('.sidebar-tabs')).toBeVisible();
}
async function createNote(page:Page,name:string,text:string){
  await ensureSidebarOpen(page);
  await page.locator('.sidebar [data-command="file.create"]').click();
  await confirmTextDialog(page,name);
  const editor=page.locator('#vault-editor .cm-content');
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(text);
  await expect(page.locator('.save-status')).toContainText('Saved locally');
}
async function quickOpen(page:Page,title:string){
  await page.locator('[data-action="quick-switcher"]').click();
  const dialog=page.locator('.quick-switcher-dialog');
  await dialog.locator('.quick-switcher-input').fill(title);
  const result=dialog.locator('.quick-result').filter({hasText:title}).first();
  await expect(result).toBeVisible();
  await result.click();
  await expect(dialog).not.toBeVisible();
}
async function sourceText(page:Page){
  const source=page.locator('[data-editor-mode="source"]');
  await source.click();
  await expect(source).toHaveAttribute('aria-pressed','true');
  return (await page.locator('#vault-editor .cm-line').allTextContents()).join('\n');
}
async function replaceSource(page:Page,text:string){
  const source=page.locator('[data-editor-mode="source"]');
  await source.click();
  const editor=page.locator('#vault-editor .cm-content');
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(text);
  await expect(page.locator('.save-status')).toContainText('Saved locally');
}
async function signIn(page:Page){
  const dialog=page.locator('.cloud-dialog');
  await page.locator('[data-action="cloud-open"]').click();
  await expect(dialog).toBeVisible();
  const signedIn=dialog.locator('.cloud-signed-in');
  if (await signedIn.isVisible()) return dialog;
  await dialog.locator('.cloud-email').fill('sync@example.test');
  await dialog.locator('.cloud-password').fill('x'.repeat(16));
  await dialog.locator('[data-cloud-action="sign-in"]').click();
  await expect(signedIn).toBeVisible();
  return dialog;
}
async function syncNow(dialog){
  await dialog.locator('[data-cloud-action="sync"]').click();
  await expect(dialog.locator('.cloud-message')).toContainText('Sync complete');
}

test('Phase 15 syncs canonical files, preserves conflict copies and reconstructs a remote Vault on another device',async({page,browser},testInfo)=>{
  test.skip(testInfo.project.name!=='chromium-desktop');
  const remote=new MockSyncCloud();
  await remote.attach(page);

  await createVault(page,'Shared Vault');
  await createNote(page,'Shared','# original');
  await page.locator('.attachment-file-input').setInputFiles({
    name:'pixel.bin',mimeType:'application/octet-stream',buffer:Buffer.from([1,2,3,4]),
  });
  await expect(page.locator('.save-status')).toContainText('Saved locally');

  let dialog=await signIn(page);
  await dialog.locator('[data-cloud-action="adopt"]').click();
  await expect(dialog.locator('.cloud-vault-state')).toContainText('Cloud adopted');
  await syncNow(dialog);
  await expect(dialog.locator('.cloud-sync-detail')).toContainText('0 queued');
  expect(remote.uploadCount).toBe(1);
  expect([...remote.entries.values()].some(entry=>entry.name==='Shared.md')).toBe(true);
  expect([...remote.entries.values()].some(entry=>entry.name==='pixel.bin')).toBe(true);
  await dialog.locator('button[value="close"]').click();

  await quickOpen(page,'Shared');
  await replaceSource(page,'# local concurrent');
  remote.remoteWriteByName('Shared.md','# remote concurrent');

  dialog=await signIn(page);
  await syncNow(dialog);
  await expect(dialog.locator('.cloud-message')).toContainText('1 conflict preserved');
  await dialog.locator('button[value="close"]').click();

  expect(await sourceText(page)).toContain('# remote concurrent');
  await page.locator('[data-action="quick-switcher"]').click();
  const quick=page.locator('.quick-switcher-dialog');
  await quick.locator('.quick-switcher-input').fill('conflict');
  const conflict=quick.locator('.quick-result').filter({hasText:'conflict'}).first();
  await expect(conflict).toBeVisible();
  await conflict.click();
  expect(await sourceText(page)).toContain('# local concurrent');

  const context2=await browser.newContext({baseURL:'http://127.0.0.1:4173'});
  const page2=await context2.newPage();
  await remote.attach(page2);
  await page2.goto('/');
  dialog=await signIn(page2);
  const remoteRow=dialog.locator('.cloud-remote-vaults .cloud-row').filter({hasText:'Shared Vault'});
  await expect(remoteRow.getByRole('button',{name:'Add to this device'})).toBeVisible();
  await remoteRow.getByRole('button',{name:'Add to this device'}).click();
  await expect(dialog.locator('.cloud-message')).toContainText('Sync complete');
  await expect(page2.locator('#vault-vault option:checked')).toHaveText('Shared Vault');
  await dialog.locator('button[value="close"]').click();

  await quickOpen(page2,'Shared');
  expect(await sourceText(page2)).toContain('# remote concurrent');
  await page2.locator('[data-editor-mode="live"]').click();
  await ensureSidebarOpen(page2);
  await page2.locator('[data-sidebar-panel="media"]').click();
  await expect(page2.locator('.media-list')).toContainText('pixel.bin');
  expect(remote.downloadCount).toBeGreaterThanOrEqual(1);

  await context2.close();
});

test('Phase 15 Sync now remains explicit and usable on mobile',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='chromium-mobile');
  const remote=new MockSyncCloud();
  await remote.attach(page);
  await createVault(page,'Mobile Sync');
  await createNote(page,'Phone','# phone');

  const dialog=await signIn(page);
  await dialog.locator('[data-cloud-action="adopt"]').tap();
  await expect(dialog.locator('.cloud-vault-state')).toContainText('Cloud adopted');
  await expect(dialog.locator('[data-cloud-action="sync"]')).toBeEnabled();
  await dialog.locator('[data-cloud-action="sync"]').tap();
  await expect(dialog.locator('.cloud-message')).toContainText('Sync complete');
  await expect(dialog.locator('.cloud-sync-detail')).toContainText('0 queued');
  expect([...remote.entries.values()].some(entry=>entry.name==='Phone.md')).toBe(true);
});
