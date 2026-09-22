import { VaultError } from '../domain/errors.js';
import type { AccountId, DeviceId, VaultId } from '../domain/model.js';
import type { AuthIdentity } from '../services/ports.js';
import type { PublicBackendConfig } from '../services/runtime-config.js';

export interface CloudAccount {
  id: AccountId;
  authUserId: string;
  createdAt: string;
}

export interface CloudDevice {
  id: DeviceId;
  accountId: AccountId;
  authUserId: string;
  label: string;
  platform: string;
  createdAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
}

export interface RemoteCloudVault {
  id: VaultId;
  accountId: AccountId;
  authUserId: string;
  name: string;
  epoch: string;
  protocolVersion: 1;
  createdAt: string;
  updatedAt: string;
  disabledAt: string | null;
}

type FetchLike = typeof fetch;

function mapAccount(value: unknown): CloudAccount {
  if (!value || typeof value !== 'object') throw new VaultError('PROTOCOL', 'Cloud account response is invalid.');
  const r=value as Record<string,unknown>;
  if (typeof r.id !== 'string' || typeof r.auth_user_id !== 'string' || typeof r.created_at !== 'string') throw new VaultError('PROTOCOL', 'Cloud account response is invalid.');
  return { id:r.id as AccountId, authUserId:r.auth_user_id, createdAt:r.created_at };
}

function mapDevice(value: unknown): CloudDevice {
  if (!value || typeof value !== 'object') throw new VaultError('PROTOCOL', 'Cloud device response is invalid.');
  const r=value as Record<string,unknown>;
  if (typeof r.id !== 'string' || typeof r.account_id !== 'string' || typeof r.auth_user_id !== 'string'
    || typeof r.label !== 'string' || typeof r.platform !== 'string' || typeof r.created_at !== 'string'
    || typeof r.last_seen_at !== 'string' || !(typeof r.revoked_at === 'string' || r.revoked_at === null)) {
    throw new VaultError('PROTOCOL', 'Cloud device response is invalid.');
  }
  return {
    id:r.id as DeviceId,
    accountId:r.account_id as AccountId,
    authUserId:r.auth_user_id,
    label:r.label,
    platform:r.platform,
    createdAt:r.created_at,
    lastSeenAt:r.last_seen_at,
    revokedAt:r.revoked_at as string|null,
  };
}

function mapVault(value: unknown): RemoteCloudVault {
  if (!value || typeof value !== 'object') throw new VaultError('PROTOCOL', 'Cloud Vault response is invalid.');
  const r=value as Record<string,unknown>;
  if (typeof r.id !== 'string' || typeof r.account_id !== 'string' || typeof r.auth_user_id !== 'string'
    || typeof r.name !== 'string' || typeof r.epoch !== 'string' || r.protocol_version !== 1
    || typeof r.created_at !== 'string' || typeof r.updated_at !== 'string'
    || !(typeof r.disabled_at === 'string' || r.disabled_at === null)) {
    throw new VaultError('PROTOCOL', 'Cloud Vault response is invalid.');
  }
  return {
    id:r.id as VaultId,
    accountId:r.account_id as AccountId,
    authUserId:r.auth_user_id,
    name:r.name,
    epoch:r.epoch,
    protocolVersion:1,
    createdAt:r.created_at,
    updatedAt:r.updated_at,
    disabledAt:r.disabled_at as string|null,
  };
}

async function json(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return null; }
}
function message(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object') {
    const r=payload as Record<string,unknown>;
    for (const key of ['message','details','hint','code']) if (typeof r[key] === 'string' && r[key]) return r[key] as string;
  }
  return fallback;
}

export class SupabaseCloudRegistry {
  constructor(
    private readonly config: PublicBackendConfig,
    private readonly token: () => Promise<string|null>,
    private readonly request: FetchLike = (input, init) => fetch(input, init),
  ) {}

  private async headers(prefer?: string): Promise<HeadersInit> {
    const accessToken=await this.token();
    if (!accessToken) throw new VaultError('ACCOUNT_MISMATCH','Sign in before using cloud features.');
    return {
      apikey:this.config.publishableKey,
      Authorization:`Bearer ${accessToken}`,
      'Content-Type':'application/json',
      ...(prefer ? { Prefer:prefer } : {}),
    };
  }

  private url(path: string): string { return `${this.config.url}/rest/v1/${path}`; }

  private async get(path: string): Promise<unknown[]> {
    const response=await this.request(this.url(path),{headers:await this.headers()});
    const payload=await json(response);
    if (!response.ok) throw new VaultError('CONFIGURATION',message(payload,'Cloud registry request failed.'));
    if (!Array.isArray(payload)) throw new VaultError('PROTOCOL','Cloud registry returned invalid rows.');
    return payload;
  }

