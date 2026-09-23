import { VaultError } from '../domain/errors.js';
import type { AccountId, Vault } from '../domain/model.js';
import type { VaultRepository } from '../services/ports.js';
import type { VaultKeyReadiness } from '../cloud/key-registry.js';
import type { SupabaseSyncTransport } from './transport.js';
import type { SyncLocalStateV2 } from './local-state-v2.js';
import { encryptedProtocolV2Status } from './capabilities.js';

export interface ProtocolV2ActivationResult {
  vault:Vault;
  readiness:VaultKeyReadiness;
}

export class ProtocolV2Activation {
  constructor(
    private readonly transport:Pick<SupabaseSyncTransport,'capabilities'|'upgradeV2'>,
    private readonly state:SyncLocalStateV2,
    private readonly vaults:Pick<VaultRepository,'updateCloudProtocol'>,
    private readonly readiness:(vaultId:Vault['id'],deviceId:NonNullable<Vault['cloud']>['deviceId'])=>Promise<VaultKeyReadiness>,
  ){}

  async activate(vault:Vault,accountId:AccountId):Promise<ProtocolV2ActivationResult>{
    if(vault.mode!=='cloud'||!vault.cloud) throw new VaultError('PROTOCOL','Only an adopted cloud Vault can activate Protocol v2.');
    const binding=vault.cloud;
    if(binding.accountId!==accountId) throw new VaultError('ACCOUNT_MISMATCH','Vault cloud binding belongs to another AccountId.');
    if((binding.ownerAccountId??binding.accountId)!==accountId||(binding.accessRole??'owner')!=='owner'){
      throw new VaultError('PERMISSION','Cross-Account encrypted Vault sharing is not enabled.');
    }
    if(binding.protocolVersion===2){
      const ready=await this.readiness(vault.id,binding.deviceId);
      if(!ready.ready) throw new VaultError('PERMISSION','This Device no longer has a ready Vault key distribution.');
      return {vault,readiness:ready};
    }

    const capabilities=await this.transport.capabilities();
    const ready=await this.readiness(vault.id,binding.deviceId);
    const status=encryptedProtocolV2Status(capabilities,{
      cryptoSuiteReady:true,
      deviceKeysReady:ready.deviceEnvelope&&ready.recoveryEnvelope&&ready.deviceAuthorized,
      encryptedRemoteStateReady:true,
    });
    if(!status.ready){
      throw new VaultError('CONFIGURATION',status.reason ?? 'Encrypted Protocol v2 synchronization is not ready.');
    }
    if(!ready.ready||ready.keyGeneration===null){
      throw new VaultError('PERMISSION','Device and Recovery envelopes must be ready before Protocol v2 activation.');
    }

    const migration={
      vaultId:vault.id,
      legacyAuthUserId:binding.authUserId,
      accountId,
      epoch:binding.epoch,
    };
    await this.state.assertCanMigrateEmptyV1State(migration);

    // The server upgrade is idempotent. It happens before local state because a
    // local write failure can be retried safely; the reverse order could leave a
    // browser refusing v1 while the server still only accepts v1.
    const remote=await this.transport.upgradeV2(vault.id,binding.deviceId);
    if(remote.epoch!==binding.epoch){
      throw new VaultError('PROTOCOL','Protocol v2 activation returned a different synchronization epoch.');
    }

    await this.state.migrateEmptyV1State(migration);
    const updated=await this.vaults.updateCloudProtocol(vault.id,2);
    return {vault:updated,readiness:ready};
  }
}
