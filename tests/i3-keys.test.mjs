import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createDeviceVaultKeyEnvelope,
  deviceVmkConfirmation,
  generateDeviceKeyMaterial,
  importDevicePublicKey,
  openDeviceVaultKeyEnvelope,
  shortDeviceFingerprint,
} from '../build/core/crypto/device-keys.js';
import {
  createRecoveryVaultKeyEnvelope,
  decodeRecoverySecret,
  encodeRecoverySecret,
  generateRecoverySecret,
  openRecoveryVaultKeyEnvelope,
  recoverySecretProof,
} from '../build/core/crypto/recovery.js';
import {
  MemoryDeviceKeyStore,
  deviceEnvelopeRecordId,
  deviceKeyRecordId,
} from '../build/core/crypto/keyring.js';
import { KeyDistributionService } from '../build/core/crypto/key-distribution.js';
import { base64UrlEncode } from '../build/core/crypto/encoding.js';
import { randomBytes } from '../build/core/crypto/primitives.js';

const accountId='11111111-1111-4111-8111-111111111111';
const vaultId='22222222-2222-4222-8222-222222222222';
const deviceA='33333333-3333-4333-8333-333333333333';
const deviceB='44444444-4444-4444-8444-444444444444';
const deviceC='55555555-5555-4555-8555-555555555555';
const vmk=Uint8Array.from({length:32},(_,index)=>index+1);

class FakeKeyRegistry {
  constructor(){
    this.deviceKeys=new Map();
    this.deviceEnvelopeRows=new Map();
    this.recoveryEnvelopesById=new Map();
    this.recoveryProofs=new Map();
    this.access=new Set();
    this.requests=new Map();
    this.activeGenerations=new Map();
  }

  deviceKeyId(account,device){return account+'/'+device;}
  envelopeId(vault,account,device,generation){return [vault,account,device,generation].join('/');}
  recoveryId(vault,account,generation){return [vault,account,generation].join('/');}
  accessId(vault,account,device){return [vault,account,device].join('/');}
  stateId(vault,account){return vault+'/'+account;}

  async registerDeviceKey(account,device,descriptor){
    const id=this.deviceKeyId(account,device);
    const existing=this.deviceKeys.get(id);
    if(existing && JSON.stringify(existing)!==JSON.stringify(descriptor)) throw new Error('Device public key is immutable');
    this.deviceKeys.set(id,structuredClone(descriptor));
  }

  readinessFor(vault,device){
    const active=this.activeGenerations.get(this.stateId(vault,accountId)) ?? null;
    const envelope=active===null?null:this.deviceEnvelopeRows.get(this.envelopeId(vault,accountId,device,active)) ?? null;
    const recovery=active===null?false:this.recoveryEnvelopesById.has(this.recoveryId(vault,accountId,active));
    const authorized=this.access.has(this.accessId(vault,accountId,device));
    return {
      vaultId:vault,
      deviceId:device,
      keyGeneration:active,
      deviceEnvelope:!!envelope,
      recoveryEnvelope:recovery,
      deviceAuthorized:authorized,
      ready:!!envelope&&recovery&&authorized,
    };
  }

  async initializeVaultKeys(input){
    const deviceKey=this.deviceKeys.get(this.deviceKeyId(input.accountId,input.deviceId));
    if(!deviceKey || deviceKey.fingerprint!==input.deviceEnvelope.publicKeyFingerprint) throw new Error('Device key mismatch');
    const stateId=this.stateId(input.vaultId,input.accountId);
    const existingGeneration=this.activeGenerations.get(stateId);
    if(existingGeneration!==undefined && existingGeneration!==input.deviceEnvelope.keyGeneration) throw new Error('Vault key state already initialized');
    this.deviceEnvelopeRows.set(
      this.envelopeId(input.vaultId,input.accountId,input.deviceId,input.deviceEnvelope.keyGeneration),
      structuredClone(input.deviceEnvelope),
    );
    this.recoveryEnvelopesById.set(
      this.recoveryId(input.vaultId,input.accountId,input.recoveryEnvelope.keyGeneration),
      structuredClone(input.recoveryEnvelope),
    );
    this.recoveryProofs.set(
      this.recoveryId(input.vaultId,input.accountId,input.recoveryEnvelope.keyGeneration),
      input.recoveryProof,
    );
    this.access.add(this.accessId(input.vaultId,input.accountId,input.deviceId));
    this.activeGenerations.set(stateId,input.deviceEnvelope.keyGeneration);
    return this.readinessFor(input.vaultId,input.deviceId);
  }

