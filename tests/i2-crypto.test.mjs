import test from 'node:test';
import assert from 'node:assert/strict';
import {
  base64UrlDecode,
  base64UrlEncode,
  bytesToHex,
  canonicalContext,
  hexToBytes,
} from '../build/core/crypto/encoding.js';
import {
  aes256GcmDecrypt,
  aes256GcmEncrypt,
  hkdfSha256,
  hmacSha256,
  sha256,
} from '../build/core/crypto/primitives.js';
import {
  createBlobId,
  createNameToken,
  deriveEntityKey,
  generateVaultMasterKey,
} from '../build/core/crypto/keys.js';
import {
  decryptEntityPayloadV1,
  encryptEntityPayloadV1,
  entityAadV1,
} from '../build/core/crypto/entity.js';
import { VaultCryptoContext } from '../build/core/crypto/context.js';

const vaultId = '11111111-1111-4111-8111-111111111111';
const entityId = '22222222-2222-4222-8222-222222222222';
const parentId = '33333333-3333-4333-8333-333333333333';
const vmk = Uint8Array.from({length:32},(_,index)=>index);

test('I2 base64url is strict, unpadded and round-trips arbitrary bytes', () => {
  const samples = [
    new Uint8Array(),
    Uint8Array.of(0),
    Uint8Array.of(1, 2),
    Uint8Array.of(1, 2, 3),
    Uint8Array.from({length:255},(_,index)=>index),
  ];
  for (const bytes of samples) {
    const encoded = base64UrlEncode(bytes);
    assert.equal(encoded.includes('='), false);
    assert.deepEqual([...base64UrlDecode(encoded)], [...bytes]);
  }
  assert.throws(() => base64UrlDecode('AQ=='), /Invalid unpadded base64url/);
  assert.throws(() => base64UrlDecode('A'), /Invalid unpadded base64url/);
});

test('I2 HKDF-SHA-256 matches RFC 5869 test case 1', async () => {
  const ikm = hexToBytes('0b'.repeat(22));
  const salt = hexToBytes('000102030405060708090a0b0c');
  const info = hexToBytes('f0f1f2f3f4f5f6f7f8f9');
  const okm = await hkdfSha256(ikm, salt, info, 42);
  assert.equal(
    bytesToHex(okm),
    '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
  );
});

test('I2 HMAC-SHA-256 matches RFC 4231 test case 1', async () => {
  const digest = await hmacSha256(
    hexToBytes('0b'.repeat(20)),
    new TextEncoder().encode('Hi There'),
  );
  assert.equal(
    bytesToHex(digest),
    'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
  );
});

test('I2 AES-256-GCM matches the established all-zero NIST vector', async () => {
  const key = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(32),
    {name:'AES-GCM'},
    false,
    ['encrypt','decrypt'],
  );
  const nonce = new Uint8Array(12);
  const ciphertext = await aes256GcmEncrypt(key, nonce, new Uint8Array(16), new Uint8Array());
  assert.equal(
    bytesToHex(ciphertext),
    'cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919',
  );
  assert.deepEqual(
    [...await aes256GcmDecrypt(key, nonce, ciphertext, new Uint8Array())],
    [...new Uint8Array(16)],
  );
});

test('I2 Vault golden vectors freeze NameToken, BlobId, AAD and entity ciphertext', async () => {
  const nameToken = await createNameToken({
    vmk,
    vaultId,
    parentId,
    name:'Research.md',
    keyGeneration:1,
  });
  assert.equal(nameToken, 'qXdJb7isqUSb9QZr6W_25ayBqnU2ZFkepHH3mkrY2gg');

  const plaintextDigest = await sha256(new TextEncoder().encode('vault golden blob'));
  assert.equal(bytesToHex(plaintextDigest), '4da13f4a7319598f8b1ba5c8342c50f94da79b546961282b72b9895480a99cf2');
  const blobId = await createBlobId({vmk,vaultId,plaintextSha256:plaintextDigest,keyGeneration:1});
  assert.equal(blobId, 'pY2grg80b75BZSqYbHjyvrI8UM5uECaTSyyS6vq3d8I');

  const metadata = {
    vaultId,
    entityId,
    entityType:'note',
    schemaVersion:1,
    keyGeneration:1,
    parentId,
    nameToken,
    deleted:false,
    blobId:null,
  };
  assert.equal(
    new TextDecoder().decode(entityAadV1(metadata)),
    '["vault/entity-aad/v1","11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222","note",1,1,"33333333-3333-4333-8333-333333333333","qXdJb7isqUSb9QZr6W_25ayBqnU2ZFkepHH3mkrY2gg",false,""]',
  );

  const entityKey = await deriveEntityKey({vmk,vaultId,entityId,entityType:'note',keyGeneration:1});
  assert.equal(entityKey.extractable, false);
  const nonce = Uint8Array.from({length:12},(_,index)=>index);
  const ciphertext = await aes256GcmEncrypt(
    entityKey,
    nonce,
    new TextEncoder().encode('Exact Markdown\n'),
    entityAadV1(metadata),
  );
  assert.equal(base64UrlEncode(nonce), 'AAECAwQFBgcICQoL');
  assert.equal(base64UrlEncode(ciphertext), 'FttlIa5Z6xacdievyLq5EUCssF77gI_vMWNwjC6Xrg');
});

