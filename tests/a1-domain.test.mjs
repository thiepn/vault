import test from 'node:test';
import assert from 'node:assert/strict';
import {
  asCanonicalId,
  asLocalDate,
  assertCanonicalEntity,
  assertProjectHierarchy,
  assertUniqueCanonicalIds,
  canonicalIdFromEntry,
  isUuidV7,
  newCanonicalId,
  normalizeTagName,
} from '../build/core/domain/canonical.js';

const now = '2026-09-22T02:30:00.000Z';

function base(entityType, id) {
  return {
    id,
    entityType,
    schemaVersion: 1,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    properties: {},
  };
}

test('A1 generates offline UUIDv7 identities and preserves legacy EntryId bytes', () => {
  const noteId = newCanonicalId('note');
  assert.equal(isUuidV7(noteId), true);

  const existingEntryId = crypto.randomUUID();
  const bridged = canonicalIdFromEntry('note', existingEntryId);
  assert.equal(bridged, existingEntryId);

  const typedAgain = asCanonicalId('note', existingEntryId);
  assert.equal(typedAgain, existingEntryId);
});

test('A1 validates daily notes as Notes with semantic dailyDate', () => {
  const vaultId = newCanonicalId('vault');
  const daily = {
    ...base('note', newCanonicalId('note')),
    vaultId,
    title: '2026-09-22',
    body: '# Daily',
    folderId: null,
    aliases: [],
    noteKind: 'daily',
    dailyDate: asLocalDate('2026-09-22'),
  };

  assert.doesNotThrow(() => assertCanonicalEntity(daily));

  assert.throws(() => assertCanonicalEntity({
    ...daily,
    noteKind: 'standard',
  }), /Only daily notes/);
});

test('A1 keeps scheduledAt and dueAt independent and enforces explicit completion', () => {
  const task = {
    ...base('task', newCanonicalId('task')),
    vaultId: newCanonicalId('vault'),
    title: 'Prepare exam',
    status: 'open',
    scheduledAt: '2026-09-24',
    dueAt: '2026-09-27',
    completedAt: null,
    priority: 'high',
    projectId: null,
    parentTaskId: null,
    sourceNoteId: null,
    sourceBlockId: null,
    recurrenceRule: null,
  };

  assert.doesNotThrow(() => assertCanonicalEntity(task));

  assert.throws(() => assertCanonicalEntity({
    ...task,
    status: 'completed',
  }), /completedAt/);

  assert.doesNotThrow(() => assertCanonicalEntity({
    ...task,
    status: 'completed',
    completedAt: now,
  }));
});

test('A1 supports unresolved links without inventing a target entity', () => {
  const link = {
    ...base('link', newCanonicalId('link')),
    vaultId: newCanonicalId('vault'),
    source: {
      entityType: 'note',
      entityId: newCanonicalId('note'),
    },
    target: {
      kind: 'unresolved',
      requestedTargetText: 'Future Research Idea',
    },
    relation: 'reference',
    sourceBlockId: null,
  };

  assert.doesNotThrow(() => assertCanonicalEntity(link));
  assert.throws(() => assertCanonicalEntity({
    ...link,
    target: { kind: 'unresolved', requestedTargetText: '   ' },
  }), /must not be empty/);
});

test('A1 enforces globally unique canonical IDs across entity types', () => {
  const shared = newCanonicalId('note');
  const note = {
    ...base('note', shared),
    vaultId: newCanonicalId('vault'),
    title: 'A',
    body: '',
    folderId: null,
    aliases: [],
    noteKind: 'standard',
  };
  const task = {
    ...base('task', asCanonicalId('task', shared)),
    vaultId: note.vaultId,
    title: 'B',
    status: 'open',
    scheduledAt: null,
    dueAt: null,
    completedAt: null,
    priority: null,
    projectId: null,
    parentTaskId: null,
    sourceNoteId: null,
    sourceBlockId: null,
    recurrenceRule: null,
  };

  assert.throws(() => assertUniqueCanonicalIds([note, task]), /globally unique/);
});

test('A1 rejects indirect project-parent cycles while tolerating missing external parents', () => {
  const vaultId = newCanonicalId('vault');
  const aId = newCanonicalId('project');
  const bId = newCanonicalId('project');

  const a = {
    ...base('project', aId),
    vaultId,
    title: 'A',
    status: 'active',
    description: null,
    startDate: null,
    targetDate: null,
    completedAt: null,
    parentProjectId: bId,
    noteId: null,
  };
  const b = {
    ...base('project', bId),
    vaultId,
    title: 'B',
    status: 'active',
    description: null,
    startDate: null,
    targetDate: null,
    completedAt: null,
    parentProjectId: aId,
    noteId: null,
  };

  assert.throws(() => assertProjectHierarchy([a, b]), /cycle/);

  const orphanParent = newCanonicalId('project');
  assert.doesNotThrow(() => assertProjectHierarchy([{ ...a, parentProjectId: orphanParent }]));
});

test('A1 collection mode is explicit and tag normalization is deterministic', () => {
  const collection = {
    ...base('collection', newCanonicalId('collection')),
    vaultId: newCanonicalId('vault'),
    title: 'Active Projects',
    mode: 'dynamic',
    query: 'type:project status:active',
    explicitEntities: [],
    sort: null,
    group: null,
  };

  assert.doesNotThrow(() => assertCanonicalEntity(collection));
  assert.throws(() => assertCanonicalEntity({ ...collection, query: '  ' }), /require a query/);

  assert.equal(normalizeTagName('  #Language/French  '), 'language/french');
  assert.throws(() => normalizeTagName('two words'), /whitespace/);
});

test('A1 attachment identity is independent of filename and validates checksum metadata', () => {
  const attachment = {
    ...base('attachment', newCanonicalId('attachment')),
    vaultId: newCanonicalId('vault'),
    filename: 'image.png',
    mediaType: 'image/png',
    size: 1234,
    checksumSha256: 'a'.repeat(64),
    originalFilename: 'camera.png',
    width: 1200,
    height: 800,
    durationSeconds: null,
  };

  assert.doesNotThrow(() => assertCanonicalEntity(attachment));
  const renamed = { ...attachment, filename: 'renamed.png' };
  assert.equal(renamed.id, attachment.id);
  assert.doesNotThrow(() => assertCanonicalEntity(renamed));
});