  async readiness(vault,device){return this.readinessFor(vault,device);}

  async deviceEnvelopes(vault,device){
    return [...this.deviceEnvelopeRows.values()]
      .filter(row=>row.vaultId===vault&&row.deviceId===device)
      .sort((a,b)=>a.keyGeneration-b.keyGeneration)
      .map(row=>structuredClone(row));
  }

  async recoveryEnvelopes(vault){
    return [...this.recoveryEnvelopesById.values()]
      .filter(row=>row.vaultId===vault&&row.accountId===accountId)
      .sort((a,b)=>a.keyGeneration-b.keyGeneration)
      .map(row=>structuredClone(row));
  }

  async authorizedDevices(vault,actorDevice){
    if(!this.access.has(this.accessId(vault,accountId,actorDevice))) throw new Error('actor unauthorized');
    const result=[];
    for(const accessKey of this.access){
      const [v,a,d]=accessKey.split('/');
      if(v!==vault||a!==accountId) continue;
      const key=this.deviceKeys.get(this.deviceKeyId(accountId,d));
      if(key) result.push({accountId,deviceId:d,...structuredClone(key)});
    }
    return result.sort((a,b)=>a.deviceId.localeCompare(b.deviceId));
  }

  async requestAccess(vault,device,fingerprint){
    const key=this.deviceKeys.get(this.deviceKeyId(accountId,device));
    if(!key||key.fingerprint!==fingerprint) throw new Error('Device key mismatch');
    const requestId=crypto.randomUUID();
    const challenge=base64UrlEncode(randomBytes(32));
    const request={
      requestId,
      vaultId:vault,
      accountId,
      deviceId:device,
      algorithm:key.algorithm,
      publicSpki:key.publicSpki,
      publicKeyFingerprint:key.fingerprint,
      challenge,
      status:'pending',
      createdAt:new Date().toISOString(),
      expiresAt:new Date(Date.now()+30*60_000).toISOString(),
    };
    this.requests.set(requestId,{request,expectedConfirmation:null,envelopes:[],activeGeneration:null});
    return structuredClone(request);
  }

  async listAccessRequests(vault){
    return [...this.requests.values()]
      .map(row=>row.request)
      .filter(row=>row.vaultId===vault&&row.status!=='confirmed')
      .map(row=>structuredClone(row));
  }

  async approveAccessRequest(input){
    const row=this.requests.get(input.requestId);
    if(!row) throw new Error('request missing');
    if(!input.envelopes.length||!input.envelopes.some(envelope=>envelope.keyGeneration===input.activeGeneration)) throw new Error('active generation missing');
    row.expectedConfirmation=input.expectedConfirmation;
    row.envelopes=structuredClone(input.envelopes);
    row.activeGeneration=input.activeGeneration;
    row.request.status='approved';
    for(const envelope of input.envelopes){
      this.deviceEnvelopeRows.set(
        this.envelopeId(envelope.vaultId,envelope.accountId,envelope.deviceId,envelope.keyGeneration),
        structuredClone(envelope),
      );
    }
  }

  async pendingAccess(requestId,device){
    const row=this.requests.get(requestId);
    if(!row||row.request.deviceId!==device||!row.envelopes.length||row.activeGeneration===null) throw new Error('pending access missing');
    return {
      requestId,
      challenge:row.request.challenge,
      activeGeneration:row.activeGeneration,
      envelopes:structuredClone(row.envelopes),
    };
  }

  async confirmAccess(requestId,device,confirmation){
    const row=this.requests.get(requestId);
    if(!row||row.request.deviceId!==device||row.expectedConfirmation!==confirmation) throw new Error('Device key possession confirmation failed');
    row.request.status='confirmed';
    this.access.add(this.accessId(row.request.vaultId,row.request.accountId,device));
    return this.readinessFor(row.request.vaultId,device);
  }

