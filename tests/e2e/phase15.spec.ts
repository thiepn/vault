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
  'Access-Control-Allow-Headers':'authorization,apikey,content-type,prefer,x-upsert,cache-control',
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
  protocolVersion:1|2=1;
  calls:string[]=[];
  devices=new Map<string,string>();
  keyReady=false;
  keyDeviceId='';
  keyFingerprint='';
  keyPublicSpki='';
  keyEnvelope:any=null;
  v2Heads=new Map<string,any>();
  v2Events:any[]=[];
  v2Operations=new Map<string,{wire:string;sha:string;result:any}>();
  v2Wires:string[]=[];
  v2Blobs=new Map<string,Buffer>();
  v2BlobReady=new Set<string>();
  v2BlobUploadCount=0;
  v2BlobDownloadCount=0;
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
      this.calls.push(request.method()+' '+url.pathname);
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
          name:this.remoteVaultName,epoch,protocol_version:this.protocolVersion,
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
          protocol_version:this.protocolVersion,created_at:'2026-09-22T12:00:00.000Z',updated_at:now(),disabled_at:null,
        }],201);
      }
      if(url.pathname==='/rest/v1/vault_cloud_vaults' && request.method()==='GET'){
        return json(route,this.adopted?[{
          id:this.remoteVaultId,account_id:accountId,auth_user_id:userId,name:this.remoteVaultName,epoch,
          protocol_version:this.protocolVersion,created_at:'2026-09-22T12:00:00.000Z',updated_at:now(),disabled_at:null,
        }]:[]);
      }

      if(url.pathname==='/rest/v1/rpc/vault_sync_capabilities_v2' && request.method()==='POST'){
        return json(route,{
          contractVersion:1,
          protocolVersions:[1,2],
          encryptedContentV2:{contractAvailable:true,acceptingContent:true},
          encryptedBlobsV2:{
            contractAvailable:true,acceptingContent:true,bucket:'vault-e2ee-blobs',
            maxCiphertextBytes:134217764,
          },
          maxMutations:1000,
          maxPageEvents:1000,
        });
      }

      if(url.pathname==='/rest/v1/rpc/vault_key_readiness' && request.method()==='POST'){
        const body=JSON.parse(request.postData()??'{}');
        return json(route,{
          vaultId:this.remoteVaultId,
          deviceId:body.p_device_id,
          keyGeneration:this.keyReady?1:null,
          deviceEnvelope:this.keyReady,
          recoveryEnvelope:this.keyReady,
          deviceAuthorized:this.keyReady,
          ready:this.keyReady,
        });
      }

      if(url.pathname==='/rest/v1/rpc/vault_key_register_device' && request.method()==='POST'){
        const body=JSON.parse(request.postData()??'{}');
        this.keyDeviceId=body.p_device_id;
        this.keyFingerprint=body.p_fingerprint;
        this.keyPublicSpki=body.p_public_spki;
        return json(route,{registered:true});
      }

      if(url.pathname==='/rest/v1/rpc/vault_key_initialize_vault' && request.method()==='POST'){
        const body=JSON.parse(request.postData()??'{}');
        expect(body.p_account_id).toBe(accountId);
        expect(body.p_vault_id).toBe(this.remoteVaultId);
        expect(body.p_device_id).toBe(this.keyDeviceId);
        expect(body.p_key_generation).toBe(1);
        expect(body.p_public_key_fingerprint).toBe(this.keyFingerprint);
        this.keyEnvelope={
          version:1,
          accountId,
          vaultId:this.remoteVaultId,
          deviceId:this.keyDeviceId,
          keyGeneration:1,
          algorithm:'RSA-OAEP-3072-SHA256',
          publicKeyFingerprint:this.keyFingerprint,
          ciphertext:body.p_device_ciphertext,
          createdAt:now(),
        };
        this.keyReady=true;
        return json(route,{
          vaultId:this.remoteVaultId,
          deviceId:this.keyDeviceId,
          keyGeneration:1,
          deviceEnvelope:true,
          recoveryEnvelope:true,
          deviceAuthorized:true,
          ready:true,
        });
      }

      if(url.pathname==='/rest/v1/rpc/vault_key_device_envelopes' && request.method()==='POST'){
        return json(route,this.keyEnvelope?[clone(this.keyEnvelope)]:[]);
      }

      if(url.pathname==='/rest/v1/rpc/vault_sync_upgrade_v2' && request.method()==='POST'){
        const body=JSON.parse(request.postData()??'{}');
        expect(body.p_vault_id).toBe(this.remoteVaultId);
        expect(body.p_device_id).toBe(this.keyDeviceId);
        expect(this.keyReady).toBe(true);
        this.protocolVersion=2;
        return json(route,{vaultId:this.remoteVaultId,epoch,protocolVersion:2});
      }

      if(url.pathname==='/rest/v1/rpc/vault_sync_prepare_blob_v2' && request.method()==='POST'){
        const body=JSON.parse(request.postData()??'{}');
        const path=`${body.p_vault_id}/${body.p_key_generation}/${body.p_blob_id}`;
        const existing=this.v2Blobs.get(path);
        if(existing){
          expect(existing.byteLength).toBe(body.p_ciphertext_size);
          this.v2BlobReady.add(path);
        }
        return json(route,{
          status:existing?'ready':'upload',
          bucket:'vault-e2ee-blobs',
          path,
          blobId:body.p_blob_id,
          keyGeneration:body.p_key_generation,
          ciphertextSize:body.p_ciphertext_size,
        });
      }

      if(url.pathname==='/rest/v1/rpc/vault_sync_commit_blob_v2' && request.method()==='POST'){
        const body=JSON.parse(request.postData()??'{}');
        const path=`${body.p_vault_id}/${body.p_key_generation}/${body.p_blob_id}`;
        const existing=this.v2Blobs.get(path);
        expect(existing).toBeTruthy();
        expect(existing!.byteLength).toBe(body.p_ciphertext_size);
        this.v2BlobReady.add(path);
        return json(route,{
          status:'ready',bucket:'vault-e2ee-blobs',path,
          blobId:body.p_blob_id,keyGeneration:body.p_key_generation,
          ciphertextSize:body.p_ciphertext_size,
        });
      }

      if(url.pathname==='/rest/v1/rpc/vault_sync_pull_v2' && request.method()==='POST'){
        const body=JSON.parse(request.postData()??'{}');
        expect(body.p_vault_id).toBe(this.remoteVaultId);
        expect(body.p_epoch).toBe(epoch);
        expect(body.p_device_id).toBe(this.keyDeviceId);
        const after=BigInt(body.p_after);
        const selected=this.v2Events
          .filter(event=>BigInt(event.sequence)>after)
          .slice(0,body.p_limit??500);
        return json(route,{
          protocolVersion:2,
          vaultId:this.remoteVaultId,
          epoch,
          after:String(body.p_after),
          through:selected.at(-1)?.sequence??String(body.p_after),
          highWatermark:String(this.v2Events.length),
          events:clone(selected),
        });
      }

      if(url.pathname==='/rest/v1/rpc/vault_sync_push_v2' && request.method()==='POST'){
        const envelope=JSON.parse(request.postData()??'{}');
        expect(typeof envelope.p_wire).toBe('string');
        const wire=envelope.p_wire as string;
        this.v2Wires.push(wire);
        const operation=JSON.parse(wire);
        const prior=this.v2Operations.get(operation.operationId);
        if(prior){
          expect(prior.wire).toBe(wire);
          expect(prior.sha).toBe(envelope.p_sha256);
          return json(route,clone(prior.result));
        }

        const snapshots:any[]=[];
        const first=String(this.v2Events.length+1);
        for(const mutation of operation.mutations){
          if(mutation.entityType==='attachment'){
            const blobPath=`${this.remoteVaultId}/${mutation.payload.keyGeneration}/${mutation.structural.blobId}`;
            if(!this.v2BlobReady.has(blobPath)) throw new Error('encrypted attachment entity arrived before READY blob');
          }
          const priorHead=this.v2Heads.get(mutation.entityId);
          const revision=priorHead?Number(priorHead.remoteRevision)+1:1;
          const sequence=String(this.v2Events.length+1);
          const snapshot={
            entityId:mutation.entityId,
            vaultId:this.remoteVaultId,
            entityType:mutation.entityType,
            remoteRevision:String(revision),
            sequence,
            schemaVersion:mutation.schemaVersion,
            structural:clone(mutation.structural),
            payload:clone(mutation.payload),
            operationId:operation.operationId,
            updatedByDevice:operation.deviceId,
            updatedAt:now(),
          };
          this.v2Heads.set(mutation.entityId,clone(snapshot));
          const event={
            sequence,
            operationId:operation.operationId,
            entityId:mutation.entityId,
            entityType:mutation.entityType,
            remoteRevision:String(revision),
            kind:'put',
            snapshot:clone(snapshot),
          };
          this.v2Events.push(event);
          snapshots.push(snapshot);
        }
        const result={
          status:'ok',
          operationId:operation.operationId,
          firstSequence:first,
          through:String(this.v2Events.length),
          snapshots,
        };
        this.v2Operations.set(operation.operationId,{wire,sha:envelope.p_sha256,result:clone(result)});
        return json(route,result);
      }

      if(url.pathname==='/rest/v1/rpc/vault_sync_ack_v2' && request.method()==='POST'){
        const body=JSON.parse(request.postData()??'{}');
        return json(route,{
          vaultId:this.remoteVaultId,
          epoch,
          acknowledgedThrough:String(body.p_through),
          highWatermark:String(this.v2Events.length),
        });
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

      const encryptedStoragePrefix='/storage/v1/object/vault-e2ee-blobs/';
      if(url.pathname.startsWith(encryptedStoragePrefix)){
        const path=url.pathname.slice(encryptedStoragePrefix.length).split('/').map(decodeURIComponent).join('/');
        if(request.method()==='POST'){
          if(this.v2Blobs.has(path)) return json(route,{message:'already exists'},409);
          const bytes=request.postDataBuffer()??Buffer.alloc(0);
          this.v2Blobs.set(path,Buffer.from(bytes));
          this.v2BlobUploadCount++;
          return json(route,{Key:path},201);
        }
        if(request.method()==='GET'){
          const bytes=this.v2Blobs.get(path);
          if(!bytes)return json(route,{message:'not found'},404);
          this.v2BlobDownloadCount++;
          return route.fulfill({
            status:200,
            headers:{...corsHeaders,'Content-Type':'application/octet-stream'},
            body:bytes,
          });
        }
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

test('Phase 15 legacy owner adoption cannot upload plaintext before E2EE activation',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='chromium-desktop');
  const remote=new MockSyncCloud();
  await remote.attach(page);

  await createVault(page,'Shared Vault');
  await createNote(page,'Shared','# original');
  await page.locator('.attachment-file-input').setInputFiles({
    name:'pixel.bin',mimeType:'application/octet-stream',buffer:Buffer.from([1,2,3,4]),
  });
  await expect(page.locator('.save-status')).toContainText('Saved locally');

  const dialog=await signIn(page);
  await dialog.locator('[data-cloud-action="adopt"]').click();
  await expect(dialog.locator('.cloud-vault-state')).toContainText('Cloud linked');
  await expect(dialog.locator('.cloud-vault-state')).toContainText('no canonical content uploaded');
  await expect(dialog.locator('.cloud-sync-detail')).toContainText('end-to-end encryption setup required');
  await expect(dialog.locator('[data-cloud-action="sync"]')).toBeDisabled();
  await expect(dialog.locator('[data-cloud-action="activate-encrypted"]')).toBeEnabled();

  expect(remote.uploadCount).toBe(0);
  expect(remote.entries.size).toBe(0);
  expect(remote.calls.some(call=>call.includes('/rest/v1/rpc/vault_sync_push'))).toBe(false);
  expect(remote.calls.some(call=>call.includes('/storage/v1/object/vault-sync/'))).toBe(false);

  await dialog.locator('button[value="close"]').click();
  await quickOpen(page,'Shared');
  expect(await sourceText(page)).toContain('# original');
  await ensureSidebarOpen(page);
  await page.locator('[data-sidebar-panel="media"]').click();
  await expect(page.locator('.media-list')).toContainText('pixel.bin');
});

