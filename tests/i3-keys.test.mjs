import test from 'node:test';
import assert from 'node:assert/strict';
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
    this.deviceEnvelopes=new Map();
    this.recoveryEnvelopes=new Map();
    this.recoveryProofs=new Map();
    this.access=new Set();
    this.requests=new Map();
  }

  deviceKeyId(account,device){return account+'/'+device;}
  envelopeId(vault,account,device,generation){return [vault,account,device,generation].join('/');}
  recoveryId(vault,account,generation){return [vault,account,generation].join('/');}
  accessId(vault,account,device){return [vault,account,device].join('/');}

  async registerDeviceKey(account,device,descriptor){
    const id=this.deviceKeyId(account,device);
    const existing=this.deviceKeys.get(id);
    if(existing && JSON.stringify(existing)!==JSON.stringify(descriptor)) throw new Error('Device public key is immutable');
    this.deviceKeys.set(id,structuredClone(descriptor));
  }

  readinessFor(vault,device){
    const key=[...this.deviceEnvelopes.values()]
      .filter(row=>row.vaultId===vault&&row.deviceId===device)
      .sort((a,b)=>b.keyGeneration-a.keyGeneration)[0] ?? null;
    const recovery=key ? this.recoveryEnvelopes.has(this.recoveryId(vault,key.accountId,key.keyGeneration)) : false;
    const authorized=key ? this.access.has(this.accessId(vault,key.accountId,device)) : false;
    return {
      vaultId:vault,
      deviceId:device,
      keyGeneration:key?.keyGeneration ?? null,
      deviceEnvelope:!!key,
      recoveryEnvelope:recovery,
      deviceAuthorized:authorized,
      ready:!!key&&recovery&&authorized,
    };
  }

  async initializeVaultKeys(input){
    const deviceKey=this.deviceKeys.get(this.deviceKeyId(input.accountId,input.deviceId));
    if(!deviceKey || deviceKey.fingerprint!==input.deviceEnvelope.publicKeyFingerprint) throw new Error('Device key mismatch');
    this.deviceEnvelopes.set(
      this.envelopeId(input.vaultId,input.accountId,input.deviceId,input.deviceEnvelope.keyGeneration),
      structuredClone(input.deviceEnvelope),
    );
    this.recoveryEnvelopes.set(
      this.recoveryId(input.vaultId,input.accountId,input.recoveryEnvelope.keyGeneration),
      structuredClone(input.recoveryEnvelope),
    );
    this.recoveryProofs.set(
      this.recoveryId(input.vaultId,input.accountId,input.recoveryEnvelope.keyGeneration),
      input.recoveryProof,
    );
    this.access.add(this.accessId(input.vaultId,input.accountId,input.deviceId));
    return this.readinessFor(input.vaultId,input.deviceId);
  }

  async readiness(vault,device){return this.readinessFor(vault,device);}

  async deviceEnvelopes(vault,device){
    return [...this.deviceEnvelopes.values()]
      .filter(row=>row.vaultId===vault&&row.deviceId===device)
      .map(row=>structuredClone(row));
  }

  async recoveryEnvelope(vault,generation){
    for(const row of this.recoveryEnvelopes.values()){
      if(row.vaultId===vault&&row.keyGeneration===generation) return structuredClone(row);
    }
    return null;
  }

  async requestAccess(vault,device,fingerprint){
    const key=[...this.deviceKeys.entries()].find(([id,row])=>id.endsWith('/'+device)&&row.fingerprint===fingerprint)?.[1];
    if(!key) throw new Error('Device key mismatch');
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
    this.requests.set(requestId,{request,expectedConfirmation:null,envelope:null});
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
    row.expectedConfirmation=input.expectedConfirmation;
    row.envelope=structuredClone(input.envelope);
    row.request.status='approved';
    this.deviceEnvelopes.set(
      this.envelopeId(row.envelope.vaultId,row.envelope.accountId,row.envelope.deviceId,row.envelope.keyGeneration),
      structuredClone(row.envelope),
    );
  }

  async pendingAccess(requestId,device){
    const row=this.requests.get(requestId);
    if(!row||row.request.deviceId!==device||!row.envelope) throw new Error('pending access missing');
    return {requestId,challenge:row.request.challenge,envelope:structuredClone(row.envelope)};
  }

  async confirmAccess(requestId,device,confirmation){
    const row=this.requests.get(requestId);
    if(!row||row.request.deviceId!==device||row.expectedConfirmation!==confirmation) throw new Error('Device key possession confirmation failed');
    row.request.status='confirmed';
    this.access.add(this.accessId(row.request.vaultId,row.request.accountId,device));
    return this.readinessFor(row.request.vaultId,device);
  }

  async recoverDevice(input){
    const proof=this.recoveryProofs.get(this.recoveryId(input.vaultId,accountId,input.envelope.keyGeneration));
    if(proof!==input.recoveryProof) throw new Error('Recovery Secret possession proof failed');
    const key=this.deviceKeys.get(this.deviceKeyId(accountId,input.deviceId));
    if(!key||key.fingerprint!==input.envelope.publicKeyFingerprint) throw new Error('Device key mismatch');
    this.deviceEnvelopes.set(
      this.envelopeId(input.vaultId,accountId,input.deviceId,input.envelope.keyGeneration),
      structuredClone(input.envelope),
    );
    this.access.add(this.accessId(input.vaultId,accountId,input.deviceId));
    return this.readinessFor(input.vaultId,input.deviceId);
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
  assert.match(recovery.code,/^VLT1-/u);

  const localUnlocked=await service.unlockLocal({accountId,vaultId,deviceId:deviceA});
  assert.equal(
    await context.nameToken(null,'Inbox.md'),
    await localUnlocked.nameToken(null,'Inbox.md'),
  );
  context.destroy();
  localUnlocked.destroy();
});

