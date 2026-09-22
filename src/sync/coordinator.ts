import { VaultError } from '../domain/errors.js';
import { retryDelay } from './protocol.js';

export type SyncTrigger = 'manual' | 'startup' | 'interval' | 'online' | 'focus' | 'visibility' | 'local-change' | 'peer' | 'realtime';

export type SyncLockResult<T> =
  | { acquired: false }
  | { acquired: true; value: T };

interface NavigatorWithLocks {
  locks?: LockManager;
}

export async function withBrowserSyncLock<T>(key: string, body: () => Promise<T>): Promise<SyncLockResult<T>> {
  if (!key || key.length > 512) throw new VaultError('PROTOCOL', 'Invalid synchronization lock identity.');
  const locks = typeof navigator === 'undefined' ? undefined : (navigator as NavigatorWithLocks).locks;
  if (!locks) return { acquired: true, value: await body() };
  return locks.request('vault:sync:' + key, { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) return { acquired: false } as const;
    return { acquired: true, value: await body() } as const;
  });
}

export interface SyncCoordinatorOptions {
  eligible: () => boolean;
  key: () => string | null;
  run: (trigger: SyncTrigger) => Promise<void>;
  onError?: (error: unknown, retryAt: number) => void;
  onSuccess?: (trigger: SyncTrigger) => void;
  intervalMs?: number;
  debounceMs?: number;
  lock?: <T>(key: string, body: () => Promise<T>) => Promise<SyncLockResult<T>>;
  random?: () => number;
  now?: () => number;
}

/**
 * Single-flight synchronization scheduler.
 *
 * It coalesces local-change, focus, online and periodic requests, leaves pending
 * work queued while the workspace is temporarily ineligible, and uses Web Locks
 * when available so multiple tabs do not run the same Vault replication loop at
 * once. Browsers may throttle/suspend timers in the background; visibility and
 * reconnect wakeups therefore remain first-class triggers.
 */
export class SyncCoordinator {
  private readonly intervalMs: number;
  private readonly debounceMs: number;
  private readonly lock: NonNullable<SyncCoordinatorOptions['lock']>;
  private readonly random: () => number;
  private readonly now: () => number;
  private stopped = true;
  private running = false;
  private pending: SyncTrigger | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private failures = 0;

  constructor(private readonly options: SyncCoordinatorOptions) {
    this.intervalMs = Math.max(5_000, options.intervalMs ?? 30_000);
    this.debounceMs = Math.max(0, options.debounceMs ?? 900);
    this.lock = options.lock ?? withBrowserSyncLock;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.interval = setInterval(() => this.wake('interval'), this.intervalMs);
    if (this.pending) this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.interval !== null) clearInterval(this.interval);
    this.timer = null;
    this.interval = null;
  }

  request(trigger: SyncTrigger, delay = this.debounceMs): void {
    if (this.pending === null || this.pending === 'interval' || trigger === 'local-change') this.pending = trigger;
    if (!this.stopped) this.schedule(delay);
  }

  wake(trigger: SyncTrigger): void {
    if (this.pending === null) this.pending = trigger;
    if (this.stopped) return;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.schedule(0);
  }

  private schedule(delay: number): void {
    if (this.stopped || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, Math.max(0, delay));
  }

  private async drain(): Promise<void> {
    if (this.stopped || this.running || !this.pending || !this.options.eligible()) return;
    const key = this.options.key();
    if (!key) return;

    const trigger = this.pending;
    this.pending = null;
    this.running = true;
    let deferred = false;
    try {
      const result = await this.lock(key, () => this.options.run(trigger));
      if (!result.acquired) {
        this.pending ??= trigger;
        deferred = true;
        this.schedule(1_500);
      } else {
        this.failures = 0;
        this.options.onSuccess?.(trigger);
      }
    } catch (error) {
      this.failures++;
      this.pending ??= trigger;
      const delay = retryDelay(this.failures, this.random());
      deferred = true;
      this.schedule(delay);
      this.options.onError?.(error, this.now() + delay);
    } finally {
      this.running = false;
      if (!deferred && this.pending && this.options.eligible()) this.schedule(0);
    }
  }
}
