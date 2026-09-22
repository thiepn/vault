import { expect, test, type Page, type Route } from '@playwright/test';

const PROJECT='https://bskfihouwdogrunnglbg.supabase.co';
const USER='11111111-1111-4111-8111-111111111111';
const ACCOUNT='22222222-2222-4222-8222-222222222222';
const EPOCH='33333333-3333-4333-8333-333333333333';
const ACCESS='phase20-access-token';
const REFRESH='phase20-refresh-token';

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
      if(url.pathname==='/auth/v1/user') return json(route,{id:USER,email:'crdt@example.test'});
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
        this.vaultId=body.id; this.vaultName=body.name; this.adopted=true;
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
          vault_id:this.vaultId,account_id:ACCOUNT,auth_user_id:USER,role:'owner',created_at:now(),updated_at:now(),
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

      throw new Error('Unexpected Phase 20 cloud request: '+request.method()+' '+request.url());
    });
  }
}

async function installRealtimeFake(page:Page){
  await page.addInitScript(()=>{
    (globalThis as any).__phase20RealtimeFrames=[];

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
        (globalThis as any).__phase20RealtimeFrames.push(frame);
        const [joinRef,ref,topic,event]=frame;
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
    (globalThis as any).WebSocket=FakeWebSocket;
  });
}

async function confirmTextDialog(page:Page,value:string){
  const dialog=page.locator('.form-dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('#vault-dialog-input').fill(value);
  await dialog.locator('button[value="confirm"]').click();
  await expect(dialog).not.toBeVisible();
}

test('Phase 20 enters a private Yjs room, uses shared undo and persists through canonical sync',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='chromium-desktop');
  const cloud=new MockCloud();
  await installRealtimeFake(page);
  await cloud.attach(page);

  await page.goto('/');
  await page.locator('.empty-state [data-command="vault.create"]').click();
  await confirmTextDialog(page,'CRDT Test');
  await page.locator('[data-command="file.create"]').click();
  await confirmTextDialog(page,'Shared Note');

  const editor=page.locator('.cm-content');
  await editor.click();
  await page.keyboard.type('canonical seed');
  await expect(page.locator('.save-status')).toContainText('Saved locally');

  const dialog=page.locator('.cloud-dialog');
  await page.locator('[data-action="cloud-open"]').click();
  await dialog.locator('.cloud-email').fill('crdt@example.test');
  await dialog.locator('.cloud-password').fill('x'.repeat(16));
  await dialog.locator('[data-cloud-action="sign-in"]').click();
  await expect(dialog.locator('.cloud-signed-in')).toBeVisible();
  await dialog.locator('[data-cloud-action="adopt"]').click();
  await expect(dialog.locator('.cloud-vault-state')).toContainText('Cloud adopted');
  await dialog.locator('[data-cloud-action="sync"]').click();
  await expect(dialog.locator('.cloud-sync-detail')).toContainText('0 queued');

  await expect(page.locator('.collaboration-status')).toContainText('Live edit connected');
  await expect(page.locator('.collaboration-status')).toContainText('canonical writer');
  const joinedEditRoom=await page.evaluate(()=>((globalThis as any).__phase20RealtimeFrames as any[])
    .some(frame=>frame?.[3]==='phx_join' && String(frame?.[2]??'').startsWith('realtime:vault-edit:')));
  expect(joinedEditRoom).toBe(true);

  await dialog.locator('button[value="close"]').click();
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' collaborative');
  await expect(editor).toContainText('canonical seed collaborative');
  await expect.poll(()=>page.evaluate(()=>((globalThis as any).__phase20RealtimeFrames as any[])
    .filter(frame=>frame?.[3]==='broadcast' && frame?.[4]?.event==='crdt-update').length)).toBeGreaterThan(0);

  await page.keyboard.press('Control+z');
  await expect(editor).toContainText('canonical seed');
  await expect(editor).not.toContainText('collaborative');
  await page.keyboard.type(' merged');

  await page.locator('[data-action="cloud-open"]').click();
  await dialog.locator('[data-cloud-action="sync"]').click();
  await expect(dialog.locator('.cloud-sync-detail')).toContainText('0 queued');
  const note=[...cloud.entries.values()].find(row=>row.kind==='markdown');
  expect(note?.text).toContain('canonical seed merged');
});
