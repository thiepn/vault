import type { Entry, EntryId } from '../domain/model.js';
import type { FileRepository } from '../services/ports.js';
import { parseWikiReferences } from '../knowledge/parser.js';
import type { KnowledgeIndexService } from '../knowledge/index-service.js';
import { canonicalAttachmentTarget, resolveAttachmentTarget } from './attachments.js';

function replacementFor(reference: ReturnType<typeof parseWikiReferences>[number], target: string): string {
  const alias = reference.alias ? `|${reference.alias}` : '';
  return `${reference.embed ? '!' : ''}[[${target}${alias}]]`;
}

export function rewriteAttachmentReferences(
  text: string,
  sourceEntryId: EntryId,
  targetEntryId: EntryId,
  oldEntries: readonly Entry[],
  newEntries: readonly Entry[],
): string {
  const canonical = canonicalAttachmentTarget(targetEntryId, newEntries);
  if (!canonical) return text;
  const replacements: Array<{ from: number; to: number; text: string }> = [];
  for (const reference of parseWikiReferences(text)) {
    if (!reference.note || reference.heading || reference.block) continue;
    const resolution = resolveAttachmentTarget(reference.note, sourceEntryId, oldEntries);
    if (resolution.status === 'resolved' && resolution.entryId === targetEntryId) {
      replacements.push({
        from: reference.from,
        to: reference.to,
        text: replacementFor(reference, canonical),
      });
    }
  }
  let updated = text;
  for (const item of replacements.sort((a, b) => b.from - a.from)) {
    updated = updated.slice(0, item.from) + item.text + updated.slice(item.to);
  }
  return updated;
}

export async function updateAttachmentLinksAfterMove(input: {
  targetEntryId: EntryId;
  oldEntries: readonly Entry[];
  newEntries: readonly Entry[];
  repository: Pick<FileRepository, 'read' | 'saveMarkdown'>;
  index: KnowledgeIndexService;
}): Promise<number> {
  let changed = 0;
  for (const entry of input.newEntries.filter(item => item.kind === 'markdown' && item.deletedAt === null)) {
    const file = await input.repository.read(entry.id);
    if (!file.content) continue;
    const rewritten = rewriteAttachmentReferences(
      file.content.text,
      entry.id,
      input.targetEntryId,
      input.oldEntries,
      input.newEntries,
    );
    if (rewritten === file.content.text) continue;
    const saved = await input.repository.saveMarkdown(entry.id, rewritten, file.entry.localVersion);
    await input.index.upsert(saved, rewritten);
    changed++;
  }
  return changed;
}
