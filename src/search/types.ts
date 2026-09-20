import type { EntryId, VaultId } from '../domain/model.js';
import type { KnowledgeRecord } from '../knowledge/types.js';

export interface SearchInput {
  entryId: EntryId;
  vaultId: VaultId;
  localVersion: number;
  title: string;
  path: string;
  createdAt: string;
  updatedAt: string;
  text: string;
}

export interface SearchDocument {
  entryId: EntryId;
  vaultId: VaultId;
  localVersion: number;
  title: string;
  path: string;
  createdAt: string;
  updatedAt: string;
  knowledge: KnowledgeRecord;
}

export type SearchField = 'body' | 'title' | 'path' | 'alias' | 'heading' | 'tag' | 'property' | 'task';

export interface SearchMatch {
  field: SearchField;
  from: number | null;
  to: number | null;
  text: string;
}

export interface SearchResult {
  entryId: EntryId;
  title: string;
  path: string;
  score: number;
  snippet: string;
  matchCount: number;
  matches: SearchMatch[];
}

export interface QuickSwitchResult {
  entryId: EntryId;
  title: string;
  path: string;
  alias: string | null;
  score: number;
}

export interface TagFacet {
  tag: string;
  count: number;
}

export interface PropertyFacet {
  name: string;
  count: number;
}

export interface SearchFacets {
  tags: TagFacet[];
  properties: PropertyFacet[];
}

export interface SearchStats {
  documents: number;
  tokens: number;
  tags: number;
  properties: number;
}

export interface SearchMetadataUpdate {
  entryId: EntryId;
  title: string;
  path: string;
  createdAt: string;
  updatedAt: string;
  localVersion: number;
}
