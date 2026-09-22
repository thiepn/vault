import { VaultError } from '../domain/errors.js';

interface NavigatorWithLocks {
  locks?: LockManager;
}

export async function withVaultExclusiveLock<T>(name: string, body: () => Promise<T>): Promise<T> {
  if (!name || name.length > 200) throw new VaultError('CORRUPT', 'Invalid storage lock name.');
  const locks = typeof navigator === 'undefined' ? undefined : (navigator as NavigatorWithLocks).locks;
  if (!locks) return body();
  return locks.request(\`vault:\${name}\`, { mode: 'exclusive' }, body);
}

export type VaultInvalidation =
  | { kind: 'entity-changed'; vaultId: string; entityId: string }
  | { kind: 'entity-deleted'; vaultId: string; entityId: string }
  | { kind: 'note-saved'; vaultId: string; entityId: string }
  | { kind: 'settings-changed'; vaultId: string; key: string }
  | { kind: 'migration-started'; vaultId: string | null }
  | { kind: 'migration-finished'; vaultId: string | null };

export class VaultBroadcast {
  private readonly channel: BroadcastChannel | null;

  constructor(
    readonly name = 'vault:storage',
    private readonly onMessage?: (message: VaultInvalidation) => void,
  ) {
    this.channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(name);
    if (this.channel && onMessage) {
      this.channel.addEventListener('message', event => {
        const value = event.data as unknown;
        if (!value || typeof value !== 'object' || !('kind' in value)) return;
        onMessage(value as VaultInvalidation);
      });
    }
  }

  post(message: VaultInvalidation): void {
    this.channel?.postMessage(message);
  }

  close(): void {
    this.channel?.close();
  }
}
