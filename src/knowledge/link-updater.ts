import type { Entry, EntryId } from '../domain/model.js';
import type { FileRepository } from '../services/ports.js';
import { parseWikiReferences } from './parser.js';
import { canonicalWikiNote, resolveWikiTarget } from './resolver.js';
import type { KnowledgeRecord } from './types.js';
import type { KnowledgeIndexService } from './index-service.js';

function replacementFor(reference: ReturnType<typeof parseWikiReferences>[number], note: string, displayAlias: string | null): string {
  const fragment = reference.block ? `#^${reference.block}` : reference.heading ? `#${reference.heading}` : '';
  const alias = displayAlias ? `|${displayAlias}` : '';
  return `${reference.embed ? '!' : ''}[[${note}${fragment}${alias}]]`;
}

export function rewriteInboundReferences(
  text: string,
  sourceEntryId: EntryId,
  targetEntryId: EntryId,
  oldEntries: readonly Entry[],
  newEntries: readonly Entry[],
  oldRecords: readonly KnowledgeRecord[],
): string {
  const links = parseWikiReferences(text);
  const canonical = canonicalWikiNote(targetEntryId, newEntries);
  if (!canonical) return text;
  const targetRecord = oldRecords.find(record => record.entryId === targetEntryId);
  const aliasKeys = new Set((targetRecord?.aliases ?? []).map(alias => alias.normalize('NFC').toLocaleLowerCase()));
  const replacements: Array<{ from: number; to: number; text: string }> = [];
  for (const reference of links) {
    if (!reference.note) continue;
    const resolution = resolveWikiTarget(reference.note, sourceEntryId, oldEntries, oldRecords, { heading: reference.heading, block: reference.block });
    if (resolution.status === 'resolved' && resolution.entryId === targetEntryId) {
      const implicitAlias = !reference.alias && aliasKeys.has(reference.note.normalize('NFC').toLocaleLowerCase()) ? reference.note : null;
      replacements.push({ from: reference.from, to: reference.to, text: replacementFor(reference, canonical, reference.alias ?? implicitAlias) });
    }
  }
  let updated = text;
  for (const item of replacements.sort((a, b) => b.from - a.from)) {
    updated = updated.slice(0, item.from) + item.text + updated.slice(item.to);
  }
  return updated;
}

export async function updateInboundLinksAfterMove(input: {
  targetEntryId: EntryId;
  oldEntries: readonly Entry[];
  newEntries: readonly Entry[];
  oldRecords: readonly KnowledgeRecord[];
  repository: Pick<FileRepository, 'read' | 'saveMarkdown'>;
  index: KnowledgeIndexService;
}): Promise<number> {
  let changed = 0;
  for (const entry of input.newEntries.filter(item => item.kind === 'markdown' && item.deletedAt === null)) {
    const file = await input.repository.read(entry.id);
    if (!file.content) continue;
    const rewritten = rewriteInboundReferences(file.content.text, entry.id, input.targetEntryId, input.oldEntries, input.newEntries, input.oldRecords);
    if (rewritten === file.content.text) continue;
    const saved = await input.repository.saveMarkdown(entry.id, rewritten, file.entry.localVersion);
    await input.index.upsert(saved, rewritten);
    changed++;
  }
  return changed;
}
