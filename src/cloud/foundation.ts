import { VaultError } from '../domain/errors.js';
import type { AccountId, CloudVaultBinding, DeviceId, Vault } from '../domain/model.js';
import type { VaultRepository, AuthIdentity } from '../services/ports.js';
import { projectRefFromUrl } from './config.js';
import { SupabaseRestAuth, type SignUpResult } from './auth-rest.js';
import { defaultDeviceLabel, ensureDeviceId, type KeyValueStorage } from './device.js';
import { SupabaseCloudRegistry, type CloudAccount, type CloudDevice, type CloudShareInvite, type CloudVaultMember, type RemoteCloudVault } from './supabase-registry.js';
import { SyncLocalState } from '../sync/local-state.js';

export interface CloudFoundationStatus {
  signedIn: boolean;
  identity: AuthIdentity|null;
  account: CloudAccount|null;
  device: CloudDevice|null;
  remoteVaults: RemoteCloudVault[];
}

export class CloudFoundation {
  readonly deviceId: DeviceId;
  private account: CloudAccount|null=null;
  private device: CloudDevice|null=null;

  constructor(
    readonly auth: SupabaseRestAuth,
    readonly registry: SupabaseCloudRegistry,
    private readonly vaults: VaultRepository,
    private readonly syncState: SyncLocalState,
    private readonly storage: KeyValueStorage,
    private readonly projectUrl: string,
    private readonly userAgent='',
    private readonly platform='',
  ) {
    this.deviceId=ensureDeviceId(storage);
  }

  async initializeIdentity(): Promise<{identity:AuthIdentity;account:CloudAccount;device:CloudDevice}|null> {
    const identity=await this.auth.identity();
    if (!identity) { this.account=null; this.device=null; return null; }
    const account=await this.registry.ensureAccount(identity);
    const device=await this.registry.registerDevice(account,this.deviceId,defaultDeviceLabel(this.userAgent,this.platform),'web');
    this.account=account;
    this.device=device;
    return {identity,account,device};
  }

  async status(): Promise<CloudFoundationStatus> {
    const initialized=await this.initializeIdentity();
    if (!initialized) return {signedIn:false,identity:null,account:null,device:null,remoteVaults:[]};
    const remoteVaults=await this.registry.listVaults(initialized.account);
    const byId=new Map(remoteVaults.map(remote=>[remote.id,remote]));
    for(const local of await this.vaults.listVaults()){
      if(local.mode!=='cloud' || !local.cloud || local.cloud.authUserId!==initialized.identity.userId) continue;
      const remote=byId.get(local.id);
      const role=remote?.accessRole ?? 'revoked';
      const ownerAccountId=remote?.ownerAccountId ?? local.cloud.ownerAccountId ?? local.cloud.accountId;
      const ownerAuthUserId=remote?.ownerAuthUserId ?? local.cloud.ownerAuthUserId ?? local.cloud.authUserId;
      if(local.cloud.accessRole!==role || local.cloud.ownerAccountId!==ownerAccountId || local.cloud.ownerAuthUserId!==ownerAuthUserId){
        await this.vaults.updateCloudAccess(local.id,{accessRole:role,ownerAccountId,ownerAuthUserId});
      }
    }
    return {
      signedIn:true,
      identity:initialized.identity,
      account:initialized.account,
      device:initialized.device,
      remoteVaults,
    };
  }

  async signIn(email:string,password:string): Promise<CloudFoundationStatus> {
    await this.auth.signIn(email,password);
    return this.status();
  }

  async signUp(email:string,password:string): Promise<{result:SignUpResult;status:CloudFoundationStatus}> {
    const result=await this.auth.signUp(email,password);
    return {result,status:await this.status()};
  }

  googleAuthorizeUrl(redirectTo:string): string { return this.auth.googleAuthorizeUrl(redirectTo); }

  consumeOAuthRedirect(url:string): boolean { return this.auth.consumeImplicitOAuthRedirect(url); }

  async signOut(): Promise<void> {
    await this.auth.signOut();
    this.account=null;
    this.device=null;
  }