test('Phase 15 mobile owner Sync now remains blocked until encrypted setup',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='chromium-mobile');
  const remote=new MockSyncCloud();
  await remote.attach(page);
  await createVault(page,'Mobile Sync');
  await createNote(page,'Phone','# phone');

  const dialog=await signIn(page);
  await dialog.locator('[data-cloud-action="adopt"]').tap();
  await expect(dialog.locator('.cloud-vault-state')).toContainText('Cloud linked');
  await expect(dialog.locator('.cloud-vault-state')).toContainText('E2EE setup required');
  await expect(dialog.locator('[data-cloud-action="sync"]')).toBeDisabled();
  await expect(dialog.locator('[data-cloud-action="activate-encrypted"]')).toBeEnabled();
  expect(remote.entries.size).toBe(0);
  expect(remote.calls.some(call=>call.includes('/rest/v1/rpc/vault_sync_push'))).toBe(false);
});


test('I5 browser activates E2EE and syncs Note content only as Protocol v2 ciphertext',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='chromium-desktop');
  test.setTimeout(60_000);
  const remote=new MockSyncCloud();
  await remote.attach(page);

  const secretMarkdown='# browser plaintext must stay local\nprivate sentence 4917';
  await createVault(page,'Encrypted Browser Vault');
  await createNote(page,'Cipher Note',secretMarkdown);

  const dialog=await signIn(page);
  await dialog.locator('[data-cloud-action="adopt"]').click();
  await expect(dialog.locator('.cloud-vault-state')).toContainText('Cloud linked');
  await expect(dialog.locator('[data-cloud-action="sync"]')).toBeDisabled();

  await dialog.locator('[data-cloud-action="activate-encrypted"]').click();
  const recovery=dialog.locator('textarea[aria-label="Vault Recovery Code"]');
  await expect(recovery).toBeVisible({timeout:20_000});
  await expect(recovery).toHaveValue(/^VLT1-/);
  await dialog.locator('.cloud-vault-state input[type="checkbox"]').check();
  await dialog.getByRole('button',{name:'Enable encrypted sync'}).click();

  await expect(dialog.locator('.cloud-vault-state')).toContainText('End-to-end encrypted',{timeout:20_000});
  await expect(dialog.locator('.cloud-vault-state')).toContainText('Protocol v2');
  await expect(dialog.locator('[data-cloud-action="sync"]')).toBeEnabled();
  expect(remote.protocolVersion).toBe(2);
  expect(remote.keyReady).toBe(true);

  await dialog.locator('[data-cloud-action="sync"]').click();
  await expect(dialog.locator('.cloud-message')).toContainText('Encrypted sync complete',{timeout:20_000});
  await expect(dialog.locator('.cloud-sync-detail')).toContainText('0 queued');

  expect(remote.v2Wires.length).toBeGreaterThan(0);
  expect(remote.v2Heads.size).toBeGreaterThan(0);
  expect(remote.calls.filter(call=>call==='POST /rest/v1/rpc/vault_sync_push')).toHaveLength(0);
  expect(remote.calls.some(call=>call==='POST /rest/v1/rpc/vault_sync_push_v2')).toBe(true);

  for(const wire of remote.v2Wires){
    expect(wire).not.toContain('browser plaintext must stay local');
    expect(wire).not.toContain('private sentence 4917');
    expect(wire).not.toContain('Cipher Note');
    const operation=JSON.parse(wire);
    expect(operation.protocolVersion).toBe(2);
    expect(operation.accountId).toBe(accountId);
    for(const mutation of operation.mutations){
      expect(mutation.kind).toBe('put');
      expect(mutation.payload.algorithm).toBe('A256GCM');
      expect(typeof mutation.payload.ciphertext).toBe('string');
      expect(mutation.payload.ciphertext.length).toBeGreaterThan(20);
      expect('text' in mutation).toBe(false);
      expect('name' in mutation).toBe(false);
      expect('mimeType' in mutation).toBe(false);
    }
  }

  await dialog.locator('button[value="close"]').click();
  await quickOpen(page,'Cipher Note');
  expect(await sourceText(page)).toContain('private sentence 4917');
  await expect(page.locator('.save-status')).toContainText('synced');
});


