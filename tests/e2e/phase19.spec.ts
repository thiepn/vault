import { expect, test, type Page, type Route } from '@playwright/test';

const PROJECT='https://bskfihouwdogrunnglbg.supabase.co';
const USER='11111111-1111-4111-8111-111111111111';
const ACCOUNT='22222222-2222-4222-8222-222222222222';
const EPOCH='33333333-3333-4333-8333-333333333333';
const REMOTE_USER='66666666-6666-4666-8666-666666666666';
const REMOTE_DEVICE='77777777-7777-4777-8777-777777777777';
const REMOTE_SESSION='88888888-8888-4888-8888-888888888888';
const ACCESS='phase19-access-token';
const REFRESH='phase19-refresh-token';
const NOTE_TEXT='hello collaboration';

const corsHeaders={
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Headers':'authorization,apikey,content-type,prefer',
  'Access-Control-Allow-Methods':'GET,POST,PATCH,OPTIONS',
};

function json(route:Route,body:unknown,status=200){
  return route.fulfill({status,contentType:'application/json',headers:corsHeaders,body:JSON.stringify(body)});
}

async function installRealtimeFake(page:Page){
  await page.addInitScript(({remoteUser,remoteDevice,remoteSession,noteText})=>{
    const fingerprint=(text:string)=>{
      let hash=2166136261;
      for(let index=0;index<text.length;index++){
        hash^=text.charCodeAt(index);
        hash=Math.imul(hash,16777619);
      }
      return (hash>>>0).toString(16).padStart(8,'0');
    };

    class FakeWebSocket {
      readyState=0;
      private listeners=new Map<string,Function[]>();
      constructor(readonly url:string){
        queueMicrotask(()=>{
          this.readyState=1;
          this.emit('open',{});
        });
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
          if(!local?.entryId) return;
          const remotePresence={
            version:1,vaultId:local.vaultId,userId:remoteUser,deviceId:remoteDevice,sessionId:remoteSession,
            role:'editor',entryId:local.entryId,mode:'live',onlineAt:new Date().toISOString(),
          };
          window.setTimeout(()=>this.message([
            null,null,topic,'presence_state',
            {[remoteSession]:{metas:[{phx_ref:'remote-presence',...remotePresence}]}}
          ]),15);
          window.setTimeout(()=>this.message([
            null,null,topic,'broadcast',
            {event:'cursor',type:'broadcast',payload:{
              version:1,vaultId:local.vaultId,entryId:local.entryId,userId:remoteUser,deviceId:remoteDevice,sessionId:remoteSession,
              position:5,from:0,to:5,documentFingerprint:fingerprint(noteText),at:new Date().toISOString(),
            }}
          ]),35);
        }
      }
      close(){
        if(this.readyState===3)return;
        this.readyState=3;
        this.emit('close',{});
      }
      private message(frame:any[]){this.emit('message',{data:JSON.stringify(frame)});}
      private emit(type:string,event:any){for(const listener of this.listeners.get(type)??[])listener(event);}
    }

    (globalThis as any).WebSocket=FakeWebSocket;
  },{remoteUser:REMOTE_USER,remoteDevice:REMOTE_DEVICE,remoteSession:REMOTE_SESSION,noteText:NOTE_TEXT});
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
    if(url.pathname==='/auth/v1/user') return json(route,{id:USER,email:'presence@example.test'});
    if(url.pathname==='/auth/v1/logout') return route.fulfill({status:204,headers:corsHeaders,body:''});

    if(url.pathname==='/rest/v1/vault_accounts' && request.method()==='POST'){
      return json(route,[{id:ACCOUNT,auth_user_id:USER,created_at:'2026-09-22T21:00:00.000Z'}],201);
    }
    if(url.pathname==='/rest/v1/vault_cloud_devices' && request.method()==='POST'){
      const body=JSON.parse(request.postData()??'{}');
      deviceId=body.id;
      return json(route,[{
        id:body.id,account_id:ACCOUNT,auth_user_id:USER,label:body.label,platform:'web',
        created_at:'2026-09-22T21:00:00.000Z',last_seen_at:'2026-09-22T21:00:00.000Z',revoked_at:null,
      }],201);
    }
    if(url.pathname==='/rest/v1/vault_cloud_devices' && request.method()==='GET'){
      return json(route,deviceId?[{
        id:deviceId,account_id:ACCOUNT,auth_user_id:USER,label:'Test browser',platform:'web',
        created_at:'2026-09-22T21:00:00.000Z',last_seen_at:'2026-09-22T21:00:00.000Z',revoked_at:null,
      }]:[]);
    }

    if(url.pathname==='/rest/v1/vault_cloud_vaults' && request.method()==='POST'){
      const body=JSON.parse(request.postData()??'{}');
      vaultId=body.id; vaultName=body.name; adopted=true;
      return json(route,[{
        id:vaultId,account_id:ACCOUNT,auth_user_id:USER,name:vaultName,epoch:EPOCH,
        protocol_version:1,created_at:'2026-09-22T21:00:00.000Z',updated_at:'2026-09-22T21:00:00.000Z',disabled_at:null,
      }],201);
    }
    if(url.pathname==='/rest/v1/rpc/vault_accessible_vaults' && request.method()==='POST'){
      return json(route,adopted?[{
        id:vaultId,account_id:ACCOUNT,auth_user_id:USER,
        owner_account_id:ACCOUNT,owner_auth_user_id:USER,access_role:'owner',
        name:vaultName,epoch:EPOCH,protocol_version:1,
        created_at:'2026-09-22T21:00:00.000Z',updated_at:'2026-09-22T21:00:00.000Z',disabled_at:null,
      }]:[]);
    }
    if(url.pathname==='/rest/v1/rpc/vault_share_members' && request.method()==='POST'){
      return json(route,adopted?[{
        vault_id:vaultId,account_id:ACCOUNT,auth_user_id:USER,role:'owner',
        created_at:'2026-09-22T21:00:00.000Z',updated_at:'2026-09-22T21:00:00.000Z',
      }]:[]);
    }

    throw new Error('Unexpected Phase 19 cloud request: '+request.method()+' '+request.url());
  });
}

