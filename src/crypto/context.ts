import { VaultError } from '../domain/errors.js';
import type { CanonicalEntityType } from '../domain/canonical.js';
import type { VaultId } from '../domain/model.js';
import type { EncryptedPayloadV1, NameToken, RemoteBlobId } from '../sync/protocol-v2.js';
import { createBlobId, createNameToken, generateVaultMasterKey, assertVaultMasterKey } from './keys.js';
import { decryptEntityPayloadV1, encryptEntityPayloadV1, type EntityAadMetadataV1 } from './entity.js';
import { decryptBlobPayloadV1, encryptBlobPayloadV1 } from './blob.js';

/**
 * In-memory convenience wrapper. I2 deliberately does not persist raw VMKs;
 * I3 owns durable device/recovery envelopes. destroy() overwrites this class's
 * copy but JavaScript cannot guarantee erasure of all engine-internal copies.
 */
export class VaultCryptoContext {
  private keyBytes: Uint8Array | null;

  constructor(
    readonly vaultId: VaultId,
    readonly keyGeneration: number,
    vmk: Uint8Array,
  ) {
    assertVaultMasterKey(vmk);
    if (!Number.isSafeInteger(keyGeneration) || keyGeneration < 1) {
      throw new VaultError('PROTOCOL', 'Vault key generation must be a positive integer.');
    }
    this.keyBytes = vmk.slice();
  }

  static generate(vaultId: VaultId, keyGeneration = 1): VaultCryptoContext {
    return new VaultCryptoContext(vaultId, keyGeneration, generateVaultMasterKey());
  }

  private key(): Uint8Array {
    if (!this.keyBytes) throw new VaultError('PERMISSION', 'Vault cryptographic context has been destroyed.');
    return this.keyBytes;
  }

  async nameToken(parentId: string | null, name: string): Promise<NameToken> {
    return createNameToken({
      vmk: this.key(),
      vaultId: this.vaultId,
      parentId,
      name,
      keyGeneration: this.keyGeneration,
    });
  }

  async blobId(plaintextSha256: Uint8Array): Promise<RemoteBlobId> {
    return createBlobId({
      vmk: this.key(),
      vaultId: this.vaultId,
      plaintextSha256,
      keyGeneration: this.keyGeneration,
    });
  }

  async encryptBlob(blobId: RemoteBlobId, plaintext: Uint8Array): Promise<Uint8Array> {
    return encryptBlobPayloadV1({
      vmk: this.key(),
      vaultId: this.vaultId,
      blobId,
      keyGeneration: this.keyGeneration,
      plaintext,
    });
  }

  async decryptBlob(blobId: RemoteBlobId, envelope: Uint8Array): Promise<Uint8Array> {
    return decryptBlobPayloadV1({
      vmk: this.key(),
      vaultId: this.vaultId,
      blobId,
      keyGeneration: this.keyGeneration,
      envelope,
    });
  }

  async encryptEntity(input: {
    entityId: string;
    entityType: CanonicalEntityType;
    schemaVersion: number;
    parentId: string | null;
    nameToken: NameToken | null;
    deleted: boolean;
    blobId: RemoteBlobId | null;
    plaintext: Uint8Array;
  }): Promise<EncryptedPayloadV1> {
    const metadata: EntityAadMetadataV1 = {
      vaultId: this.vaultId,
      entityId: input.entityId,
      entityType: input.entityType,
      schemaVersion: input.schemaVersion,
      keyGeneration: this.keyGeneration,
      parentId: input.parentId,
      nameToken: input.nameToken,
      deleted: input.deleted,
      blobId: input.blobId,
    };
    return encryptEntityPayloadV1({ vmk: this.key(), metadata, plaintext: input.plaintext });
  }

  async decryptEntity(input: {
    entityId: string;
    entityType: CanonicalEntityType;
    schemaVersion: number;
    parentId: string | null;
    nameToken: NameToken | null;
    deleted: boolean;
    blobId: RemoteBlobId | null;
    payload: EncryptedPayloadV1;
  }): Promise<Uint8Array> {
    const metadata: EntityAadMetadataV1 = {
      vaultId: this.vaultId,
      entityId: input.entityId,
      entityType: input.entityType,
      schemaVersion: input.schemaVersion,
      keyGeneration: this.keyGeneration,
      parentId: input.parentId,
      nameToken: input.nameToken,
      deleted: input.deleted,
      blobId: input.blobId,
    };
    return decryptEntityPayloadV1({ vmk: this.key(), metadata, payload: input.payload });
  }

  destroy(): void {
    this.keyBytes?.fill(0);
    this.keyBytes = null;
  }
}