  async recoverDevice(input){
    const knownGenerations=(await this.recoveryEnvelopes(input.vaultId)).map(row=>row.keyGeneration);
    const inputGenerations=input.envelopes.map(row=>row.keyGeneration).sort((a,b)=>a-b);
    assert.deepEqual(inputGenerations,knownGenerations);
    assert.equal(input.activeGeneration,this.activeGenerations.get(this.stateId(input.vaultId,accountId)));
    for(const proof of input.recoveryProofs){
      const expected=this.recoveryProofs.get(this.recoveryId(input.vaultId,accountId,proof.keyGeneration));
      if(expected!==proof.recoveryProof) throw new Error('Recovery Secret possession proof failed');
    }
    const key=this.deviceKeys.get(this.deviceKeyId(accountId,input.deviceId));
    if(!key) throw new Error('Device key mismatch');
    for(const envelope of input.envelopes){
      if(key.fingerprint!==envelope.publicKeyFingerprint) throw new Error('Device key mismatch');
      this.deviceEnvelopeRows.set(
        this.envelopeId(input.vaultId,accountId,input.deviceId,envelope.keyGeneration),
        structuredClone(envelope),
      );
    }
    this.access.add(this.accessId(input.vaultId,accountId,input.deviceId));
    return this.readinessFor(input.vaultId,input.deviceId);
  }

  async rotateVaultKey(input){
    if(!this.access.has(this.accessId(input.vaultId,accountId,input.actorDeviceId))) throw new Error('actor unauthorized');
    const stateId=this.stateId(input.vaultId,accountId);
    assert.equal(this.activeGenerations.get(stateId),input.fromGeneration);
    assert.equal(input.toGeneration,input.fromGeneration+1);
    const expectedDevices=(await this.authorizedDevices(input.vaultId,input.actorDeviceId)).map(row=>row.deviceId).sort();
    const actualDevices=input.deviceEnvelopes.map(row=>row.deviceId).sort();
    assert.deepEqual(actualDevices,expectedDevices);
    for(const envelope of input.deviceEnvelopes){
      this.deviceEnvelopeRows.set(
        this.envelopeId(input.vaultId,accountId,envelope.deviceId,envelope.keyGeneration),
        structuredClone(envelope),
      );
    }
    this.recoveryEnvelopesById.set(
      this.recoveryId(input.vaultId,accountId,input.recovery.envelope.keyGeneration),
      structuredClone(input.recovery.envelope),
    );
    this.recoveryProofs.set(
      this.recoveryId(input.vaultId,accountId,input.recovery.envelope.keyGeneration),
      input.recovery.recoveryProof,
    );
    this.activeGenerations.set(stateId,input.toGeneration);
    return this.readinessFor(input.vaultId,input.actorDeviceId);
  }

  async rotateRecovery(input){
    if(!this.access.has(this.accessId(input.vaultId,accountId,input.actorDeviceId))) throw new Error('actor unauthorized');
    const expected=(await this.recoveryEnvelopes(input.vaultId)).map(row=>row.keyGeneration);
    const actual=input.replacements.map(row=>row.envelope.keyGeneration).sort((a,b)=>a-b);
    assert.deepEqual(actual,expected);
    for(const replacement of input.replacements){
      const id=this.recoveryId(input.vaultId,accountId,replacement.envelope.keyGeneration);
      this.recoveryEnvelopesById.set(id,structuredClone(replacement.envelope));
      this.recoveryProofs.set(id,replacement.recoveryProof);
    }
  }
}

test('I3 Device RSA-OAEP key is non-extractable privately and fingerprinted from immutable SPKI', async()=>{
  const material=await generateDeviceKeyMaterial();
  assert.equal(material.privateKey.extractable,false);
  assert.equal(material.privateKey.type,'private');
  assert.equal(material.publicKey.type,'public');
  assert.match(material.publicSpki,/^[A-Za-z0-9_-]+$/u);
  assert.match(material.fingerprint,/^[A-Za-z0-9_-]{43}$/u);
  assert.match(shortDeviceFingerprint(material.fingerprint),/^[A-Za-z0-9_-]{4}-[A-Za-z0-9_-]{4}-[A-Za-z0-9_-]{4}$/u);

  const imported=await importDevicePublicKey(material);
  const exported=base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey('spki',imported)));
  assert.equal(exported,material.publicSpki);
});

