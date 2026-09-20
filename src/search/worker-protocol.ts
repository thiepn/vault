import type { EntryId } from '../domain/model.js';
import type { QuickSwitchResult, SearchFacets, SearchInput, SearchMetadataUpdate, SearchResult, SearchStats } from './types.js';

export type SearchWorkerRequest =
  | { id: number; kind: 'clear' }
  | { id: number; kind: 'upsertBatch'; inputs: SearchInput[] }
  | { id: number; kind: 'removeBatch'; entryIds: EntryId[] }
  | { id: number; kind: 'metadataBatch'; updates: SearchMetadataUpdate[] }
  | { id: number; kind: 'search'; query: string; limit: number }
  | { id: number; kind: 'quick'; query: string; recent: EntryId[]; limit: number }
  | { id: number; kind: 'facets' }
  | { id: number; kind: 'stats' };

export type SearchWorkerValue =
  | null
  | number
  | SearchResult[]
  | QuickSwitchResult[]
  | SearchFacets
  | SearchStats;

export type SearchWorkerResponse =
  | { id: number; ok: true; value: SearchWorkerValue }
  | { id: number; ok: false; error: string };
