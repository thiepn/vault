import { VaultError } from './errors.js';
import type { Entry, EntryId, VaultId } from './model.js';

/** Portable names are NFC-normalized; content bytes are never normalized. */
export function validateName(raw: string): string {
  const name = raw.normalize('NFC');
  if (!name || name !== name.trim() || name === '.' || name === '..'
    || /[\x00-\x1f\x7f/\\<>:"|?*]/u.test(name) || /[. ]$/u.test(name)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)
    || new TextEncoder().encode(name).length > 240) {
    throw new VaultError('INVALID_NAME', 'Use a name of 1–240 UTF-8 bytes without path separators, control characters or reserved filename characters.');
  }
  return name;
}

export function nameKey(name: string): string {
  // ASCII-only case folding is deliberately independent of browser/SQL locale.
  return name.normalize('NFC').replace(/[A-Z]/g, c => c.toLowerCase());
}

export function activeKey(vaultId: VaultId, parentId: EntryId | null, name: string): string {
  return `${vaultId}/${parentId ?? 'root'}/${nameKey(name)}`;
}

export function markdownName(raw: string): string {
  const name = validateName(raw);
  return validateName(/\.md$/iu.test(name) ? name : `${name}.md`);
}

export function resolvePath(entryId: EntryId, entries: readonly Entry[]): string {
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const parts: string[] = [];
  const seen = new Set<EntryId>();
  let current = byId.get(entryId);
  if (!current) throw new VaultError('NOT_FOUND', 'The file no longer exists.');
  const vaultId = current.vaultId;
  while (current) {
    if (seen.has(current.id) || seen.size >= 256) throw new VaultError('CYCLE', 'The folder hierarchy is invalid.');
    if (current.vaultId !== vaultId) throw new VaultError('INVALID_PARENT', 'A folder crosses vault boundaries.');
    seen.add(current.id);
    parts.unshift(current.name);
    if (!current.parentId) break;
    const parent: Entry | undefined = byId.get(current.parentId);
    if (!parent || parent.kind !== 'directory') throw new VaultError('INVALID_PARENT', 'A parent folder is missing.');
    current = parent;
  }
  return parts.join('/');
}
