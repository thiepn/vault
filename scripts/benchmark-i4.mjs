import { performance } from 'node:perf_hooks';
import {
  validateEncryptedRemotePageV2,
  validateEncryptedRemoteSnapshotV2,
} from '../build/core/sync/remote-v2.js';

const vaultId='22222222-2222-4222-8222-222222222222';
const epoch='44444444-4444-4444-8444-444444444444';
const deviceId='33333333-3333-4333-8333-333333333333';
const token='A'.repeat(43);
const pad=n=>n.toString(16).padStart(12,'0');
const uuid=n=>`77777777-7777-4777-8777-${pad(n)}`;
const op=n=>`99999999-9999-4999-8999-${pad(n)}`;

function snapshot(index,sequence=index+1,revision=1){
  return {
    entityId:uuid(index),
    vaultId,
    entityType:'note',
    remoteRevision:String(revision),
    sequence:String(sequence),
    schemaVersion:1,
    structural:{parentId:null,nameToken:token,deleted:false,blobId:null},
    payload:{
      encryptionVersion:1,keyGeneration:1,algorithm:'A256GCM',
      nonce:'AAAAAAAAAAAAAAAA',ciphertext:'AAAAAAAAAAAAAAAAAAAAAA',
    },
    operationId:op(index),
    updatedByDevice:deviceId,
    updatedAt:'2026-09-23T00:00:00.000Z',
  };
}

const entities=10_000;
let started=performance.now();
for(let i=0;i<entities;i++) validateEncryptedRemoteSnapshotV2(snapshot(i),vaultId);
const entityMs=performance.now()-started;

const events=50_000;
const pageSize=500;
started=performance.now();
let after='0';
for(let start=0;start<events;start+=pageSize){
  const pageEvents=[];
  for(let i=start;i<Math.min(events,start+pageSize);i++){
    const sequence=i+1;
    const snap=snapshot(i%entities,sequence,Math.floor(i/entities)+1);
    pageEvents.push({
      sequence:String(sequence),
      operationId:snap.operationId,
      entityId:snap.entityId,
      entityType:snap.entityType,
      remoteRevision:snap.remoteRevision,
      kind:'put',
      snapshot:snap,
    });
  }
  const through=pageEvents.at(-1)?.sequence ?? after;
  validateEncryptedRemotePageV2({
    protocolVersion:2,
    vaultId,
    epoch,
    after,
    through,
    highWatermark:String(events),
    events:pageEvents,
  },{vaultId,epoch,after});
  after=through;
}
const eventMs=performance.now()-started;

console.log(JSON.stringify({
  entitiesValidated:entities,
  entityValidationMs:Number(entityMs.toFixed(1)),
  eventsValidated:events,
  eventValidationMs:Number(eventMs.toFixed(1)),
  pageSize,
},null,2));

if(entityMs>5000) throw new Error(`I4 10k encrypted-state validation regression: ${entityMs.toFixed(1)}ms`);
if(eventMs>10000) throw new Error(`I4 50k event-page validation regression: ${eventMs.toFixed(1)}ms`);
