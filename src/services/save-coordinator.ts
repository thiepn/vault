import { VaultError } from '../domain/errors.js';
import { assertVersion } from '../domain/integrity.js';
import type { Entry, EntryId } from '../domain/model.js';
import type { FileRepository } from './ports.js';

export type RecoveryState = 'pending' | 'stored' | 'unavailable' | 'failed';
export type SaveState = { kind: 'saved-local' } | { kind: 'saving' }
  | { kind: 'error'; error: unknown; recovery: RecoveryState };
export interface SaveOptions {
  /** Persist one session-scoped recovery draft; never overwrite canonical Markdown. */
  persistRecovery?: (text: string, baseVersion: number) => Promise<void>;
}

/** Per-editor serialized writes. Only writes not yet started may be coalesced.
 * A failed canonical save has its own recovery writer and never silently becomes
 * a successful save. The latest accepted editor text remains available throughout. */
export class SaveCoordinator {
  private pending: string | undefined;
  private running: Promise<void> | undefined;
  private version: number;
  private failure: unknown;
  private newestText: string;
  private closed = false;
  private closing = false;
  private recoveryPending: string | undefined;
  private recoveryRunning: Promise<void> | undefined;
  private recoveryFailure: unknown;
  private recoveredText: string | undefined;
  constructor(
    private readonly repository: Pick<FileRepository, 'saveMarkdown'>,
    private readonly entryId: EntryId,
    initial: { version: number; text: string },
    private readonly onState: (state: SaveState, entry?: Entry) => void,
    private readonly options: SaveOptions = {},
  ) {
    assertVersion(initial.version); this.version = initial.version; this.newestText = initial.text;
  }
  get draft(): string { return this.newestText; }
  get savedVersion(): number { return this.version; }
  get hasUnsavedChanges(): boolean { return this.pending !== undefined || this.running !== undefined || this.failure !== undefined; }
  get recoveryState(): RecoveryState {
    if (!this.options.persistRecovery) return 'unavailable';
    if (this.recoveredText === this.newestText && !this.recoveryRunning && this.recoveryPending === undefined) return 'stored';
    return this.recoveryFailure !== undefined ? 'failed' : 'pending';
  }
  get canRetry(): boolean {
    if (this.failure === undefined) return false;
    return !(this.failure instanceof VaultError && ['STALE_WRITE', 'DELETED', 'CORRUPT', 'INVALID_VERSION', 'NOT_FOUND', 'ACCOUNT_MISMATCH'].includes(this.failure.code));
  }
  update(text: string): void {
    if (this.closed || this.closing) throw new Error('This editor is closing or has been closed.');
    this.newestText = text; this.pending = text;
    if (this.failure !== undefined) { this.queueRecovery(); return; }
    this.start();
  }
  private reportFailure(): void {
    if (this.failure !== undefined) this.onState({ kind: 'error', error: this.failure, recovery: this.recoveryState });
  }
  private start(): void {
    if (this.running || this.pending === undefined || this.failure !== undefined) return;
    this.onState({ kind: 'saving' });
    this.running = this.drain().finally(() => {
      this.running = undefined;
      if (this.failure === undefined && this.pending !== undefined) this.start();
    });
  }
  private async drain(): Promise<void> {
    while (this.pending !== undefined) {
      const text = this.pending; this.pending = undefined;
      try {
        const entry = await this.repository.saveMarkdown(this.entryId, text, this.version);
        this.version = entry.localVersion;
        if (this.pending === undefined) this.onState({ kind: 'saved-local' }, entry);
      } catch (error) {
        this.failure = error === undefined ? new VaultError('STORAGE', 'The local save failed without an error value.') : error; this.pending = this.newestText;
        this.queueRecovery(); return;
      }
    }
  }
  private queueRecovery(): void {
    this.recoveryPending = this.newestText; this.recoveryFailure = undefined;
    this.startRecovery(); this.reportFailure();
  }
  private startRecovery(): void {
    if (this.recoveryRunning || this.recoveryPending === undefined || !this.options.persistRecovery) return;
    this.recoveryRunning = this.drainRecovery().finally(() => {
      this.recoveryRunning = undefined;
      if (this.recoveryPending !== undefined && this.recoveryFailure === undefined) this.startRecovery();
      this.reportFailure();
    });
  }
  private async drainRecovery(): Promise<void> {
    while (this.recoveryPending !== undefined && this.options.persistRecovery) {
      const text = this.recoveryPending; this.recoveryPending = undefined;
      try {
        await this.options.persistRecovery(text, this.version); this.recoveredText = text;
      } catch (error) {
        this.recoveryFailure = error === undefined ? new VaultError('STORAGE', 'The recovery save failed without an error value.') : error; this.recoveryPending = this.newestText; return;
      }
    }
  }
  async flush(): Promise<void> {
    while (this.running) await this.running;
    while (this.recoveryRunning) await this.recoveryRunning;
    if (this.failure !== undefined) throw this.failure;
  }
  async retry(): Promise<void> {
    if (this.closed || this.closing) throw new Error('This editor is closing or has been closed.');
    if (!this.canRetry) throw this.failure ?? new VaultError('STORAGE', 'There is no retryable save failure.');
    while (this.running) await this.running;
    this.failure = undefined; this.pending = this.newestText; this.start(); await this.flush();
  }
  async preserveRecovery(): Promise<void> {
    if (!this.options.persistRecovery) throw new VaultError('UNSUPPORTED', 'Durable recovery is unavailable. Export your draft before leaving.');
    this.queueRecovery();
    while (this.recoveryRunning) await this.recoveryRunning;
    if (this.recoveredText !== this.newestText || this.recoveryFailure !== undefined) throw new VaultError('STORAGE', 'The latest recovery draft could not be saved. Keep the editor open and export the draft.', { cause: this.recoveryFailure });
  }
  async close(): Promise<void> {
    this.closing = true;
    try { await this.flush(); this.closed = true; } finally { this.closing = false; }
  }
  /** Explicit user recovery action. A downloaded-file attempt is not proof of safety. */
  async closeToRecovery(): Promise<void> {
    this.closing = true;
    try {
      try { await this.flush(); } catch { await this.preserveRecovery(); }
      this.closed = true;
    } finally { this.closing = false; }
  }
}