  async adoptVault(vault: Vault): Promise<Vault> {
    const initialized=await this.initializeIdentity();
    if (!initialized) throw new VaultError('ACCOUNT_MISMATCH','Sign in before enabling cloud sync.');
    if (this.device?.revokedAt) throw new VaultError('ACCOUNT_MISMATCH','This device has been revoked. Sign in again from an authorized device.');
    if (vault.mode === 'cloud') {
      if (!vault.cloud || vault.cloud.accountId !== initialized.account.id || vault.cloud.authUserId !== initialized.identity.userId) {
        throw new VaultError('ACCOUNT_MISMATCH','This Vault is already linked to another cloud account.');
      }
      return vault;
    }
    const remote=await this.registry.adoptVault(initialized.account,vault.id,vault.name);
    const binding: CloudVaultBinding={
      accountId:initialized.account.id as AccountId,
      authUserId:initialized.identity.userId,
      ownerAccountId:initialized.account.id as AccountId,
      ownerAuthUserId:initialized.identity.userId,
      accessRole:'owner',
      projectRef:projectRefFromUrl(this.projectUrl),
      remoteVaultId:remote.id,
      epoch:remote.epoch,
      protocolVersion:1,
      deviceId:this.deviceId,
      adoptedAt:new Date().toISOString(),
    };
    await this.syncState.initializeCursor(vault.id, initialized.identity.userId, remote.epoch);
    return this.vaults.adoptCloud(vault.id,binding);
  }

  async addRemoteVault(remote: RemoteCloudVault): Promise<Vault> {
    if(remote.protocolVersion===2){
      throw new VaultError('UNSUPPORTED','Adding an encrypted remote Vault on a second Device begins in I8 after encrypted bootstrap certification.');
    }
    const initialized=await this.initializeIdentity();
    if (!initialized) throw new VaultError('ACCOUNT_MISMATCH','Sign in before adding a cloud Vault to this device.');
    if (this.device?.revokedAt) throw new VaultError('ACCOUNT_MISMATCH','This device has been revoked.');
    if (remote.accountId !== initialized.account.id || remote.authUserId !== initialized.identity.userId || remote.disabledAt) {
      throw new VaultError('ACCOUNT_MISMATCH','That remote Vault is not available to this account.');
    }
    const binding: CloudVaultBinding={
      accountId:initialized.account.id as AccountId,
      authUserId:initialized.identity.userId,
      ownerAccountId:remote.ownerAccountId,
      ownerAuthUserId:remote.ownerAuthUserId,
      accessRole:remote.accessRole,
      projectRef:projectRefFromUrl(this.projectUrl),
      remoteVaultId:remote.id,
      epoch:remote.epoch,
      protocolVersion:1,
      deviceId:this.deviceId,
      adoptedAt:new Date().toISOString(),
    };
    const vault=await this.vaults.createCloudReplica(remote.name,binding);
    await this.syncState.initializeCursor(vault.id,initialized.identity.userId,remote.epoch);
    return vault;
  }

  async listMembers(vaultId: RemoteCloudVault['id']): Promise<CloudVaultMember[]> {
    const initialized=await this.initializeIdentity();
    if(!initialized) throw new VaultError('ACCOUNT_MISMATCH','Sign in before managing shared Vault access.');
    return this.registry.listMembers(vaultId);
  }

  async createShareInvite(vaultId: RemoteCloudVault['id'], role:'editor'|'viewer', expiresHours=168): Promise<CloudShareInvite> {
    const initialized=await this.initializeIdentity();
    if(!initialized) throw new VaultError('ACCOUNT_MISMATCH','Sign in before sharing a Vault.');
    return this.registry.createInvite(vaultId,role,expiresHours);
  }

  async acceptShareInvite(token:string): Promise<RemoteCloudVault> {
    const initialized=await this.initializeIdentity();
    if(!initialized) throw new VaultError('ACCOUNT_MISMATCH','Sign in before accepting a Vault invitation.');
    const remote=await this.registry.acceptInvite(token);
    if(remote.accountId!==initialized.account.id || remote.authUserId!==initialized.identity.userId){
      throw new VaultError('PROTOCOL','Accepted invitation returned another account membership.');
    }
    return remote;
  }

  async setMemberRole(vaultId:RemoteCloudVault['id'],memberAuthUserId:string,role:'editor'|'viewer'|null):Promise<void>{
    const initialized=await this.initializeIdentity();
    if(!initialized) throw new VaultError('ACCOUNT_MISMATCH','Sign in before managing shared Vault access.');
    await this.registry.setMemberRole(vaultId,memberAuthUserId,role);
  }

  async listDevices(): Promise<CloudDevice[]> {
    const initialized=await this.initializeIdentity();
    if (!initialized) return [];
    return this.registry.listDevices(initialized.account);
  }

  async revokeDevice(deviceId:DeviceId): Promise<void> {
    const initialized=await this.initializeIdentity();
    if (!initialized) throw new VaultError('ACCOUNT_MISMATCH','Sign in before managing devices.');
    if (deviceId === this.deviceId) throw new VaultError('UNSUPPORTED','Sign out on this device instead of revoking the active device.');
    await this.registry.revokeDevice(initialized.account,deviceId);
  }
}