test('I3 trusted Device approval requires target private-key possession before authorization', async()=>{
  const remote=new FakeKeyRegistry();
  const localA=new MemoryDeviceKeyStore();
  const localB=new MemoryDeviceKeyStore();
  const serviceA=new KeyDistributionService(localA,remote);
  const serviceB=new KeyDistributionService(localB,remote);
  const recovery=await serviceA.generateRecoverySecret();
  const initialized=await serviceA.initializeVault({accountId,vaultId,deviceId:deviceA,recoverySecret:recovery.secret});
  initialized.context.destroy();

  const request=await serviceB.requestAccess({accountId,vaultId,deviceId:deviceB});
  await serviceA.approveAccessRequest({
    accountId,approverDeviceId:deviceA,request,keyGeneration:1,
  });
  assert.equal(remote.readinessFor(vaultId,deviceB).deviceAuthorized,false);

  const completed=await serviceB.completePendingAccess({
    accountId,requestId:request.requestId,deviceId:deviceB,
  });
  assert.equal(completed.readiness.ready,true);
  assert.equal(completed.readiness.deviceAuthorized,true);
  completed.context.destroy();

  const stored=await localB.getEnvelope(accountId,vaultId,deviceB,1);
  assert.ok(stored);
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
  await serviceA.approveAccessRequest({accountId,approverDeviceId:deviceA,request,keyGeneration:1});

  await serviceC.ensureDeviceKey(accountId,deviceC);
  const cKey=await localC.getDeviceKey(accountId,deviceC);
  const pending=await remote.pendingAccess(request.requestId,deviceB);
  await assert.rejects(
    ()=>openDeviceVaultKeyEnvelope({envelope:pending.envelope,privateKey:cKey.privateKey}),
    /could not be authenticated\/decrypted/,
  );
  assert.equal(remote.readinessFor(vaultId,deviceB).deviceAuthorized,false);
});

test('I3 Recovery Secret can authorize a replacement Device without the old Device private key', async()=>{
  const remote=new FakeKeyRegistry();
  const localA=new MemoryDeviceKeyStore();
  const localC=new MemoryDeviceKeyStore();
  const serviceA=new KeyDistributionService(localA,remote);
  const serviceC=new KeyDistributionService(localC,remote);
  const recovery=await serviceA.generateRecoverySecret();
  const initialized=await serviceA.initializeVault({accountId,vaultId,deviceId:deviceA,recoverySecret:recovery.secret});
  const expected=await initialized.context.nameToken(null,'Recovered.md');
  initialized.context.destroy();

  const recovered=await serviceC.recoverDevice({
    accountId,vaultId,deviceId:deviceC,keyGeneration:1,recoverySecret:await serviceC.parseRecoveryCode(recovery.code),
  });
  assert.equal(recovered.readiness.ready,true);
  assert.equal(await recovered.context.nameToken(null,'Recovered.md'),expected);
  recovered.context.destroy();

  const wrong=generateRecoverySecret();
  await assert.rejects(
    ()=>serviceC.recoverDevice({accountId,vaultId,deviceId:deviceB,keyGeneration:1,recoverySecret:wrong}),
    /failed authentication/,
  );
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
