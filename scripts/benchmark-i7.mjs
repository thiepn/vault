import { performance } from 'node:perf_hooks';
import { VaultCryptoContext } from '../build/core/crypto/context.js';
import { sha256 } from '../build/core/crypto/primitives.js';

const vaultId='22222222-2222-4222-8222-222222222222';
const iterations=128;
const bytesPerBlob=256*1024;
const totalBytes=iterations*bytesPerBlob;
const source=Uint8Array.from({length:bytesPerBlob},(_,index)=>(index*31+17)&255);
const context=VaultCryptoContext.generate(vaultId,1);

try{
  const digest=await sha256(source);
  const blobId=await context.blobId(digest);
  const started=performance.now();
  let ciphertextBytes=0;
  for(let index=0;index<iterations;index++){
    const envelope=await context.encryptBlob(blobId,source);
    ciphertextBytes+=envelope.byteLength;
    const opened=await context.decryptBlob(blobId,envelope);
    if(opened.byteLength!==source.byteLength
      ||opened[0]!==source[0]
      ||opened[opened.length-1]!==source[source.length-1]){
      throw new Error('I7 blob benchmark round-trip mismatch');
    }
  }
  const elapsed=performance.now()-started;
  const mib=totalBytes/(1024*1024);
  const throughput=mib/(elapsed/1000);
  console.log(JSON.stringify({
    iterations,
    plaintextMiB:Number(mib.toFixed(1)),
    ciphertextMiB:Number((ciphertextBytes/(1024*1024)).toFixed(1)),
    elapsedMs:Number(elapsed.toFixed(1)),
    throughputMiBPerSecond:Number(throughput.toFixed(1)),
  },null,2));
  if(elapsed>15_000) throw new Error(`I7 blob crypto benchmark regression: ${elapsed.toFixed(1)}ms`);
}finally{
  context.destroy();
}
