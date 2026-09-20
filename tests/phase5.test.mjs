import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deleteFrontmatterProperty,
  inspectFrontmatter,
  renameFrontmatterProperty,
  setFrontmatterProperty,
  valueForKind,
} from '../build/core/metadata/frontmatter.js';
import { parseKnowledge } from '../build/core/knowledge/parser.js';
import { SearchEngine } from '../build/core/search/engine.js';

const vaultId = '11111111-1111-4111-8111-111111111111';

test('Phase 5 adds frontmatter without changing Markdown body', () => {
  const source = '# Note\n\nBody stays exact.\n';
  const next = setFrontmatterProperty(source, 'status', 'active');
  assert.match(next, /^---\nstatus: active\n---\n/u);
  assert.equal(next.slice(next.indexOf('# Note')), source);

  const view = inspectFrontmatter(next);
  assert.equal(view.status, 'valid');
  assert.deepEqual(view.properties.map(item => [item.name, item.kind, item.value]), [
    ['status', 'text', 'active'],
  ]);
});

test('Phase 5 preserves comments, property order and complex YAML while editing a simple value', () => {
  const source = [
    '---',
    '# document comment',
    'status: active # keep this',
    'rating: 5',
    'nested:',
    '  owner: Jonathan',
    'tags:',
    '  - math',
    '  - university/analysis',
    '---',
    '# Analysis',
    '',
    'Body.',
    '',
  ].join('\n');

  const next = setFrontmatterProperty(source, 'rating', 6);
  assert.match(next, /# document comment/u);
  assert.match(next, /status: active # keep this/u);
  assert.match(next, /rating: 6/u);
  assert.match(next, /nested:\n\s+owner: Jonathan/u);
  assert.ok(next.indexOf('status:') < next.indexOf('rating:'));
  assert.ok(next.indexOf('rating:') < next.indexOf('nested:'));
  assert.equal(next.slice(next.indexOf('# Analysis')), '# Analysis\n\nBody.\n');

  const view = inspectFrontmatter(next);
  assert.equal(view.properties.find(item => item.name === 'nested')?.kind, 'unsupported');
  assert.equal(view.properties.find(item => item.name === 'rating')?.kind, 'number');
  assert.equal(view.properties.find(item => item.name === 'tags')?.kind, 'tags');
});

test('rename/delete mutate only the requested frontmatter key', () => {
  const source = [
    '---',
    '# preserve before first key',
    'status: active',
    'rating: 5',
    '---',
    '# Note',
  ].join('\n');
  const renamed = renameFrontmatterProperty(source, 'status', 'state');
  assert.match(renamed, /state: active/u);
  assert.doesNotMatch(renamed, /status:/u);
  assert.match(renamed, /rating: 5/u);

  const deleted = deleteFrontmatterProperty(renamed, 'rating');
  assert.match(deleted, /# preserve before first key/u);
  assert.match(deleted, /state: active/u);
  assert.doesNotMatch(deleted, /rating:/u);
  assert.equal(deleted.endsWith('# Note'), true);
});

test('invalid or non-mapping YAML fails closed for visual editing', () => {
  const duplicate = ['---', 'status: a', 'status: b', '---', '# Note'].join('\n');
  assert.equal(inspectFrontmatter(duplicate).status, 'invalid');
  assert.throws(() => setFrontmatterProperty(duplicate, 'rating', 5), error => error?.code === 'CORRUPT');

  const sequence = ['---', '- one', '- two', '---', '# Note'].join('\n');
  assert.equal(inspectFrontmatter(sequence).status, 'unsupported-root');
  assert.throws(() => setFrontmatterProperty(sequence, 'rating', 5), error => error?.code === 'UNSUPPORTED');
});

test('typed property conversion validates numbers, dates, tags, lists and null', () => {
  assert.equal(valueForKind('number', '4.5'), 4.5);
  assert.equal(valueForKind('checkbox', '', true), true);
  assert.equal(valueForKind('date', '2026-09-21'), '2026-09-21');
  assert.deepEqual(valueForKind('tags', '#math, university/analysis'), ['math', 'university/analysis']);
  assert.deepEqual(valueForKind('list', 'one, two, three'), ['one', 'two', 'three']);
  assert.equal(valueForKind('null', ''), null);
  assert.throws(() => valueForKind('number', 'NaN'));
  assert.throws(() => valueForKind('date', '2026-02-30'));
});

test('CRLF notes keep CRLF frontmatter and exact body after property edits', () => {
  const source = '---\r\nstatus: active\r\n---\r\n# Note\r\n\r\nBody\r\n';
  const next = setFrontmatterProperty(source, 'status', 'review');
  assert.match(next, /^---\r\nstatus: review\r\n---\r\n/u);
  assert.equal(next.slice(next.indexOf('# Note')), '# Note\r\n\r\nBody\r\n');
});

test('visual frontmatter changes feed the shared knowledge/search parser', () => {
  let source = '# Analysis\n\nUniform continuity.';
  source = setFrontmatterProperty(source, 'status', 'active');
  source = setFrontmatterProperty(source, 'rating', 5);
  source = setFrontmatterProperty(source, 'tags', ['math', 'analysis/continuity']);
  source = setFrontmatterProperty(source, 'aliases', ['Analysis Two']);

  const record = parseKnowledge({ entryId: 'analysis', vaultId, localVersion: 1, text: source });
  assert.equal(record.properties.status, 'active');
  assert.equal(record.properties.rating, 5);
  assert.deepEqual(record.tags.sort(), ['analysis/continuity', 'math']);
  assert.deepEqual(record.aliases, ['Analysis Two']);

  const engine = new SearchEngine();
  engine.upsertInput({
    entryId: 'analysis',
    vaultId,
    localVersion: 1,
    title: 'Analysis.md',
    path: 'Analysis.md',
    createdAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:00:00.000Z',
    text: source,
  });
  assert.deepEqual(engine.search('property:status=active property:rating>=5 tag:#analysis').map(item => item.entryId), ['analysis']);
  assert.equal(engine.quickSwitch('Analysis Two')[0]?.entryId, 'analysis');
});
