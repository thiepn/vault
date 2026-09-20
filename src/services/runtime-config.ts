import { VaultError } from '../domain/errors.js';
export interface PublicBackendConfig { url: string; publishableKey: string }
export type BackendConfiguration = { kind: 'local-only' } | { kind: 'configured-unverified'; config: PublicBackendConfig };

export function backendConfiguration(url?: string, key?: string): BackendConfiguration {
  if (!url && !key) return { kind: 'local-only' };
  if (!url || !key) throw new VaultError('CONFIGURATION', 'Provide both the Supabase URL and its publishable key, or leave both unset.');
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new VaultError('CONFIGURATION', 'Invalid Supabase URL.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if ((parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) || parsed.username || parsed.password || parsed.hash || parsed.search || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    throw new VaultError('CONFIGURATION', 'Use a plain HTTPS Supabase origin. HTTP is allowed only for local development.');
  }
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) throw new VaultError('CONFIGURATION', 'Only a Supabase publishable key may enter the browser. Secret and service-role keys are forbidden.');
  return { kind: 'configured-unverified', config: { url: parsed.origin, publishableKey: key } };
}
