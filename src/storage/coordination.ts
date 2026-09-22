import { VaultError } from '../domain/errors.js';

interface NavigatorWithLocks {
  locks?: LockManager;
}

interface BroadcastEnvelope {
  sourceId: string;
  message: VaultInvalidation;
}

function sessionIdentity(): string {
  try { return crypto.randomUUID(); }
  catch { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
}

export async function withVaultExclusiveLock<T>(name: string, body: () => Promise<T>): Promise<T> {
  if (!name || name.length > 200) throw new VaultError('CORRUPT', 'Invalid storage lock name.');
  const locks = typeof navigator === 'undefined' ? undefined : (navigator as NavigatorWithLocks).locks;
  if (!locks) return body();
  return locks.request('vault:' + name, { mode: 'exclusive' }, body);
}

export type VaultInvalidation =
  | { kind: 'entity-changed'; vaultId: string; entityId: string }
  | { kind: 'entity-deleted'; vaultId: string; entityId: string }
  | { kind: 'note-saved'; vaultId: string; entityId: string }
  | { kind: 'settings-changed'; vaultId: string; key: string }
  | { kind: 'migration-started'; vaultId: string | null }
  | { kind: 'migration-finished'; vaultId: string | null };

function isInvalidation(value: unknown): value is VaultInvalidation {
  if (!value || typeof value !== 'object' || !('kind' in value)) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === 'entity-changed' || kind === 'entity-deleted' || kind === 'note-saved'
    || kind === 'settings-changed' || kind === 'migration-started' || kind === 'migration-finished';
}

export class VaultBroadcast {
  private readonly channel: BroadcastChannel | null;
  readonly sourceId: string;

  constructor(
    readonly name = 'vault:storage',
    private readonly onMessage?: (message: VaultInvalidation) => void,
    sourceId?: string,
  ) {
    this.sourceId = sourceId ?? sessionIdentity();
    this.channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(name);
    if (this.channel && onMessage) {
      this.channel.addEventListener('message', event => {
        const value = event.data as unknown;

        if (value && typeof value === 'object' && 'sourceId' in value && 'message' in value) {
          const envelope = value as BroadcastEnvelope;
          if (envelope.sourceId === this.sourceId || !isInvalidation(envelope.message)) return;
          onMessage(envelope.message);
          return;
        }

        // Backward compatibility for pre-session-envelope A2 tabs.
        if (isInvalidation(value)) onMessage(value);
      });
    }
  }

  post(message: VaultInvalidation): void {
    this.channel?.postMessage({ sourceId: this.sourceId, message } satisfies BroadcastEnvelope);
  }

  close(): void {
    this.channel?.close();
  }
}
