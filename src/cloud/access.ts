import type { CloudVaultBinding, CloudVaultRole } from '../domain/model.js';

export function effectiveCloudRole(binding: CloudVaultBinding | undefined): CloudVaultRole {
  return binding?.accessRole ?? 'owner';
}

export function cloudRoleCanRead(role: CloudVaultRole): boolean {
  return role === 'owner' || role === 'editor' || role === 'viewer';
}

export function cloudRoleCanWrite(role: CloudVaultRole): boolean {
  return role === 'owner' || role === 'editor';
}

export function cloudBindingCanRead(binding: CloudVaultBinding | undefined): boolean {
  return !!binding && cloudRoleCanRead(effectiveCloudRole(binding));
}

export function cloudBindingCanWrite(binding: CloudVaultBinding | undefined): boolean {
  return !!binding && cloudRoleCanWrite(effectiveCloudRole(binding));
}

export function cloudOwnerAccountId(binding: CloudVaultBinding): CloudVaultBinding['accountId'] {
  return binding.ownerAccountId ?? binding.accountId;
}

export function cloudOwnerAuthUserId(binding: CloudVaultBinding): string {
  return binding.ownerAuthUserId ?? binding.authUserId;
}


/**
 * Protocol v1 exposes canonical plaintext to the legacy collaboration/sync
 * backend. After I5 the canonical Vault owner must never use that channel:
 * owner Vaults are either encryption-pending (v1) or E2EE (v2). Only legacy
 * non-owner shared-v1 compatibility may still use the old transport.
 */
export function legacyPlaintextCloudChannelAllowed(binding: CloudVaultBinding | undefined): boolean {
  return !!binding && binding.protocolVersion === 1 && effectiveCloudRole(binding) !== 'owner';
}
