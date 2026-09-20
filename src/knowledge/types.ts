import type { EntryId, VaultId } from '../domain/model.js';

export interface WikiReference {
  raw: string;
  from: number;
  to: number;
  innerFrom: number;
  innerTo: number;
  aliasFrom: number | null;
  pipeFrom: number | null;
  embed: boolean;
  targetText: string;
  note: string;
  heading: string | null;
  block: string | null;
  alias: string | null;
}

export interface KnowledgeHeading {
  depth: number;
  text: string;
  from: number;
  to: number;
  lineFrom: number;
  lineTo: number;
}

export interface KnowledgeBlock {
  id: string;
  from: number;
  to: number;
}

export interface KnowledgeRecord {
  entryId: EntryId;
  vaultId: VaultId;
  localVersion: number;
  aliases: string[];
  headings: KnowledgeHeading[];
  blocks: KnowledgeBlock[];
  links: WikiReference[];
  /** Same length as source; ignored/link ranges are spaces so offsets stay source-stable. */
  searchText: string;
}

export interface WikiSuggestion {
  label: string;
  insert: string;
  detail: string;
  boost: number;
}

export type WikiResolution =
  | { status: 'resolved'; entryId: EntryId; heading: string | null; block: string | null }
  | { status: 'ambiguous'; entryIds: EntryId[] }
  | { status: 'unresolved' };

export interface BacklinkMention {
  sourceEntryId: EntryId;
  reference: WikiReference;
}

export interface UnlinkedMention {
  sourceEntryId: EntryId;
  from: number;
  to: number;
  term: string;
}