test('I3 Device Vault-key envelope round-trips and OAEP label binds Account/Vault/Device/generation/fingerprint', async()=>{
  const material=await generateDeviceKeyMaterial();
  const envelope=await createDeviceVaultKeyEnvelope({
    accountId,vaultId,deviceId:deviceA,keyGeneration:1,
    publicKey:material.publicKey,publicKeyFingerprint:material.fingerprint,
    vmk,createdAt:'2026-09-23T00:00:00.000Z',
  });
  assert.equal(envelope.ciphertext.length,512);
  assert.deepEqual([...await openDeviceVaultKeyEnvelope({envelope,privateKey:material.privateKey})],[...vmk]);

  await assert.rejects(
    ()=>openDeviceVaultKeyEnvelope({envelope:{...envelope,deviceId:deviceB},privateKey:material.privateKey}),
    /could not be authenticated\/decrypted/,
  );
  await assert.rejects(
    ()=>openDeviceVaultKeyEnvelope({envelope:{...envelope,keyGeneration:2},privateKey:material.privateKey}),
    /could not be authenticated\/decrypted/,
  );
});

test('I3 Recovery Secret uses a versioned checksummed human code', async()=>{
  const fixed=Uint8Array.from({length:32},(_,index)=>index);
  const code=await encodeRecoverySecret(fixed);
  assert.match(code,/^VLT1-[A-Z2-7-]+$/u);
  assert.deepEqual([...await decodeRecoverySecret(code)],[...fixed]);
  assert.deepEqual([...await decodeRecoverySecret(code.toLowerCase().replaceAll('-',' '))],[...fixed]);

  const changed=code.slice(0,-1)+(code.endsWith('A')?'B':'A');
  await assert.rejects(()=>decodeRecoverySecret(changed),/(checksum|trailing bits)/);
  assert.equal(generateRecoverySecret().byteLength,32);
});

test('I3 Recovery envelope is Vault/Account/generation-bound and wrong secret fails authentication', async()=>{
  const secret=generateRecoverySecret();
  const envelope=await createRecoveryVaultKeyEnvelope({
    secret,accountId,vaultId,keyGeneration:1,vmk,createdAt:'2026-09-23T00:00:00.000Z',
  });
  assert.equal(envelope.nonce.length,16);
  assert.equal(envelope.ciphertext.length,64);
  assert.deepEqual([...await openRecoveryVaultKeyEnvelope({secret,envelope})],[...vmk]);
  await assert.rejects(
    ()=>openRecoveryVaultKeyEnvelope({secret:generateRecoverySecret(),envelope}),
    /failed authentication/,
  );
  await assert.rejects(
    ()=>openRecoveryVaultKeyEnvelope({secret,envelope:{...envelope,vaultId:'66666666-6666-4666-8666-666666666666'}}),
    /failed authentication/,
  );
});

test('I3 Recovery proof is deterministic but scoped to Vault and key generation', async()=>{
  const secret=Uint8Array.from({length:32},(_,index)=>255-index);
  const first=await recoverySecretProof({secret,accountId,vaultId,keyGeneration:1});
  const again=await recoverySecretProof({secret,accountId,vaultId,keyGeneration:1});
  const generation2=await recoverySecretProof({secret,accountId,vaultId,keyGeneration:2});
  const otherVault=await recoverySecretProof({
    secret,accountId,vaultId:'66666666-6666-4666-8666-666666666666',keyGeneration:1,
  });
  assert.equal(first,again);
  assert.match(first,/^[A-Za-z0-9_-]{43}$/u);
  assert.notEqual(first,generation2);
  assert.notEqual(first,otherVault);
});

