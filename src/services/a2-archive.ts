import { VaultError } from '../domain/errors.js';
import type { VaultSnapshot } from '../domain/model.js';
import { VaultTree } from '../domain/tree.js';
import type { NoteBodyRecord, StoredEntity } from '../storage/a2-persistence.js';
import { sha256Hex } from '../storage/blob-store.js';
import { vaultFiles, type ExportFile } from './export.js';

export interface VaultArchiveManifest {
  format: 'vault-archive';
  version: 1;
  exportedAt: string;
  vaultId: string;
  vaultName: string;
  entries: Array<{
    id: string;
    kind: string;
    path: string;
    revision: number;
    deletedAt: string | null;
  }>;
}

const encoder = new TextEncoder();
const jsonFile = (path: string, value: unknown): ExportFile => ({
  path,
  bytes: encoder.encode(JSON.stringify(value, null, 2)),
});

export async function fullVaultArchiveFiles(
  snapshot: VaultSnapshot,
  entities: readonly StoredEntity[],
  noteBodies: readonly NoteBodyRecord[],
): Promise<ExportFile[]> {
  const tree = new VaultTree(snapshot.entries);
  const files = vaultFiles(snapshot);
  const manifest: VaultArchiveManifest = {
    format: 'vault-archive',
    version: 1,
    exportedAt: new Date().toISOString(),
    vaultId: snapshot.vault.id,
    vaultName: snapshot.vault.name,
    entries: snapshot.entries.map(entry => ({
      id: entry.id,
      kind: entry.kind,
      path: tree.path(entry.id),
      revision: entry.localVersion,
      deletedAt: entry.deletedAt,
    })),
  };

  files.push(
    jsonFile('.vault/manifest.json', manifest),
    jsonFile('.vault/entities.json', entities),
    jsonFile('.vault/note-bodies.json', noteBodies),
    jsonFile('.vault/recovery-metadata.json', {
      format: snapshot.format,
      version: snapshot.version,
      exportedAt: snapshot.exportedAt,
      recoveryDrafts: snapshot.recoveryDrafts,
      revisions: snapshot.revisions ?? [],
    }),
  );

  const checksums: Record<string, string> = {};
  for (const file of files) {
    if (file.path.endsWith('/')) continue;
    checksums[file.path] = await sha256Hex(file.bytes);
  }
  files.push(jsonFile('.vault/checksums.json', checksums));
  return files;
}

export async function validateFullVaultArchiveFiles(files: readonly ExportFile[]): Promise<void> {
  const byPath = new Map(files.map(file => [file.path, file]));
  for (const required of [
    '.vault/manifest.json',
    '.vault/entities.json',
    '.vault/note-bodies.json',
    '.vault/checksums.json',
  ]) {
    if (!byPath.has(required)) throw new VaultError('CORRUPT', 'Vault archive is missing ' + required + '.');
  }

  let manifest: VaultArchiveManifest;
  let checksums: Record<string, string>;
  try {
    manifest = JSON.parse(new TextDecoder().decode(byPath.get('.vault/manifest.json')!.bytes)) as VaultArchiveManifest;
    checksums = JSON.parse(new TextDecoder().decode(byPath.get('.vault/checksums.json')!.bytes)) as Record<string, string>;
  } catch (error) {
    throw new VaultError('CORRUPT', 'Vault archive metadata is invalid JSON.', { cause: error });
  }
  if (manifest.format !== 'vault-archive' || manifest.version !== 1 || !manifest.vaultId) {
    throw new VaultError('CORRUPT', 'Vault archive manifest version is unsupported.');
  }

  for (const [path, expected] of Object.entries(checksums)) {
    const file = byPath.get(path);
    if (!file) throw new VaultError('CORRUPT', 'Vault archive checksum references a missing file.');
    const actual = await sha256Hex(file.bytes);
    if (actual !== expected) throw new VaultError('CORRUPT', 'Vault archive checksum mismatch for ' + path + '.');
  }
}