async function confirmTextDialog(page:Page,value:string){
  const dialog=page.locator('.form-dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('#vault-dialog-input').fill(value);
  await dialog.locator('button[value="confirm"]').click();
  await expect(dialog).not.toBeVisible();
}

test('Phase 19 shows private collaborator presence/cursors and hides stale offsets after local divergence',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='chromium-desktop');
  await installRealtimeFake(page);
  await mockCloud(page);

  await page.goto('/');
  await page.locator('.empty-state [data-command="vault.create"]').click();
  await confirmTextDialog(page,'Collaboration Test');

  await page.locator('[data-command="file.create"]').click();
  await confirmTextDialog(page,'Shared Note');
  const editor=page.locator('.cm-content');
  await editor.click();
  await page.keyboard.type(NOTE_TEXT);
  await expect(page.locator('.save-status')).toContainText('Saved locally');

  const cloud=page.locator('.cloud-dialog');
  await page.locator('[data-action="cloud-open"]').click();
  await cloud.locator('.cloud-email').fill('presence@example.test');
  await cloud.locator('.cloud-password').fill('x'.repeat(16));
  await cloud.locator('[data-cloud-action="sign-in"]').click();
  await expect(cloud.locator('.cloud-signed-in')).toBeVisible();
  await cloud.locator('[data-cloud-action="adopt"]').click();
  await expect(cloud.locator('.cloud-vault-state')).toContainText('Cloud adopted');

  await expect(page.locator('.collaboration-status')).toContainText('Presence connected');
  await expect(page.locator('.collaboration-presence')).toContainText('Editor · 6666');
  await expect(page.locator('.cm-remote-cursor')).toHaveCount(1);
  await expect(page.locator('.cm-remote-cursor-label')).toHaveText('Editor 6666');
  await expect(page.locator('.cm-remote-selection')).toHaveCount(1);

  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await expect(page.locator('.cm-remote-cursor')).toHaveCount(0);
  await expect(page.locator('.cm-remote-selection')).toHaveCount(0);
});
