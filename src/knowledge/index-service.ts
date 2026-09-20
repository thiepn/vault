import type { Entry, EntryId, VaultId } from '../domain/model.js';
import type { FileRepository } from '../services/ports.js';
import { storageDriver, type LocalStorageDriver } from '../storage/driver.js';
import { parseKnowledge } from './parser.js';
import { resolveWikiTarget, wikiSuggestions } from './resolver.js';
import type { BacklinkMention, KnowledgeRecord, UnlinkedMention, WikiReference, WikiResolution, WikiSuggestion } from './types.js';

const stem = (name: string): string => name.replace(/\.md$/iu, '');
function wordish(character: string | undefined): boolean {
  return !!character && /[\p{L}\p{N}_]/u.test(character);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^\x24{}()|[\]\\]/g, '\\function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^\x24{}()|[\]\\]/g, '\\function wordish(character: string | undefined): boolean {
  return !!character && /[\p{L}\p{N}_]/u.test(character);
}');
}');
}

export class KnowledgeIndexService {
  private readonly driver: LocalStorageDriver;
  private cache = new Map<EntryId, KnowledgeRecord>();

  constructor(database: IDBDatabase | LocalStorageDriver) {
    this.driver = storageDriver(database);
  }

  records(): KnowledgeRecord[] {
    return [...this.cache.values()];
  }

  get(entryId: EntryId): KnowledgeRecord | undefined {
    return this.cache.get(entryId);
  }

  async loadVault(vaultId: VaultId, activeEntries: readonly Entry[]): Promise<void> {
    const activeIds = new Set(activeEntries.filter(entry => entry.kind === 'markdown' && entry.deletedAt === null).map(entry => entry.id));
    const stored = await this.driver.transaction(['knowledge'], 'readonly', tx => tx.store('knowledge').allFromIndex<KnowledgeRecord>('vaultId', vaultId));
    this.cache = new Map(stored.filter(record => activeIds.has(record.entryId)).map(record => [record.entryId, record]));
  }

  async ensureVault(entries: readonly Entry[], repository: Pick<FileRepository, 'read'>): Promise<void> {
    const markdown = entries.filter(entry => entry.kind === 'markdown' && entry.deletedAt === null);
    const activeIds = new Set(markdown.map(entry => entry.id));
    for (const entryId of [...this.cache.keys()]) if (!activeIds.has(entryId)) this.cache.delete(entryId);
    for (let index = 0; index < markdown.length; index++) {
      const entry = markdown[index]!;
      const current = this.cache.get(entry.id);
      if (!current || current.localVersion !== entry.localVersion) {
        const file = await repository.read(entry.id);
        if (file.content) await this.upsert(entry, file.content.text);
      }
      if (index > 0 && index % 25 === 0) await Promise.resolve();
    }
  }

  async upsert(entry: Entry, text: string): Promise<KnowledgeRecord> {
    const record = parseKnowledge({ entryId: entry.id, vaultId: entry.vaultId, localVersion: entry.localVersion, text });
    await this.driver.transaction(['knowledge'], 'readwrite', tx => tx.store('knowledge').put(record));
    this.cache.set(entry.id, record);
    return record;
  }

  resolve(reference: Pick<WikiReference, 'note' | 'heading' | 'block'>, currentEntryId: EntryId, entries: readonly Entry[]): WikiResolution {
    return resolveWikiTarget(reference.note, currentEntryId, entries, this.records(), { heading: reference.heading, block: reference.block });
  }

  resolveRaw(targetText: string, currentEntryId: EntryId, entries: readonly Entry[]): WikiResolution {
    const hash = targetText.indexOf('#');
    const note = (hash >= 0 ? targetText.slice(0, hash) : targetText).trim();
    const fragment = hash >= 0 ? targetText.slice(hash + 1).trim() : '';
    return resolveWikiTarget(note, currentEntryId, entries, this.records(), {
      heading: fragment && !fragment.startsWith('^') ? fragment : null,
      block: fragment.startsWith('^') ? fragment.slice(1) || null : null,
    });
  }

  suggestions(query: string, currentEntryId: EntryId, entries: readonly Entry[]): WikiSuggestion[] {
    return wikiSuggestions(query, currentEntryId, entries, this.records());
  }

  backlinks(targetEntryId: EntryId, entries: readonly Entry[]): BacklinkMention[] {
    const mentions: BacklinkMention[] = [];
    for (const record of this.cache.values()) {
      for (const reference of record.links) {
        const resolution = this.resolve(reference, record.entryId, entries);
        if (resolution.status === 'resolved' && resolution.entryId === targetEntryId) {
          mentions.push({ sourceEntryId: record.entryId, reference });
        }
      }
    }
    return mentions;
  }

  unlinkedMentions(targetEntryId: EntryId, entries: readonly Entry[]): UnlinkedMention[] {
    const target = entries.find(entry => entry.id === targetEntryId && entry.kind === 'markdown' && entry.deletedAt === null);
    if (!target) return [];
    const targetRecord = this.cache.get(targetEntryId);
    const terms = [...new Set([stem(target.name), ...(targetRecord?.aliases ?? [])].map(item => item.trim()).filter(item => item.length >= 2))]
      .sort((a, b) => b.length - a.length);
    const results: UnlinkedMention[] = [];

    for (const record of this.cache.values()) {
      if (record.entryId === targetEntryId) continue;
      const candidates: UnlinkedMention[] = [];
      for (const term of terms) {
        const regex = new RegExp(escapeRegExp(term), 'giu');
        for (const match of record.searchText.matchAll(regex)) {
          const from = match.index ?? -1;
          if (from < 0) continue;
          const to = from + match[0].length;
          if (!wordish(record.searchText[from - 1]) && !wordish(record.searchText[to])) {
            candidates.push({ sourceEntryId: record.entryId, from, to, term: record.searchText.slice(from, to) });
          }
        }
      }
      candidates.sort((a, b) => a.from - b.from || (b.to - b.from) - (a.to - a.from));
      let coveredUntil = -1;
      for (const mention of candidates) {
        if (mention.from < coveredUntil) continue;
        results.push(mention);
        coveredUntil = mention.to;
      }
    }
    return results.sort((a, b) => a.sourceEntryId.localeCompare(b.sourceEntryId) || a.from - b.from || b.to - a.to);
  }
}
