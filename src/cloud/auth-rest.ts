import { VaultError } from '../domain/errors.js';
import type { AuthIdentity, AuthService } from '../services/ports.js';
import type { PublicBackendConfig } from '../services/runtime-config.js';
import type { KeyValueStorage } from './device.js';
import { projectRefFromUrl } from './config.js';

export interface SupabaseStoredSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  expires_at?: unknown;
}

interface UserResponse {
  id?: unknown;
  email?: unknown;
}

export interface SignUpResult {
  signedIn: boolean;
}

type FetchLike = typeof fetch;

function sessionStorageKey(config: PublicBackendConfig): string {
  return `vault:supabase-session:${projectRefFromUrl(config.url)}`;
}

function parseErrorPayload(value: unknown, fallback: string): string {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['msg', 'message', 'error_description', 'error']) {
      if (typeof record[key] === 'string' && record[key]) return record[key] as string;
    }
  }
  return fallback;
}

async function responseJson(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return null; }
}

function tokenSession(value: unknown): SupabaseStoredSession | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as TokenResponse;
  if (typeof record.access_token !== 'string' || typeof record.refresh_token !== 'string') return null;
  const expiresAt = typeof record.expires_at === 'number'
    ? record.expires_at
    : Math.floor(Date.now() / 1000) + (typeof record.expires_in === 'number' ? record.expires_in : 3600);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return null;
  return { accessToken: record.access_token, refreshToken: record.refresh_token, expiresAt };
}

export class SupabaseRestAuth implements AuthService {
  readonly configured = true;
  private readonly key: string;

  constructor(
    private readonly config: PublicBackendConfig,
    private readonly storage: KeyValueStorage,
    private readonly request: FetchLike = fetch,
  ) {
    this.key = sessionStorageKey(config);
  }

  private headers(accessToken?: string): HeadersInit {
    return {
      apikey: this.config.publishableKey,
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    };
  }

  private readSession(): SupabaseStoredSession | null {
    const raw = this.storage.getItem(this.key);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object') return null;
      const record = parsed as Record<string, unknown>;
      if (typeof record.accessToken !== 'string' || typeof record.refreshToken !== 'string' || typeof record.expiresAt !== 'number') return null;
      return { accessToken: record.accessToken, refreshToken: record.refreshToken, expiresAt: record.expiresAt };
    } catch {
      return null;
    }
  }

  private writeSession(session: SupabaseStoredSession | null): void {
    if (!session) {
      this.storage.setItem(this.key, '');
      return;
    }
    this.storage.setItem(this.key, JSON.stringify(session));
  }

  private async tokenRequest(grant: string, body: Record<string, unknown>): Promise<SupabaseStoredSession> {
    const response = await this.request(`${this.config.url}/auth/v1/token?grant_type=${encodeURIComponent(grant)}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    const payload = await responseJson(response);
    if (!response.ok) throw new VaultError('CONFIGURATION', parseErrorPayload(payload, 'Supabase authentication failed.'));
    const session = tokenSession(payload);
    if (!session) throw new VaultError('PROTOCOL', 'Supabase returned an invalid authentication session.');
    this.writeSession(session);
    return session;
  }

  private async freshSession(): Promise<SupabaseStoredSession | null> {
    const current = this.readSession();
    if (!current) return null;
    if (current.expiresAt > Math.floor(Date.now() / 1000) + 60) return current;
    try {
      return await this.tokenRequest('refresh_token', { refresh_token: current.refreshToken });
    } catch (error) {
      this.writeSession(null);
      throw error;
    }
  }

  async signIn(email: string, password: string): Promise<void> {
    const normalizedEmail = email.trim();
    if (!normalizedEmail || !password) throw new VaultError('CONFIGURATION', 'Enter an email address and password.');
    await this.tokenRequest('password', { email: normalizedEmail, password });
  }

  async signUp(email: string, password: string): Promise<SignUpResult> {
    const normalizedEmail = email.trim();
    if (!normalizedEmail || password.length < 12) throw new VaultError('CONFIGURATION', 'Use a valid email address and a password with at least 12 characters.');
    const response = await this.request(`${this.config.url}/auth/v1/signup`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ email: normalizedEmail, password }),
    });
    const payload = await responseJson(response);
    if (!response.ok) throw new VaultError('CONFIGURATION', parseErrorPayload(payload, 'Supabase account creation failed.'));
    const session = tokenSession(payload);
    if (session) this.writeSession(session);
    return { signedIn: !!session };
  }

  googleAuthorizeUrl(redirectTo: string): string {
    const redirect = new URL(redirectTo);
    if (redirect.protocol !== 'https:' && !(redirect.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(redirect.hostname))) {
      throw new VaultError('CONFIGURATION', 'Google sign-in redirect must use HTTPS outside local development.');
    }
    const url = new URL(`${this.config.url}/auth/v1/authorize`);
    url.searchParams.set('provider', 'google');
    url.searchParams.set('redirect_to', redirect.toString());
    return url.toString();
  }

  consumeImplicitOAuthRedirect(url: string): boolean {
    const parsed = new URL(url);
    const params = new URLSearchParams(parsed.hash.replace(/^#/u, ''));
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');
    if (!accessToken || !refreshToken) return false;
    const expiresIn = Number(params.get('expires_in') ?? '3600');
    this.writeSession({
      accessToken,
      refreshToken,
      expiresAt: Math.floor(Date.now() / 1000) + (Number.isFinite(expiresIn) ? expiresIn : 3600),
    });
    return true;
  }

  async accessToken(): Promise<string | null> {
    return (await this.freshSession())?.accessToken ?? null;
  }

  async identity(): Promise<AuthIdentity | null> {
    const session = await this.freshSession();
    if (!session) return null;
    const response = await this.request(`${this.config.url}/auth/v1/user`, {
      method: 'GET',
      headers: this.headers(session.accessToken),
    });
    const payload = await responseJson(response);
    if (response.status === 401) {
      this.writeSession(null);
      return null;
    }
    if (!response.ok) throw new VaultError('CONFIGURATION', parseErrorPayload(payload, 'Supabase user lookup failed.'));
    const user = payload as UserResponse;
    if (typeof user.id !== 'string') throw new VaultError('PROTOCOL', 'Supabase returned an invalid user identity.');
    return { userId: user.id, email: typeof user.email === 'string' ? user.email : null };
  }

  async signOut(): Promise<void> {
    const session = this.readSession();
    if (session) {
      const response = await this.request(`${this.config.url}/auth/v1/logout?scope=local`, {
        method: 'POST',
        headers: this.headers(session.accessToken),
      });
      if (!response.ok && response.status !== 401) {
        const payload = await responseJson(response);
        throw new VaultError('CONFIGURATION', parseErrorPayload(payload, 'Supabase sign-out failed.'));
      }
    }
    this.writeSession(null);
  }
}
