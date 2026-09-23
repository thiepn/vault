import { expect, test, type Page, type Route } from '@playwright/test';

const PROJECT='https://bskfihouwdogrunnglbg.supabase.co';
const USER='11111111-1111-4111-8111-111111111111';
const ACCOUNT='22222222-2222-4222-8222-222222222222';
const EPOCH='33333333-3333-4333-8333-333333333333';
const ACCESS='phase21-access-token';
const REFRESH='phase21-refresh-token';

const corsHeaders={
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Headers':'authorization,apikey,content-type,prefer',
  'Access-Control-Allow-Methods':'GET,POST,PATCH,OPTIONS',
};

function json(route:Route,body:unknown,status=200){
  return route.fulfill({status,contentType:'application/json',headers:corsHeaders,body:JSON.stringify(body)});
}
function now(){return new Date().toISOString();}

async function installBrowserFakes(page:Page){
  await page.addInitScript(()=>{
    const global=globalThis as any;
    global.__phase21SyncTags=[];
    global.__phase21PeriodicTags=[];

    const registration={
      sync:{register:async(tag:string)=>{global.__phase21SyncTags.push(tag);}},
      periodicSync:{register:async(tag:string,_options:any)=>{global.__phase21PeriodicTags.push(tag);}},
      active:{postMessage:(_message:any,_ports?:any[])=>{}},
    };
    const fakeGet=async()=>registration;
    try{
      Object.defineProperty(navigator.serviceWorker,'getRegistration',{configurable:true,value:fakeGet});
    }catch{
      Object.defineProperty(Object.getPrototypeOf(navigator.serviceWorker),'getRegistration',{configurable:true,value:fakeGet});
    }

    class FakeWebSocket {
      readyState=0;
      private listeners=new Map<string,Function[]>();
      constructor(readonly url:string){
        queueMicrotask(()=>{this.readyState=1;this.emit('open',{});});
      }
      addEventListener(type:string,listener:Function){
        const rows=this.listeners.get(type)??[];
        rows.push(listener);
        this.listeners.set(type,rows);
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
          queueMicrotask(()=>this.message([
            null,null,topic,'presence_state',
            {[local.sessionId]:{metas:[{phx_ref:'self-presence',...local}]}}
          ]));
        }
      }
      close(){if(this.readyState===3)return;this.readyState=3;this.emit('close',{});}
      private message(frame:any[]){this.emit('message',{data:JSON.stringify(frame)});}
      private emit(type:string,event:any){for(const listener of this.listeners.get(type)??[])listener(event);}
    }
    global.WebSocket=FakeWebSocket;
  });
}

async function mockCloud(page:Page){
  let adopted=false;
  let vaultId='';
  let vaultName='';
  let deviceId='';

  await page.route(PROJECT+'/**',async route=>{
    const request=route.request();
    const url=new URL(request.url());
    if(request.method()==='OPTIONS') return route.fulfill({status:204,headers:corsHeaders,body:''});

    if(url.pathname==='/auth/v1/token' && url.searchParams.get('grant_type')==='password'){
      return json(route,{access_token:ACCESS,refresh_token:REFRESH,expires_in:3600});
    }
    if(url.pathname==='/auth/v1/user') return json(route,{id:USER,email:'background@example.test'});
    if(url.pathname==='/auth/v1/logout') return route.fulfill({status:204,headers:corsHeaders,body:''});

    if(url.pathname==='/rest/v1/vault_accounts' && request.method()==='POST'){
      return json(route,[{id:ACCOUNT,auth_user_id:USER,created_at:now()}],201);
    }
    if(url.pathname==='/rest/v1/vault_cloud_devices' && request.method()==='POST'){
      const body=JSON.parse(request.postData()??'{}');
      deviceId=body.id;
      return json(route,[{
        id:deviceId,account_id:ACCOUNT,auth_user_id:USER,label:body.label,platform:'web',
        created_at:now(),last_seen_at:now(),revoked_at:null,
      }],201);
    }
    if(url.pathname==='/rest/v1/vault_cloud_devices' && request.method()==='GET'){
      return json(route,deviceId?[{
        id:deviceId,account_id:ACCOUNT,auth_user_id:USER,label:'Test browser',platform:'web',
        created_at:now(),last_seen_at:now(),revoked_at:null,
      }]:[]);
    }
    if(url.pathname==='/rest/v1/vault_cloud_vaults' && request.method()==='POST'){
      const body=JSON.parse(request.postData()??'{}');
      vaultId=body.id;vaultName=body.name;adopted=true;
      return json(route,[{
        id:vaultId,account_id:ACCOUNT,auth_user_id:USER,name:vaultName,epoch:EPOCH,
        protocol_version:1,created_at:now(),updated_at:now(),disabled_at:null,
      }],201);
    }
    if(url.pathname==='/rest/v1/rpc/vault_accessible_vaults' && request.method()==='POST'){
      return json(route,adopted?[{
        id:vaultId,account_id:ACCOUNT,auth_user_id:USER,
        owner_account_id:ACCOUNT,owner_auth_user_id:USER,access_role:'owner',
        name:vaultName,epoch:EPOCH,protocol_version:1,created_at:now(),updated_at:now(),disabled_at:null,
      }]:[]);
    }
    if(url.pathname==='/rest/v1/rpc/vault_share_members' && request.method()==='POST'){
      return json(route,adopted?[{
        vault_id:vaultId,account_id:ACCOUNT,auth_user_id:USER,role:'owner',created_at:now(),updated_at:now(),
      }]:[]);
    }

    throw new Error('Unexpected Phase 21 cloud request: '+request.method()+' '+request.url());
  });
}

