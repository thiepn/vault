import type { Entry, EntryId } from '../domain/model.js';
import { VaultTree } from '../domain/tree.js';

export type FileSort = 'name-asc' | 'name-desc' | 'modified-desc' | 'modified-asc' | 'created-desc' | 'created-asc';

export interface TreePreferences {
  sort: FileSort;
  foldersFirst: boolean;
  collapsed: ReadonlySet<EntryId>;
  filter: string;
}

export interface TreeRow {
  entry: Entry;
  level: number;
  path: string;
  hasChildren: boolean;
  collapsed: boolean;
}

const compareText = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

export function compareEntries(a: Entry, b: Entry, sort: FileSort, foldersFirst: boolean): number {
  if (foldersFirst && (a.kind === 'directory') !== (b.kind === 'directory')) return a.kind === 'directory' ? -1 : 1;
  let result = 0;
  switch (sort) {
    case 'name-asc': result = compareText(a.name, b.name); break;
    case 'name-desc': result = compareText(b.name, a.name); break;
    case 'modified-desc': result = b.updatedAt.localeCompare(a.updatedAt); break;
    case 'modified-asc': result = a.updatedAt.localeCompare(b.updatedAt); break;
    case 'created-desc': result = b.createdAt.localeCompare(a.createdAt); break;
    case 'created-asc': result = a.createdAt.localeCompare(b.createdAt); break;
  }
  return result || compareText(a.name, b.name) || a.id.localeCompare(b.id);
}

export function treeRows(entries: readonly Entry[], preferences: TreePreferences): TreeRow[] {
  const active = entries.filter(entry => entry.deletedAt === null);
  const tree = new VaultTree(entries);
  const children = new Map<EntryId | null, Entry[]>();
  for (const entry of active) {
    const group = children.get(entry.parentId) ?? [];
    group.push(entry);
    children.set(entry.parentId, group);
  }
  for (const group of children.values()) group.sort((a, b) => compareEntries(a, b, preferences.sort, preferences.foldersFirst));

  const query = preferences.filter.trim().normalize('NFC').toLocaleLowerCase();
  const include = new Set<EntryId>();
  if (query) {
    for (const entry of active) {
      const path = tree.path(entry.id);
      if (!entry.name.toLocaleLowerCase().includes(query) && !path.toLocaleLowerCase().includes(query)) continue;
      let current: Entry | undefined = entry;
      const seen = new Set<EntryId>();
      while (current && !seen.has(current.id)) {
        seen.add(current.id); include.add(current.id);
        current = current.parentId ? tree.byId.get(current.parentId) : undefined;
      }
    }
  }

  const rows: TreeRow[] = [];
  const visited = new Set<EntryId>();
  const walk = (parentId: EntryId | null, level: number): void => {
    for (const entry of children.get(parentId) ?? []) {
      if (visited.has(entry.id)) continue;
      visited.add(entry.id);
      if (query && !include.has(entry.id)) continue;
      const childCount = (children.get(entry.id) ?? []).filter(child => !query || include.has(child.id)).length;
      const isCollapsed = !query && preferences.collapsed.has(entry.id);
      rows.push({ entry, level, path: tree.path(entry.id), hasChildren: childCount > 0, collapsed: isCollapsed });
      if (entry.kind === 'directory' && !isCollapsed) walk(entry.id, level + 1);
    }
  };
  walk(null, 0);
  return rows;
}

export function trashRows(entries: readonly Entry[], sort: FileSort): TreeRow[] {
  const tree = new VaultTree(entries);
  const deleted = entries.filter(entry => {
    if (entry.deletedAt === null) return false;
    if (!entry.parentId) return true;
    const parent = tree.byId.get(entry.parentId);
    return !parent || parent.deletedAt === null;
  });
  return deleted
    .slice()
    .sort((a, b) => compareEntries(a, b, sort, false))
    .map(entry => ({ entry, level: 0, path: tree.path(entry.id), hasChildren: false, collapsed: false }));
}

export function isFileSort(value: unknown): value is FileSort {
  return typeof value === 'string' && ['name-asc', 'name-desc', 'modified-desc', 'modified-asc', 'created-desc', 'created-asc'].includes(value);
}
