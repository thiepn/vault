import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKnowledge } from '../build/core/knowledge/parser.js';
import { parseSearchQuery } from '../build/core/search/query.js';
import { SearchEngine } from '../build/core/search/engine.js';

const vaultId = '11111111-1111-4111-8111-111111111111';

function input(entryId, title, path, text, version = 1) {
  return {
    entryId,
    vaultId,
    localVersion: version,
    title,
    path,
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-20T12:00:00.000Z',
    text,
  };
}

test('Phase 4 parser derives properties, nested tags, tasks and UTF-16-stable body offsets', () => {
  const source = [
    '---',
    'aliases: [Analysis Two]',
    'tags: [math, university/analysis]',
    'status: active',
    'rating: 5',
    'published: false',
    '---',
    '# Continuity',
    '😀 Uniform continuity #analysis/continuity',
    '- [ ] Prove Heine theorem',
    '- [x] Read chapter',
  ].join('\n');
  const record = parseKnowledge({ entryId: 'analysis', vaultId, localVersion: 1, text: source });

  assert.equal(record.indexVersion, 4);
  assert.deepEqual(record.aliases, ['Analysis Two']);
  assert.deepEqual(record.tags.sort(), ['analysis/continuity', 'math', 'university/analysis'].sort());
  assert.equal(record.properties.status, 'active');
  assert.equal(record.properties.rating, 5);
  assert.equal(record.properties.published, false);
  assert.deepEqual(record.tasks.map(task => [task.completed, task.text]), [
    [false, 'Prove Heine theorem'],
    [true, 'Read chapter'],
  ]);
  assert.equal(record.bodyText.length, source.length);
  assert.equal(record.bodyText.indexOf('Uniform'), source.indexOf('Uniform'));
  assert.equal(record.searchText.indexOf('Uniform'), source.indexOf('Uniform'));
});

test('search query parser supports boolean logic, phrases and structured filters', () => {
  const ast = parseSearchQuery('("uniform continuity" OR compactness) AND tag:#math -tag:#archive property:rating>=4 task:open');
  assert.ok(ast);
  assert.equal(ast.kind, 'and');
  assert.throws(() => parseSearchQuery('"unterminated'));
});

test('search engine indexes full text, aliases, tags, properties, tasks, paths and filenames', () => {
  const engine = new SearchEngine();
  engine.upsertInput(input('analysis', 'Analysis.md', 'University/Analysis.md', [
    '---',
    'aliases: [Analysis Two]',
    'tags: [math, university/analysis]',
    'status: active',
    'rating: 5',
    '---',
    '# Uniform Continuity',
    'The Heine theorem characterizes uniform continuity.',
    '- [ ] Prove the theorem',
  ].join('\n')));
  engine.upsertInput(input('archive', 'Old Analysis.md', 'Archive/Old Analysis.md', [
    '---',
    'tags: [math, archive]',
    'status: archived',
    'rating: 2',
    '---',
    '# Compactness',
    'Historical notes about continuity.',
    '- [x] Review old proof',
  ].join('\n')));
  engine.upsertInput(input('french', 'French.md', 'Languages/French.md', '# Vocabulary\nbonjour monde #language'));

  assert.deepEqual(engine.search('uniform continuity').map(result => result.entryId), ['analysis']);
  assert.deepEqual(engine.search('"uniform continuity"').map(result => result.entryId), ['analysis']);
  assert.deepEqual(engine.search('tag:#math -tag:#archive').map(result => result.entryId), ['analysis']);
  assert.deepEqual(engine.search('tag:#university').map(result => result.entryId), ['analysis']);
  assert.deepEqual(engine.search('property:status=active').map(result => result.entryId), ['analysis']);
  assert.deepEqual(engine.search('property:rating>=4').map(result => result.entryId), ['analysis']);
  assert.deepEqual(engine.search('task:open').map(result => result.entryId), ['analysis']);
  assert.deepEqual(engine.search('path:University file:Analysis').map(result => result.entryId), ['analysis']);
  assert.deepEqual(engine.search('compactness OR bonjour').map(result => result.entryId).sort(), ['archive', 'french']);
  assert.deepEqual(engine.search('continuity NOT path:Archive').map(result => result.entryId), ['analysis']);

  const alias = engine.search('Analysis Two');
  assert.equal(alias[0]?.entryId, 'analysis');
  assert.ok(alias[0]?.score > 0);
  assert.ok(alias[0]?.snippet.includes('Heine') || alias[0]?.matches.some(match => match.field === 'alias'));

  const facets = engine.facets();
  assert.deepEqual(facets.tags.find(tag => tag.tag === 'math'), { tag: 'math', count: 2 });
  assert.deepEqual(facets.tags.find(tag => tag.tag === 'university'), { tag: 'university', count: 1 });
  assert.deepEqual(facets.properties.find(property => property.name === 'status'), { name: 'status', count: 2 });
});

test('quick switcher ranks exact titles, aliases and recency and supports incremental mutation', () => {
  const engine = new SearchEngine();
  engine.upsertInput(input('a', 'Newton.md', 'Physics/Newton.md', '---\naliases: [Isaac]\n---\n# Newton'));
  engine.upsertInput(input('b', 'New Testament.md', 'Bible/New Testament.md', '# New Testament'));

  assert.equal(engine.quickSwitch('Newton')[0]?.entryId, 'a');
  assert.equal(engine.quickSwitch('Isaac')[0]?.entryId, 'a');
  assert.equal(engine.quickSwitch('', ['b'])[0]?.entryId, 'b');

  engine.updateMetadata({
    entryId: 'a',
    title: 'Isaac Newton.md',
    path: 'Scientists/Isaac Newton.md',
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-20T13:00:00.000Z',
    localVersion: 2,
  });
  assert.equal(engine.search('path:Scientists')[0]?.entryId, 'a');

  engine.remove('a');
  assert.equal(engine.search('Newton').length, 0);
  assert.equal(engine.stats().documents, 1);
});

test('search results expose source offsets for navigation', () => {
  const engine = new SearchEngine();
  const text = '# Note\n😀 before target phrase after';
  engine.upsertInput(input('note', 'Note.md', 'Note.md', text));
  const result = engine.search('"target phrase"')[0];
  assert.ok(result);
  const body = result.matches.find(match => match.field === 'body');
  assert.equal(body?.from, text.indexOf('target phrase'));
  assert.equal(body?.to, text.indexOf('target phrase') + 'target phrase'.length);
});
