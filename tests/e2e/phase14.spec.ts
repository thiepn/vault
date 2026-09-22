import { expect, test, type Page, type Route } from '@playwright/test';

const PROJECT='https://bskfihouwdogrunnglbg.supabase.co';
const userId='11111111-1111-4111-8111-111111111111';
const accountId='22222222-2222-4222-8222-222222222222';
const epoch='33333333-3333-4333-8333-333333333333';
const ACCESS=['test','access','token'].join('-');
const REFRESH=['test','refresh','token'].join('-');

async function confirmTextDialog(page: Page, value: string): Promise<void> {
  const dialog=page.locator('.form-dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('#vault-dialog-input').fill(value);
  await dialog.locator('button[value="confirm"]').click();
  await expect(dialog).not.toBeVisible();
}

async function createVault(page: Page, name='Cloud Test'): Promise<void> {
  await page.goto('/');
  await page.locator('.empty-state [data-command="vault.create"]').click();
  await confirmTextDialog(page,name);
  await expect(page.locator('#vault-vault option:checked')).toHaveText(name);
}

const corsHeaders={
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Headers':'authorization,apikey,content-type,prefer',
  'Access-Control-Allow-Methods':'GET,POST,PATCH,OPTIONS',
};

function json(route: Route, body: unknown, status=200) {
  return route.fulfill({status,contentType:'application/json',headers:corsHeaders,body:JSON.stringify(body)});
}

async function mockCloud(page: Page) {
  let adopted=false;
  let remoteVaultId='';
  let remoteVaultName='';
  let deviceId='';
  const calls:string[]=[];

  await page.route(PROJECT+'/**',async route=>{
    const request=route.request();
    const url=new URL(request.url());
    calls.push(request.method()+' '+url.pathname+url.search);
    if(request.method()==='OPTIONS') return route.fulfill({status:204,headers:corsHeaders,body:''});

    if(url.pathname==='/auth/v1/token' && url.searchParams.get('grant_type')==='password'){
      return json(route,{access_token:ACCESS,refresh_token:REFRESH,expires_in:3600});
    }
    if(url.pathname==='/auth/v1/user'){
      expect(request.headers()['authorization']).toBe('Bearer '+ACCESS);
      return json(route,{id:userId,email:'cloud@example.test'});
    }
    if(url.pathname==='/auth/v1/logout') return route.fulfill({status:204,headers:corsHeaders,body:''});

    if(url.pathname==='/rest/v1/vault_accounts' && request.method()==='POST'){
      return json(route,[{id:accountId,auth_user_id:userId,created_at:'2026-09-22T12:00:00.000Z'}],201);
    }

    if(url.pathname==='/rest/v1/vault_cloud_devices' && request.method()==='POST'){
      const body=JSON.parse(request.postData() ?? '{}');
      deviceId=body.id;
      return json(route,[{
        id:body.id,account_id:accountId,auth_user_id:userId,label:body.label,platform:'web',
        created_at:'2026-09-22T12:00:00.000Z',last_seen_at:'2026-09-22T12:00:00.000Z',revoked_at:null,
      }],201);
    }
    if(url.pathname==='/rest/v1/vault_cloud_devices' && request.method()==='GET'){
      return json(route,deviceId?[{
        id:deviceId,account_id:accountId,auth_user_id:userId,label:'Linux browser',platform:'web',
        created_at:'2026-09-22T12:00:00.000Z',last_seen_at:'2026-09-22T12:00:00.000Z',revoked_at:null,
      }]:[]);
    }

    if(url.pathname==='/rest/v1/rpc/vault_accessible_vaults' && request.method()==='POST'){
      return json(route,adopted?[{
        id:remoteVaultId,account_id:accountId,auth_user_id:userId,
        owner_account_id:accountId,owner_auth_user_id:userId,access_role:'owner',
        name:remoteVaultName,epoch,protocol_version:1,
        created_at:'2026-09-22T12:00:00.000Z',updated_at:'2026-09-22T12:00:00.000Z',disabled_at:null,
      }]:[]);
    }

    if(url.pathname==='/rest/v1/vault_cloud_vaults' && request.method()==='POST'){
      const body=JSON.parse(request.postData() ?? '{}');
      remoteVaultId=body.id;
      remoteVaultName=body.name;
      adopted=true;
      return json(route,[{
        id:remoteVaultId,account_id:accountId,auth_user_id:userId,name:remoteVaultName,epoch,
        protocol_version:1,created_at:'2026-09-22T12:00:00.000Z',updated_at:'2026-09-22T12:00:00.000Z',disabled_at:null,
      }],201);
    }
    if(url.pathname==='/rest/v1/vault_cloud_vaults' && request.method()==='GET'){
      return json(route,adopted?[{
        id:remoteVaultId,account_id:accountId,auth_user_id:userId,name:remoteVaultName,epoch,
        protocol_version:1,created_at:'2026-09-22T12:00:00.000Z',updated_at:'2026-09-22T12:00:00.000Z',disabled_at:null,
      }]:[]);
    }
    throw new Error('Unexpected cloud request: '+request.method()+' '+request.url());
  });

  return {
    calls,
    get adopted(){return adopted;},
    get remoteVaultId(){return remoteVaultId;},
  };
}

async function signIn(page: Page) {
  const dialog=page.locator('.cloud-dialog');
  await page.locator('[data-action="cloud-open"]').click();
  await expect(dialog).toBeVisible();
  await dialog.locator('.cloud-email').fill('cloud@example.test');
  await dialog.locator('.cloud-password').fill('x'.repeat(16));
  await dialog.locator('[data-cloud-action="sign-in"]').click();
  await expect.poll(async()=>{
    if(await dialog.locator('.cloud-signed-in').isVisible()) return 'signed';
    const cloudMessage=(await dialog.locator('.cloud-message').textContent())?.trim();
    const globalError=(await page.locator('.error').textContent())?.trim();
    return [cloudMessage,globalError].filter(Boolean).join(' | ') || 'pending';
  }).toBe('signed');
  await expect(dialog.locator('.cloud-identity')).toContainText('cloud@example.test');
  return dialog;
}

test('Phase 14 sign-in stays local until explicit adoption and sign-out preserves local data',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='chromium-desktop');
  const remote=await mockCloud(page);
  await createVault(page,'Private Vault');

  const localVaultId=await page.locator('#vault-vault').inputValue();
  const deviceBefore=await page.evaluate(()=>localStorage.getItem('vault:device-id'));
  expect(deviceBefore).toMatch(/^[0-9a-f-]{36}$/);

  const dialog=await signIn(page);
  await expect(dialog.locator('.cloud-vault-state')).toContainText('Local only');
  await expect(dialog.locator('.cloud-vault-state')).toContainText('nothing has been uploaded');
  expect(remote.adopted).toBe(false);
  expect(remote.calls.some(call=>call.includes('POST /rest/v1/vault_cloud_vaults'))).toBe(false);

  await dialog.locator('[data-cloud-action="adopt"]').click();
  await expect(dialog.locator('.cloud-vault-state')).toContainText('Cloud adopted');
  await expect(dialog.locator('[data-cloud-action="adopt"]')).toBeDisabled();
  expect(remote.adopted).toBe(true);
  expect(remote.remoteVaultId).toBe(localVaultId);
  await expect(page.locator('[data-action="cloud-open"]')).toHaveText('Cloud ✓');
  await expect(page.locator('.storage-scope-label')).toContainText('cloud adopted');

  await dialog.locator('[data-cloud-action="sign-out"]').click();
  await expect(dialog.locator('.cloud-signed-out')).toBeVisible();
  await expect(dialog.locator('.cloud-message')).toContainText('Local Vault data was kept');
  await dialog.locator('button[value="close"]').click();

  await expect(page.locator('#vault-vault option:checked')).toHaveText('Private Vault');
  await expect(page.locator('[data-action="cloud-open"]')).toHaveText('Cloud ✓');

  await page.reload();
  await expect(page.locator('#vault-vault option:checked')).toHaveText('Private Vault');
  await expect(page.locator('[data-action="cloud-open"]')).toHaveText('Cloud ✓');
  expect(await page.evaluate(()=>localStorage.getItem('vault:device-id'))).toBe(deviceBefore);

  await page.locator('[data-action="cloud-open"]').click();
  await expect(page.locator('.cloud-dialog .cloud-signed-out')).toBeVisible();
});

test('Phase 14 Cloud panel and explicit adoption remain usable on mobile',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='chromium-mobile');
  await mockCloud(page);
  await createVault(page,'Mobile Local');

  const dialog=await signIn(page);
  await expect(dialog.locator('.cloud-vault-state')).toContainText('Local only');
  await dialog.locator('[data-cloud-action="adopt"]').tap();
  await expect(dialog.locator('.cloud-vault-state')).toContainText('Cloud adopted');
  await expect(dialog.locator('.cloud-devices')).toContainText('Current device');
  await dialog.locator('[data-cloud-action="sign-out"]').tap();
  await expect(dialog.locator('.cloud-signed-out')).toBeVisible();
  await expect(page.locator('#vault-vault option:checked')).toHaveText('Mobile Local');
});