test('I2 NameToken exactly follows portable NFC plus ASCII-only case folding', async () => {
  const common = {vmk,vaultId,parentId,keyGeneration:1};
  assert.equal(
    await createNameToken({...common,name:'FILE.md'}),
    await createNameToken({...common,name:'file.md'}),
  );
  assert.equal(
    await createNameToken({...common,name:'Café.md'}),
    await createNameToken({...common,name:'Cafe\u0301.md'}),
  );
  assert.equal(
    await createNameToken({...common,name:'I.md'}),
    await createNameToken({...common,name:'i.md'}),
  );
  assert.notEqual(
    await createNameToken({...common,name:'İ.md'}),
    await createNameToken({...common,name:'i.md'}),
  );
  assert.notEqual(
    await createNameToken({...common,parentId:crypto.randomUUID(),name:'file.md'}),
    await createNameToken({...common,name:'file.md'}),
  );
});

test('I2 BlobId is stable inside a Vault generation and unlinkable across Vaults', async () => {
  const digest = await sha256(new TextEncoder().encode('same bytes'));
  const first = await createBlobId({vmk,vaultId,plaintextSha256:digest,keyGeneration:1});
  const again = await createBlobId({vmk,vaultId,plaintextSha256:digest,keyGeneration:1});
  const otherVault = await createBlobId({
    vmk,
    vaultId:'44444444-4444-4444-8444-444444444444',
    plaintextSha256:digest,
    keyGeneration:1,
  });
  assert.equal(first, again);
  assert.notEqual(first, otherVault);
});

test('I2 entity AEAD authenticates structural metadata and uses fresh 96-bit nonces', async () => {
  const nameToken = await createNameToken({vmk,vaultId,parentId,name:'Note.md',keyGeneration:1});
  const metadata = {
    vaultId,
    entityId,
    entityType:'note',
    schemaVersion:1,
    keyGeneration:1,
    parentId,
    nameToken,
    deleted:false,
    blobId:null,
  };
  const plaintext = new TextEncoder().encode('# exact source\n');
  const first = await encryptEntityPayloadV1({vmk,metadata,plaintext});
  const second = await encryptEntityPayloadV1({vmk,metadata,plaintext});
  assert.equal(base64UrlDecode(first.nonce).byteLength, 12);
  assert.notEqual(first.nonce, second.nonce);
  assert.deepEqual(
    [...await decryptEntityPayloadV1({vmk,metadata,payload:first})],
    [...plaintext],
  );

  await assert.rejects(
    () => decryptEntityPayloadV1({
      vmk,
      metadata:{...metadata,parentId:'55555555-5555-4555-8555-555555555555'},
      payload:first,
    }),
    /failed authentication/,
  );
  await assert.rejects(
    () => decryptEntityPayloadV1({
      vmk,
      metadata:{...metadata,deleted:true},
      payload:first,
    }),
    /failed authentication/,
  );
});

test('I2 VaultCryptoContext keeps VMK ephemeral and becomes unusable after destroy', async () => {
  const generated = generateVaultMasterKey();
  assert.equal(generated.byteLength, 32);
  const context = new VaultCryptoContext(vaultId, 1, generated);
  generated.fill(0);
  const token = await context.nameToken(null, 'Inbox.md');
  assert.match(token, /^[A-Za-z0-9_-]{43}$/u);
  context.destroy();
  await assert.rejects(() => context.nameToken(null, 'Inbox.md'), /destroyed/);
});

test('I2 canonical crypto contexts are deterministic UTF-8 JSON scalar arrays', () => {
  assert.equal(
    new TextDecoder().decode(canonicalContext(['vault/test/v1','é',1,true,null])),
    '["vault/test/v1","é",1,true,null]',
  );
  assert.throws(() => canonicalContext(['bad', 1.5]), /invalid number/);
});
