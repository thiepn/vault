import { VaultError } from '../domain/errors.js';
import { PROTOCOL_V2_VERSION } from './protocol-v2.js';

export const SYNC_CAPABILITIES_CONTRACT_VERSION = 1 as const;

export interface SyncBackendCapabilities {
  contractVersion: typeof SYNC_CAPABILITIES_CONTRACT_VERSION;
  protocolVersions: readonly number[];
  encryptedContentV2: {
    contractAvailable: boolean;
    acceptingContent: boolean;
  };
  maxMutations: number;
  maxPageEvents: number;
}

export interface ProtocolV2Prerequisites {
  cryptoSuiteReady: boolean;
  deviceKeysReady: boolean;
  encryptedRemoteStateReady: boolean;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function positiveBoundedInteger(value: unknown, label: string, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new VaultError('PROTOCOL', label + ' capability is invalid.');
  }
  return value;
}

export function validateSyncBackendCapabilities(value: unknown): SyncBackendCapabilities {
  if (!record(value)
    || value.contractVersion !== SYNC_CAPABILITIES_CONTRACT_VERSION
    || !Array.isArray(value.protocolVersions)
    || !value.protocolVersions.every(version => Number.isSafeInteger(version) && version >= 1 && version <= 255)
    || !record(value.encryptedContentV2)
    || typeof value.encryptedContentV2.contractAvailable !== 'boolean'
    || typeof value.encryptedContentV2.acceptingContent !== 'boolean') {
    throw new VaultError('PROTOCOL', 'Synchronization capability response is invalid.');
  }
  return {
    contractVersion: SYNC_CAPABILITIES_CONTRACT_VERSION,
    protocolVersions: [...value.protocolVersions] as number[],
    encryptedContentV2: {
      contractAvailable: value.encryptedContentV2.contractAvailable,
      acceptingContent: value.encryptedContentV2.acceptingContent,
    },
    maxMutations: positiveBoundedInteger(value.maxMutations, 'Maximum mutation count', 10_000),
    maxPageEvents: positiveBoundedInteger(value.maxPageEvents, 'Maximum page event count', 10_000),
  };
}

export function encryptedProtocolV2Status(
  capabilities: SyncBackendCapabilities,
  prerequisites: ProtocolV2Prerequisites,
): { ready: boolean; reason: string | null } {
  if (!capabilities.protocolVersions.includes(PROTOCOL_V2_VERSION) || !capabilities.encryptedContentV2.contractAvailable) {
    return { ready: false, reason: 'Backend does not advertise the Protocol v2 ciphertext contract.' };
  }
  if (!capabilities.encryptedContentV2.acceptingContent) {
    return { ready: false, reason: 'Backend Protocol v2 content ingestion is not enabled yet.' };
  }
  if (!prerequisites.cryptoSuiteReady) return { ready: false, reason: 'Vault Crypto Suite 1 is not initialized.' };
  if (!prerequisites.deviceKeysReady) return { ready: false, reason: 'Device key distribution is not initialized.' };
  if (!prerequisites.encryptedRemoteStateReady) return { ready: false, reason: 'Encrypted remote state is not initialized.' };
  return { ready: true, reason: null };
}
