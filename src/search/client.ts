import type { EntryId } from '../domain/model.js';
import type { QuickSwitchResult, SearchFacets, SearchInput, SearchMetadataUpdate, SearchResult, SearchStats } from './types.js';
import type { SearchWorkerRequest, SearchWorkerResponse, SearchWorkerValue } from './worker-protocol.js';

type SearchWorkerCommand = SearchWorkerRequest extends infer Request
  ? Request extends { id: number } ? Omit<Request, 'id'> : never
  : never;

export interface SearchIndexClientOptions {
  onWorkerRestart?(): void;
  onWorkerFailure?(error: Error): void;
}

export class SearchIndexClient {
  private worker: Worker;
  private sequence = 0;
  private restartAttempts = 0;
  private readonly pending = new Map<number, { resolve(value: SearchWorkerValue): void; reject(error: unknown): void }>();
  private closed = false;

  constructor(private readonly options: SearchIndexClientOptions = {}) {
    this.worker = this.createWorker();
  }

  private createWorker(): Worker {
    const worker = new Worker(new URL('./search-worker.ts', import.meta.url), { type: 'module', name: 'vault-search-index' });
    worker.onmessage = (event: MessageEvent<SearchWorkerResponse>) => {
      this.restartAttempts = 0;
      const response = event.data;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.value);
      else pending.reject(new Error(response.error));
    };
    worker.onerror = event => {
      const error = new Error(event.message || 'Search worker crashed.');
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      if (this.closed) return;
      worker.terminate();
      this.restartAttempts++;
      if (this.restartAttempts <= 3) {
        this.worker = this.createWorker();
        this.options.onWorkerRestart?.();
      } else {
        this.options.onWorkerFailure?.(error);
      }
    };
    worker.onmessageerror = () => {
      this.options.onWorkerFailure?.(new Error('Search worker returned an unreadable message.'));
    };
    return worker;
  }

  async rebuild(inputs: readonly SearchInput[], onProgress?: (indexed: number, total: number) => void): Promise<SearchStats> {
    await this.call({ kind: 'clear' });
    const batchSize = 100;
    let indexed = 0;
    for (let start = 0; start < inputs.length; start += batchSize) {
      const batch = inputs.slice(start, start + batchSize);
      await this.call({ kind: 'upsertBatch', inputs: [...batch] });
      indexed += batch.length;
      onProgress?.(indexed, inputs.length);
    }
    return this.stats();
  }

  async upsert(input: SearchInput): Promise<void> {
    await this.call({ kind: 'upsertBatch', inputs: [input] });
  }

  async remove(entryIds: readonly EntryId[]): Promise<void> {
    if (!entryIds.length) return;
    await this.call({ kind: 'removeBatch', entryIds: [...entryIds] });
  }

  async updateMetadata(updates: readonly SearchMetadataUpdate[]): Promise<void> {
    if (!updates.length) return;
    await this.call({ kind: 'metadataBatch', updates: [...updates] });
  }

  async search(query: string, limit = 100): Promise<SearchResult[]> {
    return await this.call({ kind: 'search', query, limit }) as SearchResult[];
  }

  async quickSwitch(query: string, recent: readonly EntryId[] = [], limit = 50): Promise<QuickSwitchResult[]> {
    return await this.call({ kind: 'quick', query, recent: [...recent], limit }) as QuickSwitchResult[];
  }

  async facets(): Promise<SearchFacets> {
    return await this.call({ kind: 'facets' }) as SearchFacets;
  }

  async stats(): Promise<SearchStats> {
    return await this.call({ kind: 'stats' }) as SearchStats;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(new Error('Search index closed.'));
    this.pending.clear();
  }

  private call(request: SearchWorkerCommand): Promise<SearchWorkerValue> {
    if (this.closed) return Promise.reject(new Error('Search index is closed.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...request, id } as SearchWorkerRequest);
    });
  }
}