test('I7 browser sync keeps Attachment metadata and bytes encrypted and rehydrates exact plaintext',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='chromium-desktop');
  test.setTimeout(60_000);
  const remote=new MockSyncCloud();
  await remote.attach(page);

  const secret=Buffer.from('I7-BROWSER-PLAINTEXT-ATTACHMENT-4917','utf8');
  await createVault(page,'Encrypted Attachment Vault');
  await createNote(page,'Carrier','# encrypted attachment carrier');
  await page.locator('.attachment-file-input').setInputFiles({
    name:'secret-contract.bin',
    mimeType:'application/octet-stream',
    buffer:secret,
  });
  let attachmentId='';
  await expect.poll(async()=>{
    attachmentId=await page.evaluate(async()=>{
      const request=indexedDB.open('vault:local');
      const db:IDBDatabase=await new Promise((resolve,reject)=>{
        request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
      });
      const tx=db.transaction('entries','readonly');
      const req=tx.objectStore('entries').getAll();
      const rows=await new Promise<any[]>((resolve,reject)=>{
        req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
      });
      db.close();
      return rows.find(row=>row.name==='secret-contract.bin')?.id ?? '';
    });
    return attachmentId;
  },{timeout:10_000}).toMatch(/^[0-9a-f-]{36}$/u);

  const dialog=await signIn(page);
  await dialog.locator('[data-cloud-action="adopt"]').click();
  await dialog.locator('[data-cloud-action="activate-encrypted"]').click();
  const recovery=dialog.locator('textarea[aria-label="Vault Recovery Code"]');
  await expect(recovery).toBeVisible({timeout:20_000});
  await dialog.locator('.cloud-vault-state input[type="checkbox"]').check();
  await dialog.getByRole('button',{name:'Enable encrypted sync'}).click();
  await expect(dialog.locator('.cloud-vault-state')).toContainText('End-to-end encrypted',{timeout:20_000});

  await dialog.locator('[data-cloud-action="sync"]').click();
  await expect(dialog.locator('.cloud-message')).toContainText('Encrypted sync complete',{timeout:20_000});
  await expect(dialog.locator('.cloud-message')).toContainText('encrypted blob');
  expect(remote.v2BlobUploadCount).toBe(1);
  expect(remote.v2Blobs.size).toBe(1);

  const [blobPath,blobBytes]=[...remote.v2Blobs.entries()][0];
  expect(blobPath).toMatch(new RegExp('^'+remote.remoteVaultId+'/1/[A-Za-z0-9_-]{43}$','u'));
  expect(blobPath).not.toContain('secret-contract');
  expect(blobBytes.includes(secret)).toBe(false);
  expect(blobBytes.toString('utf8')).not.toContain('I7-BROWSER-PLAINTEXT-ATTACHMENT-4917');

  const attachmentWire=remote.v2Wires
    .map(wire=>({wire,operation:JSON.parse(wire)}))
    .find(item=>item.operation.mutations.some((mutation:any)=>mutation.entityType==='attachment'));
  expect(attachmentWire).toBeTruthy();
  expect(attachmentWire!.wire).not.toContain('secret-contract.bin');
  expect(attachmentWire!.wire).not.toContain('application/octet-stream');
  expect(attachmentWire!.wire).not.toContain('I7-BROWSER-PLAINTEXT-ATTACHMENT-4917');

  const attachmentEvent=remote.v2Events.find(event=>event.entityId===attachmentId);
  expect(attachmentEvent).toBeTruthy();

  // Simulate a clean device that has metadata/key material but lacks this local
  // Attachment replica. Rewind only to the event immediately before the
  // Attachment and require authenticated hydration on the next sync.
  await page.evaluate(async({attachmentId,cursor,vaultId,accountId,epoch})=>{
    const request=indexedDB.open('vault:local');
    const db:IDBDatabase=await new Promise((resolve,reject)=>{
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
    });
    const tx=db.transaction(['entries','attachments','dirty','remoteShadows','syncCursors'],'readwrite');
    tx.objectStore('entries').delete(attachmentId);
    tx.objectStore('attachments').delete(attachmentId);
    tx.objectStore('dirty').delete(attachmentId);
    tx.objectStore('remoteShadows').delete(attachmentId);
    tx.objectStore('syncCursors').put({
      protocolVersion:2,
      vaultId,
      accountId,
      epoch,
      cursor:String(cursor),
      updatedAt:new Date().toISOString(),
    });
    await new Promise<void>((resolve,reject)=>{
      tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);tx.onerror=()=>reject(tx.error);
    });
    db.close();
  },{
    attachmentId,
    cursor:Number(attachmentEvent.sequence)-1,
    vaultId:remote.remoteVaultId,
    accountId,
    epoch,
  });

  await dialog.locator('[data-cloud-action="sync"]').click();
  await expect.poll(()=>remote.v2BlobDownloadCount,{timeout:20_000}).toBeGreaterThanOrEqual(1);
  await expect(dialog.locator('.cloud-message')).toContainText('Encrypted sync complete',{timeout:20_000});

  const restored=await expect.poll(async()=>page.evaluate(async attachmentId=>{
    const request=indexedDB.open('vault:local');
    const db:IDBDatabase=await new Promise((resolve,reject)=>{
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
    });
    const tx=db.transaction(['entries','attachments'],'readonly');
    const entryReq=tx.objectStore('entries').get(attachmentId);
    const bytesReq=tx.objectStore('attachments').get(attachmentId);
    const [entry,attachment]=await Promise.all([
      new Promise<any>((resolve,reject)=>{entryReq.onsuccess=()=>resolve(entryReq.result);entryReq.onerror=()=>reject(entryReq.error);}),
      new Promise<any>((resolve,reject)=>{bytesReq.onsuccess=()=>resolve(bytesReq.result);bytesReq.onerror=()=>reject(bytesReq.error);}),
    ]);
    db.close();
    if(!entry||!attachment)return null;
    return {entry,attachment:{...attachment,bytes:[...attachment.bytes]}};
  },attachmentId),{timeout:20_000}).not.toBeNull();

  const restored=await page.evaluate(async attachmentId=>{
    const request=indexedDB.open('vault:local');
    const db:IDBDatabase=await new Promise((resolve,reject)=>{
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
    });
    const tx=db.transaction(['entries','attachments'],'readonly');
    const entryReq=tx.objectStore('entries').get(attachmentId);
    const bytesReq=tx.objectStore('attachments').get(attachmentId);
    const [entry,attachment]=await Promise.all([
      new Promise<any>((resolve,reject)=>{entryReq.onsuccess=()=>resolve(entryReq.result);entryReq.onerror=()=>reject(entryReq.error);}),
      new Promise<any>((resolve,reject)=>{bytesReq.onsuccess=()=>resolve(bytesReq.result);bytesReq.onerror=()=>reject(bytesReq.error);}),
    ]);
    db.close();
    return {entry,attachment:{...attachment,bytes:[...attachment.bytes]}};
  },attachmentId);
  expect(restored.entry.name).toBe('secret-contract.bin');
  expect(restored.attachment.mimeType).toBe('application/octet-stream');
  expect(restored.attachment.bytes).toEqual([...secret]);
});
