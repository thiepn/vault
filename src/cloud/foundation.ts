import { VaultError } from '../domain/errors.js';
import type { AccountId, CloudVaultBinding, DeviceId, Vault } from '../domain/model.js';
import type { VaultRepository, AuthIdentity } from '../services/ports.js';
import { projectRefFromUrl } from './config.js';
import { SupabaseRestAuth, type SignUpResult } from './auth-rest.js';
import { defaultDeviceLabel, ensureDeviceId, type KeyValueStorage } from './device.js';
import { SupabaseCloudRegistry, type CloudAccount, type CloudDevice, type RemoteCloudVault } from './supabase-registry.js';

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
    return {
      signedIn:true,
      identity:initialized.identity,
      account:initialized.account,
      device:initialized.device,
      remoteVaults:await this.registry.listVaults(initialized.account),
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
      projectRef:projectRefFromUrl(this.projectUrl),
      remoteVaultId:remote.id,
      epoch:remote.epoch,
      protocolVersion:1,
      deviceId:this.deviceId,
      adoptedAt:new Date().toISOString(),
    };
    return this.vaults.adoptCloud(vault.id,binding);
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
