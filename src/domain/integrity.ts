import { VaultError } from './errors.js';
import type { Entry, MarkdownContent } from './model.js';

export function assertVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new VaultError('INVALID_VERSION', 'The local file version is invalid. No content was overwritten.');
}
export function nextVersion(value: number): number {
  assertVersion(value);
  if (value === Number.MAX_SAFE_INTEGER) throw new VaultError('INVALID_VERSION', 'The local version limit was reached. Export a recovery backup.');
  return value + 1;
}
export function assertMarkdownContent(entry: Entry, content: MarkdownContent | undefined): asserts content is MarkdownContent {
  assertVersion(entry.localVersion);
  if (!content || content.entryId !== entry.id || typeof content.text !== 'string' || content.localVersion !== entry.localVersion) {
    throw new VaultError('CORRUPT', 'The saved Markdown and its metadata are inconsistent. Nothing was overwritten. Export a recovery backup.');
  }
}
