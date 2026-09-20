import type { KnowledgeRecord } from './types.js';

const fold = (value: string): string => value.normalize('NFC').toLocaleLowerCase();

export function extractFragment(
  source: string,
  record: KnowledgeRecord | undefined,
  fragment: { heading: string | null; block: string | null },
): string | null {
  if (!fragment.heading && !fragment.block) return source;
  if (!record) return null;

  if (fragment.block) {
    const block = record.blocks.find(item => fold(item.id) === fold(fragment.block!));
    if (!block) return null;
    return source
      .slice(block.from, block.to)
      .replace(new RegExp(`(?:^|\\s+)\\^${escapeRegExp(block.id)}\\s*$`), '');
  }

  const heading = record.headings.find(item => fold(item.text) === fold(fragment.heading!));
  if (!heading) return null;
  const index = record.headings.indexOf(heading);
  const next = record.headings.slice(index + 1).find(item => item.depth <= heading.depth);
  return source.slice(heading.from, next?.from ?? source.length).trimEnd();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
