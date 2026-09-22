import { backendConfiguration, type PublicBackendConfig } from '../services/runtime-config.js';

export const DEFAULT_CLOUD_PROJECT_REF = 'bskfihouwdogrunnglbg';
export const DEFAULT_CLOUD_CONFIG: PublicBackendConfig = {
  url: 'https://bskfihouwdogrunnglbg.supabase.co',
  publishableKey: 'sb_publishable_wrBDATchmZXFFr3t8OXoQA_IsjlhrZM',
};

export interface BrowserCloudOverride {
  url?: string;
  publishableKey?: string;
}

declare global {
  interface Window {
    __VAULT_CLOUD_CONFIG__?: BrowserCloudOverride;
  }
}

export function projectRefFromUrl(url: string): string {
  const hostname = new URL(url).hostname;
  const match = /^([a-z0-9-]+)\.supabase\.co$/iu.exec(hostname);
  return match?.[1] ?? hostname.replace(/[^a-z0-9-]+/giu, '-');
}

export function browserCloudConfiguration(): PublicBackendConfig {
  const override = typeof window !== 'undefined' ? window.__VAULT_CLOUD_CONFIG__ : undefined;
  const resolved = backendConfiguration(
    override?.url ?? DEFAULT_CLOUD_CONFIG.url,
    override?.publishableKey ?? DEFAULT_CLOUD_CONFIG.publishableKey,
  );
  if (resolved.kind !== 'configured-unverified') throw new Error('Vault cloud configuration is unavailable.');
  return resolved.config;
}
