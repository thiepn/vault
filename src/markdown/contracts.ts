import type { EntryId } from '../domain/model.js';
export const INDEX_VERSION = 1;
export interface SourceRange { from: number; to: number }
export interface ParsedNote {
  entryId: EntryId;
  localVersion: number;
  parserVersion: number;
  properties: Record<string, unknown>;
  headings: { depth: number; text: string; range: SourceRange }[];
  links: { target: string; embed: boolean; range: SourceRange }[];
  tasks: { checked: boolean; text: string; range: SourceRange }[];
  tags: string[];
  diagnostics: { message: string; range?: SourceRange }[];
}
export interface MarkdownParser { parse(input: { entryId: EntryId; text: string; localVersion: number }): Promise<ParsedNote> }
export type IndexWorkerRequest =
  | { id: string; kind: 'upsert'; entryId: EntryId; text: string; localVersion: number }
  | { id: string; kind: 'remove'; entryId: EntryId }
  | { id: string; kind: 'search'; query: string; limit: number }
  | { id: string; kind: 'reset'; indexVersion: number };
export type IndexWorkerResponse =
  | { id: string; kind: 'indexed'; entryId: EntryId; localVersion: number }
  | { id: string; kind: 'results'; entries: { entryId: EntryId; range: SourceRange }[] }
  | { id: string; kind: 'error'; code: 'INVALID_REQUEST' | 'PARSER_ERROR' | 'INDEX_VERSION'; message: string };
/** Parser implementation is intentionally Phase 2/3. No regex "Markdown engine" is substituted. */