test('I3 local keyring forbids silent Device key and envelope replacement', async()=>{
  const store=new MemoryDeviceKeyStore();
  const first=await generateDeviceKeyMaterial();
  await store.putDeviceKey({
    id:deviceKeyRecordId(accountId,deviceA),accountId,deviceId:deviceA,
    algorithm:first.algorithm,publicSpki:first.publicSpki,fingerprint:first.fingerprint,
    privateKey:first.privateKey,createdAt:new Date().toISOString(),
  });
  const replacement=await generateDeviceKeyMaterial();
  await assert.rejects(()=>store.putDeviceKey({
    id:deviceKeyRecordId(accountId,deviceA),accountId,deviceId:deviceA,
    algorithm:replacement.algorithm,publicSpki:replacement.publicSpki,fingerprint:replacement.fingerprint,
    privateKey:replacement.privateKey,createdAt:new Date().toISOString(),
  }),/replacement is forbidden/);

  const envelope=await createDeviceVaultKeyEnvelope({
    accountId,vaultId,deviceId:deviceA,keyGeneration:1,
    publicKey:first.publicKey,publicKeyFingerprint:first.fingerprint,vmk,
  });
  await store.putEnvelope({...envelope,id:deviceEnvelopeRecordId(accountId,vaultId,deviceA,1)});
  await assert.rejects(()=>store.putEnvelope({
    ...envelope,id:deviceEnvelopeRecordId(accountId,vaultId,deviceA,1),
    ciphertext:'A'.repeat(512),
  }),/reused with different bytes/);
});

test('I3 initialization becomes READY only after Device + Recovery envelopes and Device authorization are durable', async()=>{
  const remote=new FakeKeyRegistry();
  const local=new MemoryDeviceKeyStore();
  const service=new KeyDistributionService(local,remote);
  const recovery=await service.generateRecoverySecret();

  const {context,readiness}=await service.initializeVault({
    accountId,vaultId,deviceId:deviceA,recoverySecret:recovery.secret,
  });
  assert.equal(readiness.deviceEnvelope,true);
  assert.equal(readiness.recoveryEnvelope,true);
  assert.equal(readiness.deviceAuthorized,true);
  assert.equal(readiness.ready,true);
  assert.equal(readiness.keyGeneration,1);
  assert.match(recovery.code,/^VLT1-/u);

  const localUnlocked=await service.unlockLocal({accountId,vaultId,deviceId:deviceA});
  assert.equal(
    await context.nameToken(null,'Inbox.md'),
    await localUnlocked.nameToken(null,'Inbox.md'),
  );
  context.destroy();
  localUnlocked.destroy();
});

test('I3 VMK rotation advances generation and retains old generation for history', async()=>{
  const remote=new FakeKeyRegistry();
  const local=new MemoryDeviceKeyStore();
  const service=new KeyDistributionService(local,remote);
  const recovery=await service.generateRecoverySecret();
  (await service.initializeVault({accountId,vaultId,deviceId:deviceA,recoverySecret:recovery.secret})).context.destroy();

  const rotated=await service.rotateVaultMasterKey({
    accountId,vaultId,actorDeviceId:deviceA,recoverySecret:recovery.secret,
  });
  assert.equal(rotated.readiness.keyGeneration,2);
  assert.equal(rotated.readiness.ready,true);
  rotated.context.destroy();

  const retained=await local.listEnvelopes(accountId,vaultId,deviceA);
  assert.deepEqual(retained.map(row=>row.keyGeneration),[1,2]);
  assert.deepEqual((await remote.recoveryEnvelopes(vaultId)).map(row=>row.keyGeneration),[1,2]);
});

test('I3 trusted Device approval transfers every retained VMK generation before authorization', async()=>{
  const remote=new FakeKeyRegistry();
  const localA=new MemoryDeviceKeyStore();
  const localB=new MemoryDeviceKeyStore();
  const serviceA=new KeyDistributionService(localA,remote);
  const serviceB=new KeyDistributionService(localB,remote);
  const recovery=await serviceA.generateRecoverySecret();
  (await serviceA.initializeVault({accountId,vaultId,deviceId:deviceA,recoverySecret:recovery.secret})).context.destroy();
  (await serviceA.rotateVaultMasterKey({accountId,vaultId,actorDeviceId:deviceA,recoverySecret:recovery.secret})).context.destroy();

  const request=await serviceB.requestAccess({accountId,vaultId,deviceId:deviceB});
  await serviceA.approveAccessRequest({accountId,approverDeviceId:deviceA,request});
  assert.equal(remote.readinessFor(vaultId,deviceB).deviceAuthorized,false);

  const completed=await serviceB.completePendingAccess({
    accountId,requestId:request.requestId,deviceId:deviceB,
  });
  assert.equal(completed.readiness.ready,true);
  assert.equal(completed.readiness.keyGeneration,2);
  completed.context.destroy();

  const stored=await localB.listEnvelopes(accountId,vaultId,deviceB);
  assert.deepEqual(stored.map(row=>row.keyGeneration),[1,2]);
});

