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
