import { VaultError } from './errors.js';
import type { Entry, EntryId } from './model.js';
import { validateName } from './paths.js';

/** One immutable metadata snapshot, shared lookup maps, no recursive vault scans. */
export class VaultTree {
  readonly byId = new Map<EntryId, Entry>();
  readonly children = new Map<EntryId | null, Entry[]>();
  private readonly paths = new Map<EntryId, string>();
  constructor(entries: readonly Entry[]) {
    for (const entry of entries) {
      if (this.byId.has(entry.id)) throw new VaultError('CORRUPT', 'Duplicate file identity in the vault. Export a recovery backup.');
      this.byId.set(entry.id, entry);
      const siblings = this.children.get(entry.parentId) ?? [];
      siblings.push(entry); this.children.set(entry.parentId, siblings);
    }
  }
  path(id: EntryId): string {
    const cached = this.paths.get(id); if (cached !== undefined) return cached;
    const entry = this.byId.get(id);
    if (!entry) throw new VaultError('NOT_FOUND', 'The file no longer exists.');
    const trail: Entry[] = []; const visited = new Set<EntryId>(); let current: Entry = entry;
    // Always validate the full ancestry. A cached path must never bypass the depth limit.
    while (true) {
      if (visited.has(current.id) || visited.size >= 256) throw new VaultError('CYCLE', 'The folder hierarchy is cyclic or too deep.');
      visited.add(current.id);
      if (current.vaultId !== entry.vaultId) throw new VaultError('INVALID_PARENT', 'A folder crosses vault boundaries.');
      if (validateName(current.name) !== current.name) throw new VaultError('CORRUPT', 'A saved filename is not normalized.');
      trail.push(current);
      if (!current.parentId) break;
      const parent = this.byId.get(current.parentId);
      if (!parent || parent.kind !== 'directory') throw new VaultError('INVALID_PARENT', 'A parent folder is missing.');
      if (entry.deletedAt === null && parent.deletedAt !== null) throw new VaultError('INVALID_PARENT', 'An active file has a deleted ancestor.');
      current = parent;
    }
    const path = trail.reverse().map(item => item.name).join('/');
    this.paths.set(id, path); return path;
  }
  descendants(id: EntryId, include: (entry: Entry) => boolean = () => true): Entry[] {
    if (!this.byId.has(id)) throw new VaultError('NOT_FOUND', 'The file no longer exists.');
    const queue: EntryId[] = [id]; const visited = new Set<EntryId>(queue); const result: Entry[] = [];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      for (const child of this.children.get(queue[cursor]!) ?? []) {
        if (!include(child)) continue;
        if (visited.has(child.id)) throw new VaultError('CYCLE', 'The folder hierarchy is cyclic.');
        visited.add(child.id); result.push(child); queue.push(child.id);
      }
    }
    return result;
  }
}