test('I3 wrong Device private key cannot complete another Device access request', async()=>{
  const remote=new FakeKeyRegistry();
  const localA=new MemoryDeviceKeyStore();
  const localB=new MemoryDeviceKeyStore();
  const localC=new MemoryDeviceKeyStore();
  const serviceA=new KeyDistributionService(localA,remote);
  const serviceB=new KeyDistributionService(localB,remote);
  const serviceC=new KeyDistributionService(localC,remote);
  const recovery=await serviceA.generateRecoverySecret();
  (await serviceA.initializeVault({accountId,vaultId,deviceId:deviceA,recoverySecret:recovery.secret})).context.destroy();

  const request=await serviceB.requestAccess({accountId,vaultId,deviceId:deviceB});
  await serviceA.approveAccessRequest({accountId,approverDeviceId:deviceA,request});

  await serviceC.ensureDeviceKey(accountId,deviceC);
  const cKey=await localC.getDeviceKey(accountId,deviceC);
  const pending=await remote.pendingAccess(request.requestId,deviceB);
  await assert.rejects(
    ()=>openDeviceVaultKeyEnvelope({envelope:pending.envelopes[0],privateKey:cKey.privateKey}),
    /could not be authenticated\/decrypted/,
  );
  assert.equal(remote.readinessFor(vaultId,deviceB).deviceAuthorized,false);
});

test('I3 Recovery Secret restores all retained generations without an old Device private key', async()=>{
  const remote=new FakeKeyRegistry();
  const localA=new MemoryDeviceKeyStore();
  const localC=new MemoryDeviceKeyStore();
  const serviceA=new KeyDistributionService(localA,remote);
  const serviceC=new KeyDistributionService(localC,remote);
  const recovery=await serviceA.generateRecoverySecret();
  (await serviceA.initializeVault({accountId,vaultId,deviceId:deviceA,recoverySecret:recovery.secret})).context.destroy();
  const active=(await serviceA.rotateVaultMasterKey({accountId,vaultId,actorDeviceId:deviceA,recoverySecret:recovery.secret}));
  const expected=await active.context.nameToken(null,'Recovered.md');
  active.context.destroy();

  const recovered=await serviceC.recoverDevice({
    accountId,vaultId,deviceId:deviceC,recoverySecret:await serviceC.parseRecoveryCode(recovery.code),
  });
  assert.equal(recovered.readiness.ready,true);
  assert.equal(recovered.readiness.keyGeneration,2);
  assert.equal(await recovered.context.nameToken(null,'Recovered.md'),expected);
  recovered.context.destroy();
  assert.deepEqual((await localC.listEnvelopes(accountId,vaultId,deviceC)).map(row=>row.keyGeneration),[1,2]);

  await assert.rejects(
    ()=>new KeyDistributionService(new MemoryDeviceKeyStore(),remote).recoverDevice({
      accountId,vaultId,deviceId:'77777777-7777-4777-8777-777777777777',recoverySecret:generateRecoverySecret(),
    }),
    /failed authentication/,
  );
});

test('I3 Recovery Secret rotation rewraps every retained generation and invalidates the old secret', async()=>{
  const remote=new FakeKeyRegistry();
  const localA=new MemoryDeviceKeyStore();
  const serviceA=new KeyDistributionService(localA,remote);
  const first=await serviceA.generateRecoverySecret();
  (await serviceA.initializeVault({accountId,vaultId,deviceId:deviceA,recoverySecret:first.secret})).context.destroy();
  (await serviceA.rotateVaultMasterKey({accountId,vaultId,actorDeviceId:deviceA,recoverySecret:first.secret})).context.destroy();

  const rotated=await serviceA.rotateRecoverySecret({accountId,vaultId,actorDeviceId:deviceA});
  assert.notEqual(rotated.code,first.code);

  const oldRecovery=new KeyDistributionService(new MemoryDeviceKeyStore(),remote);
  await assert.rejects(
    ()=>oldRecovery.recoverDevice({
      accountId,vaultId,deviceId:deviceB,recoverySecret:first.secret,
    }),
    /failed authentication/,
  );

  const newRecovery=new KeyDistributionService(new MemoryDeviceKeyStore(),remote);
  const restored=await newRecovery.recoverDevice({
    accountId,vaultId,deviceId:deviceC,recoverySecret:rotated.secret,
  });
  assert.equal(restored.readiness.keyGeneration,2);
  restored.context.destroy();
});