  async ensureAccount(identity: AuthIdentity): Promise<CloudAccount> {
    const response=await this.request(this.url('vault_accounts?on_conflict=auth_user_id'),{
      method:'POST',
      headers:await this.headers('resolution=ignore-duplicates,return=representation'),
      body:JSON.stringify({auth_user_id:identity.userId}),
    });
    const payload=await json(response);
    if (!response.ok) throw new VaultError('CONFIGURATION',message(payload,'Cloud account registration failed.'));
    if (Array.isArray(payload) && payload[0]) return mapAccount(payload[0]);
    const rows=await this.get(`vault_accounts?auth_user_id=eq.${encodeURIComponent(identity.userId)}&select=id,auth_user_id,created_at&limit=1`);
    if (!rows[0]) throw new VaultError('PROTOCOL','Cloud account mapping was not returned.');
    return mapAccount(rows[0]);
  }

  async registerDevice(account: CloudAccount, deviceId: DeviceId, label: string, platform='web'): Promise<CloudDevice> {
    const response=await this.request(this.url('vault_cloud_devices?on_conflict=account_id,id'),{
      method:'POST',
      headers:await this.headers('resolution=merge-duplicates,return=representation'),
      body:JSON.stringify({
        id:deviceId,
        account_id:account.id,
        auth_user_id:account.authUserId,
        label:label.trim().slice(0,80) || 'Web browser',
        platform:platform.slice(0,40) || 'web',
        last_seen_at:new Date().toISOString(),
        revoked_at:null,
      }),
    });
    const payload=await json(response);
    if (!response.ok) throw new VaultError('CONFIGURATION',message(payload,'Cloud device registration failed.'));
    if (!Array.isArray(payload) || !payload[0]) throw new VaultError('PROTOCOL','Cloud device registration returned no row.');
    return mapDevice(payload[0]);
  }

  async listDevices(account: CloudAccount): Promise<CloudDevice[]> {
    const rows=await this.get(`vault_cloud_devices?account_id=eq.${encodeURIComponent(account.id)}&select=id,account_id,auth_user_id,label,platform,created_at,last_seen_at,revoked_at&order=created_at.asc`);
    return rows.map(mapDevice);
  }

  async revokeDevice(account: CloudAccount, deviceId: DeviceId): Promise<void> {
    const response=await this.request(this.url(`vault_cloud_devices?id=eq.${encodeURIComponent(deviceId)}&account_id=eq.${encodeURIComponent(account.id)}`),{
      method:'PATCH',
      headers:await this.headers('return=minimal'),
      body:JSON.stringify({revoked_at:new Date().toISOString()}),
    });
    const payload=await json(response);
    if (!response.ok) throw new VaultError('CONFIGURATION',message(payload,'Cloud device revocation failed.'));
  }

  async adoptVault(account: CloudAccount, vaultId: VaultId, name: string): Promise<RemoteCloudVault> {
    const response=await this.request(this.url('vault_cloud_vaults?on_conflict=id'),{
      method:'POST',
      headers:await this.headers('resolution=ignore-duplicates,return=representation'),
      body:JSON.stringify({
        id:vaultId,
        account_id:account.id,
        auth_user_id:account.authUserId,
        name:name.trim().slice(0,240),
        protocol_version:1,
      }),
    });
    const payload=await json(response);
    if (!response.ok) throw new VaultError('CONFIGURATION',message(payload,'Cloud Vault adoption failed.'));
    if (Array.isArray(payload) && payload[0]) return mapVault(payload[0]);
    const rows=await this.get(`vault_cloud_vaults?id=eq.${encodeURIComponent(vaultId)}&select=id,account_id,auth_user_id,name,epoch,protocol_version,created_at,updated_at,disabled_at&limit=1`);
    if (!rows[0]) throw new VaultError('PROTOCOL','Cloud Vault adoption returned no row.');
    const remote=mapVault(rows[0]);
    if (remote.accountId !== account.id || remote.authUserId !== account.authUserId) throw new VaultError('ACCOUNT_MISMATCH','That Vault UUID belongs to a different cloud account.');
    return remote;
  }

  async listVaults(account: CloudAccount): Promise<RemoteCloudVault[]> {
    const rows=await this.get(`vault_cloud_vaults?account_id=eq.${encodeURIComponent(account.id)}&select=id,account_id,auth_user_id,name,epoch,protocol_version,created_at,updated_at,disabled_at&disabled_at=is.null&order=updated_at.desc`);
    return rows.map(mapVault);
  }
}