async function confirmTextDialog(page:Page,value:string){
  const dialog=page.locator('.form-dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('#vault-dialog-input').fill(value);
  await dialog.locator('button[value="confirm"]').click();
  await expect(dialog).not.toBeVisible();
}

test('Phase 21 seals background outbox, registers best-effort sync and clears worker auth on sign-out',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='chromium-desktop');
  await installBrowserFakes(page);
  await mockCloud(page);

  await page.goto('/');
  await page.locator('.empty-state [data-command="vault.create"]').click();
  await confirmTextDialog(page,'Background Test');
  await page.locator('[data-command="file.create"]').click();
  await confirmTextDialog(page,'Queued Note');

  const editor=page.locator('.cm-content');
  await editor.click();
  await page.keyboard.type('before adoption');
  await expect(page.locator('.save-status')).toContainText('Saved locally');

  const dialog=page.locator('.cloud-dialog');
  await page.locator('[data-action="cloud-open"]').click();
  await dialog.locator('.cloud-email').fill('background@example.test');
  await dialog.locator('.cloud-password').fill('x'.repeat(16));
  await dialog.locator('[data-cloud-action="sign-in"]').click();
  await expect(dialog.locator('.cloud-signed-in')).toBeVisible();
  await dialog.locator('[data-cloud-action="adopt"]').click();
  await expect(dialog.locator('.cloud-vault-state')).toContainText('Cloud adopted');
  await dialog.locator('button[value="close"]').click();

  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' queued');
  await expect(page.locator('.save-status')).toContainText('Saved locally');

  await expect.poll(()=>page.evaluate(()=>((globalThis as any).__phase21SyncTags as string[]).includes('vault-background-sync')),{timeout:10_000}).toBe(true);
  await expect.poll(()=>page.evaluate(()=>((globalThis as any).__phase21PeriodicTags as string[]).includes('vault-periodic-sync')),{timeout:10_000}).toBe(true);

  const state=await page.evaluate(async()=>{
    const request=indexedDB.open('vault:local');
    const db:IDBDatabase=await new Promise((resolve,reject)=>{
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });
    const read=(store:string,key:string)=>new Promise<any>((resolve,reject)=>{
      const tx=db.transaction(store,'readonly');
      const req=tx.objectStore(store).get(key);
      req.onsuccess=()=>resolve(req.result);
      req.onerror=()=>reject(req.error);
    });
    const all=(store:string)=>new Promise<any[]>((resolve,reject)=>{
      const tx=db.transaction(store,'readonly');
      const req=tx.objectStore(store).getAll();
      req.onsuccess=()=>resolve(req.result);
      req.onerror=()=>reject(req.error);
    });
    const result={
      version:db.version,
      runtime:await read('backgroundRuntime','runtime'),
      status:await read('backgroundRuntime','status'),
      outbox:await all('outbox'),
      inbox:await all('remoteInbox'),
    };
    db.close();
    return result;
  });

  expect(state.version).toBe(5);
  expect(state.runtime.authUserId).toBe(USER);
  expect(state.runtime.session.accessToken).toBe(ACCESS);
  expect(state.status.capability).toBe('registered');
  expect(state.outbox.length).toBeGreaterThan(0);
  expect(state.inbox).toHaveLength(0);

  await page.locator('[data-action="cloud-open"]').click();
  await expect(dialog.locator('.cloud-sync-detail')).toContainText('Background sync queued');
  await dialog.locator('[data-cloud-action="sign-out"]').click();
  await expect(dialog.locator('.cloud-signed-out')).toBeVisible();

  const runtimeAfterSignOut=await page.evaluate(async()=>{
    const request=indexedDB.open('vault:local');
    const db:IDBDatabase=await new Promise((resolve,reject)=>{
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });
    const tx=db.transaction('backgroundRuntime','readonly');
    const req=tx.objectStore('backgroundRuntime').get('runtime');
    const value=await new Promise<any>((resolve,reject)=>{
      req.onsuccess=()=>resolve(req.result);
      req.onerror=()=>reject(req.error);
    });
    db.close();
    return value??null;
  });
  expect(runtimeAfterSignOut).toBeNull();
});