test('I3 Device confirmation HMAC is challenge and target scoped', async()=>{
  const challenge=base64UrlEncode(Uint8Array.from({length:32},(_,index)=>index));
  const a=await deviceVmkConfirmation({vmk,accountId,vaultId,deviceId:deviceA,keyGeneration:1,challenge});
  const b=await deviceVmkConfirmation({vmk,accountId,vaultId,deviceId:deviceB,keyGeneration:1,challenge});
  const g2=await deviceVmkConfirmation({vmk,accountId,vaultId,deviceId:deviceA,keyGeneration:2,challenge});
  assert.match(a,/^[A-Za-z0-9_-]{43}$/u);
  assert.notEqual(a,b);
  assert.notEqual(a,g2);
});


test('I3 Supabase migration implements every multi-generation RPC used by the client', () => {
  const sql=readFileSync(new URL('../backend/supabase/i3_device_recovery_keys.sql',import.meta.url),'utf8');
  const required=[
    'vault_key_register_device',
    'vault_key_initialize_vault',
    'vault_key_readiness',
    'vault_key_device_envelopes',
    'vault_key_recovery_envelopes',
    'vault_key_authorized_devices',
    'vault_key_request_access',
    'vault_key_list_access_requests',
    'vault_key_approve_access_request_v2',
    'vault_key_pending_access_v2',
    'vault_key_confirm_access',
    'vault_key_recover_device_v2',
    'vault_key_rotate_vmk',
    'vault_key_rotate_recovery',
  ];
  for(const name of required){
    assert.match(sql,new RegExp(String.raw`create\s+or\s+replace\s+function\s+public\.${name}\s*\(`,'iu'),name+' RPC is missing');
  }
  assert.match(sql,/create table if not exists vault_private\.vault_key_state/iu);
  assert.match(sql,/active_generation integer not null/iu);
  assert.match(sql,/revoke all on vault_private\.device_keys from public,anon,authenticated/iu);
  assert.match(sql,/revoke all on vault_private\.recovery_vault_key_envelopes from public,anon,authenticated/iu);
  assert.match(sql,/grant execute on function public\.vault_key_rotate_vmk\(uuid,uuid,integer,integer,jsonb,jsonb\) to authenticated/iu);
  assert.match(sql,/grant execute on function public\.vault_key_rotate_recovery\(uuid,uuid,jsonb\) to authenticated/iu);
});

test('I3 active key generation is explicit Vault state, not inferred from per-Device max envelope', () => {
  const sql=readFileSync(new URL('../backend/supabase/i3_device_recovery_keys.sql',import.meta.url),'utf8');
  const finalReadiness=sql.lastIndexOf('create or replace function vault_private.readiness_json');
  assert.ok(finalReadiness>=0);
  const body=sql.slice(finalReadiness,sql.indexOf('create or replace function public.vault_key_initialize_vault',finalReadiness));
  assert.match(body,/from vault_private\.vault_key_state/iu);
  assert.doesNotMatch(body,/select max\(e\.key_generation\)/iu);
});


test('I3 SQL keeps the E2EE key lineage owner-only until cross-Account sharing is designed', () => {
  const sql=readFileSync(new URL('../backend/supabase/i3_device_recovery_keys.sql',import.meta.url),'utf8');
  const helperStart=sql.indexOf('create or replace function vault_private.require_active_member');
  const helperEnd=sql.indexOf('create or replace function vault_private.require_active_device',helperStart);
  assert.ok(helperStart>=0 && helperEnd>helperStart);
  const helper=sql.slice(helperStart,helperEnd);
  assert.match(helper,/m\.role='owner'/u);
  assert.match(helper,/v\.account_id=p_account_id/u);
  assert.match(sql,/insert into vault_private\.vault_key_state\(vault_id,account_id,active_generation\)[\s\S]*max\(r\.key_generation\)/u);
});
