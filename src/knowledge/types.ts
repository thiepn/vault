import type { EntryId, VaultId } from '../domain/model.js';
import type { TaskPriority } from '../tasks/markdown.js';

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

export type KnowledgeScalar = string | number | boolean | null;
export type KnowledgePropertyValue = KnowledgeScalar | KnowledgeScalar[];

export interface KnowledgeTask {
  raw: string;
  text: string;
  completed: boolean;
  from: number;
  to: number;
  due: string | null;
  scheduled: string | null;
  priority: TaskPriority | null;
  recurrence: string | null;
  completedOn: string | null;
}

export interface KnowledgeRecord {
  entryId: EntryId;
  vaultId: VaultId;
  localVersion: number;
  indexVersion: number;
  aliases: string[];
  tags: string[];
  properties: Record<string, KnowledgePropertyValue>;
  tasks: KnowledgeTask[];
  headings: KnowledgeHeading[];
  blocks: KnowledgeBlock[];
  links: WikiReference[];
  /** Same length as source; ignored/link ranges are spaces so offsets stay source-stable. */
  searchText: string;
  /** Same length as source; frontmatter is blanked but body/code/link text remains searchable. */
  bodyText: string;
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
