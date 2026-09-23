import { expect, test, type Page, type Route } from '@playwright/test';

const PROJECT='https://bskfihouwdogrunnglbg.supabase.co';
const USER='11111111-1111-4111-8111-111111111111';
const ACCOUNT='22222222-2222-4222-8222-222222222222';
const EPOCH='33333333-3333-4333-8333-333333333333';
const REMOTE_USER='77777777-7777-4777-8777-777777777777';
const REMOTE_DEVICE='88888888-8888-4888-8888-888888888888';
const REMOTE_SESSION='00000000-0000-4000-8000-000000000001';
const ACCESS='phase23-access-token';
const REFRESH='phase23-refresh-token';

const corsHeaders={
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Headers':'authorization,apikey,content-type,prefer',
  'Access-Control-Allow-Methods':'GET,POST,PATCH,OPTIONS',
};

function clone(value){return structuredClone(value);}
function now(){return new Date().toISOString();}
function json(route:Route,body:unknown,status=200){
  return route.fulfill({status,contentType:'application/json',headers:corsHeaders,body:JSON.stringify(body)});
}

class MockCloud {
  adopted=false;
  vaultId='';
  vaultName='';
  devices=new Map<string,string>();
  entries=new Map<string,any>();
  events:any[]=[];
  operations=new Map<string,{sha:string;result:any}>();

  emit(operationId:string,deviceId:string,kind:string,snapshot:any){
    const event={
      sequence:String(this.events.length+1),
      operationId,entryId:snapshot.entryId,revision:snapshot.revision,kind,deviceId,snapshot:clone(snapshot),
    };
    this.events.push(event);
    return event.sequence;
  }

  async attach(page:Page){
    await page.route(PROJECT+'/**',async route=>{
      const request=route.request();
      const url=new URL(request.url());
      if(request.method()==='OPTIONS') return route.fulfill({status:204,headers:corsHeaders,body:''});

      if(url.pathname==='/auth/v1/token' && url.searchParams.get('grant_type')==='password'){
        return json(route,{access_token:ACCESS,refresh_token:REFRESH,expires_in:3600});
      }
      if(url.pathname==='/auth/v1/user') return json(route,{id:USER,email:'journal@example.test'});
      if(url.pathname==='/auth/v1/logout') return route.fulfill({status:204,headers:corsHeaders,body:''});

      if(url.pathname==='/rest/v1/vault_accounts' && request.method()==='POST'){
        return json(route,[{id:ACCOUNT,auth_user_id:USER,created_at:now()}],201);
      }
      if(url.pathname==='/rest/v1/vault_cloud_devices' && request.method()==='POST'){
        const body=JSON.parse(request.postData()??'{}');
        this.devices.set(body.id,body.label);
        return json(route,[{
          id:body.id,account_id:ACCOUNT,auth_user_id:USER,label:body.label,platform:'web',
          created_at:now(),last_seen_at:now(),revoked_at:null,
        }],201);
      }
      if(url.pathname==='/rest/v1/vault_cloud_devices' && request.method()==='GET'){
        return json(route,[...this.devices].map(([id,label])=>({
          id,account_id:ACCOUNT,auth_user_id:USER,label,platform:'web',
          created_at:now(),last_seen_at:now(),revoked_at:null,
        })));
      }
      if(url.pathname==='/rest/v1/vault_cloud_vaults' && request.method()==='POST'){
        const body=JSON.parse(request.postData()??'{}');
        this.vaultId=body.id;this.vaultName=body.name;this.adopted=true;
        return json(route,[{
          id:this.vaultId,account_id:ACCOUNT,auth_user_id:USER,name:this.vaultName,epoch:EPOCH,
          protocol_version:1,created_at:now(),updated_at:now(),disabled_at:null,
        }],201);
      }
      if(url.pathname==='/rest/v1/rpc/vault_accessible_vaults' && request.method()==='POST'){
        return json(route,this.adopted?[{
          id:this.vaultId,account_id:ACCOUNT,auth_user_id:USER,
          owner_account_id:ACCOUNT,owner_auth_user_id:USER,access_role:'owner',
          name:this.vaultName,epoch:EPOCH,protocol_version:1,created_at:now(),updated_at:now(),disabled_at:null,
        }]:[]);
      }
      if(url.pathname==='/rest/v1/rpc/vault_share_members' && request.method()==='POST'){
        return json(route,this.adopted?[{
          vault_id:this.vaultId,account_id:ACCOUNT,auth_user_id:USER,role:'owner',
          created_at:now(),updated_at:now(),
        }]:[]);
      }
      if(url.pathname==='/rest/v1/rpc/vault_sync_pull' && request.method()==='POST'){
        const body=JSON.parse(request.postData()??'{}');
        const start=Number(body.p_after);
        const selected=this.events.slice(start,start+(body.p_limit??500));
        return json(route,{
          protocolVersion:1,vaultId:this.vaultId,epoch:EPOCH,after:String(body.p_after),
          through:selected.length?selected[selected.length-1].sequence:String(body.p_after),
          highWatermark:String(this.events.length),events:clone(selected),
        });
      }
      if(url.pathname==='/rest/v1/rpc/vault_sync_push' && request.method()==='POST'){
        const envelope=JSON.parse(request.postData()??'{}');
        const operation=envelope.p_wire;
        const prior=this.operations.get(operation.id);
        if(prior) return json(route,clone(prior.result));

        const snapshots=[];
        let through=String(this.events.length);
        for(const mutation of operation.mutations){
          let current=this.entries.get(mutation.entryId);
          if(mutation.kind==='create'){
            current={
              entryId:mutation.entryId,vaultId:this.vaultId,parentId:mutation.parentId,name:mutation.name,
              kind:mutation.entryKind,revision:1,deletedAt:null,updatedAt:now(),updatedByDevice:operation.deviceId,
              text:mutation.entryKind==='markdown'?mutation.text:null,
              attachmentSha256:null,attachmentMimeType:null,attachmentSize:null,
            };
          }else{
            if(!current || current.revision!==mutation.baseRevision){
              return json(route,{message:JSON.stringify({status:'conflict',reason:'revision',entryId:mutation.entryId,current:current??null})},409);
            }
            current={...current,revision:current.revision+1,updatedAt:now(),updatedByDevice:operation.deviceId};
            if(mutation.kind==='write') current.text=mutation.text;
            if(mutation.kind==='move'){current.parentId=mutation.parentId;current.name=mutation.name;}
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

      throw new Error('Unexpected Phase 23 cloud request: '+request.method()+' '+request.url());
    });
  }
}

async function installRealtimeFake(page:Page){
  await page.addInitScript(({remoteUser,remoteDevice,remoteSession})=>{
    class FakeWebSocket {
      readyState=0;
      private listeners=new Map<string,Function[]>();
      constructor(readonly url:string){
        queueMicrotask(()=>{this.readyState=1;this.emit('open',{});});
      }
      addEventListener(type:string,listener:Function){
        const rows=this.listeners.get(type)??[];
        rows.push(listener);this.listeners.set(type,rows);
      }
      send(raw:string){
        let frame:any;
        try{frame=JSON.parse(raw);}catch{return;}
        if(!Array.isArray(frame)) return;
        const [joinRef,ref,topic,event,payload]=frame;
        if(event==='phx_join'){
          queueMicrotask(()=>this.message([joinRef,ref,topic,'phx_reply',{status:'ok',response:{}}]));
          return;
        }
        if(event==='presence' && payload?.event==='track' && typeof topic==='string' && topic.startsWith('realtime:vault-collab:')){
          const local=payload.payload;
          const remote={
            ...local,
            userId:remoteUser,
            deviceId:remoteDevice,
            sessionId:remoteSession,
            role:'editor',
            onlineAt:new Date().toISOString(),
          };
          queueMicrotask(()=>this.message([
            null,null,topic,'presence_state',
            {
              [local.sessionId]:{metas:[{phx_ref:'self-presence',...local}]},
              [remoteSession]:{metas:[{phx_ref:'remote-presence',...remote}]},
            }
          ]));
        }
      }
      close(){if(this.readyState===3)return;this.readyState=3;this.emit('close',{});}
      private message(frame:any[]){this.emit('message',{data:JSON.stringify(frame)});}
      private emit(type:string,event:any){for(const listener of this.listeners.get(type)??[])listener(event);}
    }
    (globalThis as any).WebSocket=FakeWebSocket;
  },{remoteUser:REMOTE_USER,remoteDevice:REMOTE_DEVICE,remoteSession:REMOTE_SESSION});
}

async function confirmTextDialog(page:Page,value:string){
  const dialog=page.locator('.form-dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('#vault-dialog-input').fill(value);
  await dialog.locator('button[value="confirm"]').click();
  await expect(dialog).not.toBeVisible();
}

test('Phase 23 replays follower CRDT history after reload and recovers it as a new note',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='chromium-desktop');
  const cloud=new MockCloud();
  await installRealtimeFake(page);
  await cloud.attach(page);

  await page.goto('/');
  await page.locator('.empty-state [data-command="vault.create"]').click();
  await confirmTextDialog(page,'Journal Test');
  await page.locator('[data-command="file.create"]').click();
  await confirmTextDialog(page,'Shared Note');

  const editor=page.locator('.cm-content');
  await editor.click();
  await page.keyboard.insertText('canonical seed');
  await expect(page.locator('.save-status')).toContainText('Saved locally');

  const dialog=page.locator('.cloud-dialog');
  await page.locator('[data-action="cloud-open"]').click();
  await dialog.locator('.cloud-email').fill('journal@example.test');
  await dialog.locator('.cloud-password').fill('x'.repeat(16));
  await dialog.locator('[data-cloud-action="sign-in"]').click();
  await expect(dialog.locator('.cloud-signed-in')).toBeVisible();
  await dialog.locator('[data-cloud-action="adopt"]').click();
  await expect(dialog.locator('.cloud-vault-state')).toContainText('Cloud adopted');
  await dialog.locator('[data-cloud-action="sync"]').click();
  await expect(dialog.locator('.cloud-message')).toContainText('Sync complete',{timeout:10_000});
  await dialog.locator('button[value="close"]').click();

  await expect(page.locator('.collaboration-status')).toContainText('collaborating',{timeout:10_000});
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.insertText(' follower draft');
  await expect(editor).toContainText('canonical seed follower draft');

  await expect.poll(()=>page.evaluate(async()=>{
    const request=indexedDB.open('vault:local');
    const db:IDBDatabase=await new Promise((resolve,reject)=>{
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });
    const tx=db.transaction('crdtUpdates','readonly');
    const req=tx.objectStore('crdtUpdates').getAll();
    const rows=await new Promise<any[]>((resolve,reject)=>{
      req.onsuccess=()=>resolve(req.result);
      req.onerror=()=>reject(req.error);
    });
    db.close();
    return rows.length;
  }),{timeout:10_000}).toBeGreaterThan(0);

  const canonicalBeforeReload=await page.evaluate(async()=>{
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
    const note=entries.find(row=>row.name==='Shared Note.md');
    const contentReq=tx.objectStore('contents').get(note.id);
    const content=await new Promise<any>((resolve,reject)=>{
      contentReq.onsuccess=()=>resolve(contentReq.result);
      contentReq.onerror=()=>reject(contentReq.error);
    });
    db.close();
    return content.text;
  });
  expect(canonicalBeforeReload).toBe('canonical seed');

  await page.reload();
  await expect(page.locator('.cm-content')).toContainText('canonical seed follower draft',{timeout:15_000});
  await expect(page.locator('.collaboration-status')).toContainText('collaborating');

  const historyButton=page.locator('[data-action="journal-open"]');
  await expect(historyButton).toBeVisible();
  await expect(historyButton).toBeEnabled();
  await historyButton.click();

  const history=page.locator('.journal-dialog');
  await expect(history).toBeVisible();
  await expect(history.locator('#journal-preview')).toHaveValue(/canonical seed follower draft/u);
  await expect(history.locator('.journal-meta')).toContainText('Base revision 1');

  await history.locator('[data-journal-action="recover"]').click();
  await confirmTextDialog(page,'Recovered collaboration');
  await expect(history).not.toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('canonical seed follower draft');

  const recovered=await page.evaluate(async()=>{
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
    const note=entries.find(row=>row.name==='Recovered collaboration.md');
    const contentReq=tx.objectStore('contents').get(note.id);
    const content=await new Promise<any>((resolve,reject)=>{
      contentReq.onsuccess=()=>resolve(contentReq.result);
      contentReq.onerror=()=>reject(contentReq.error);
    });
    db.close();
    return content.text;
  });
  expect(recovered).toBe('canonical seed follower draft');
});
