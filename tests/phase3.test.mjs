import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKnowledge, parseWikiReferences } from '../build/core/knowledge/parser.js';
import { resolveWikiTarget, wikiSuggestions } from '../build/core/knowledge/resolver.js';
import { rewriteInboundReferences } from '../build/core/knowledge/link-updater.js';
import { extractFragment } from '../build/core/knowledge/fragments.js';

const vaultId = '11111111-1111-4111-8111-111111111111';
const now = '2026-09-20T12:00:00.000Z';

function directory(id, name, parentId = null) {
  return { id, vaultId, parentId, name, kind: 'directory', createdAt: now, updatedAt: now, localVersion: 1, deletedAt: null, deletionBatch: null, activeKey: id };
}
function note(id, name, parentId = null, version = 1) {
  return { id, vaultId, parentId, name, kind: 'markdown', createdAt: now, updatedAt: now, localVersion: version, deletedAt: null, deletionBatch: null, activeKey: id };
}

test('knowledge parser extracts aliases, headings, blocks and Wiki references while ignoring code/comments', () => {
  const source = [
    '---',
    'aliases:',
    '  - Isaac',
    '  - "Sir Isaac Newton"',
    '---',
    '# Laws',
    'See [[Mechanics]] and ![[Quotes#^q]].',
    '',
    '`[[Inline ignored]]`',
    '<!-- [[Comment ignored]] -->',
    '```md',
    '[[Fence ignored]]',
    '```',
    'Second law is F=ma. ^law',
  ].join('\n');
  const record = parseKnowledge({ entryId: 'newton', vaultId, localVersion: 1, text: source });
  assert.deepEqual(record.aliases, ['Isaac', 'Sir Isaac Newton']);
  assert.deepEqual(record.headings.map(item => item.text), ['Laws']);
  assert.deepEqual(record.blocks.map(item => item.id), ['law']);
  assert.deepEqual(record.links.map(item => [item.targetText, item.embed, item.block]), [
    ['Mechanics', false, null],
    ['Quotes#^q', true, 'q'],
  ]);
  assert.equal(record.searchText.includes('Fence ignored'), false);
  assert.equal(record.searchText.includes('Comment ignored'), false);
});

test('multiline Wiki-looking syntax is not parsed as a link', () => {
  assert.equal(parseWikiReferences('[[one\ntwo]]').length, 0);
});

test('resolver handles aliases, current-note fragments and heading/block suggestions', () => {
  const entries = [
    note('newton', 'Newton.md'),
    note('mechanics', 'Mechanics.md'),
  ];
  const newtonText = ['---', 'aliases: [Isaac, "Sir Isaac Newton"]', '---', '# Laws', 'F=ma ^law'].join('\n');
  const records = [
    parseKnowledge({ entryId: 'newton', vaultId, localVersion: 1, text: newtonText }),
    parseKnowledge({ entryId: 'mechanics', vaultId, localVersion: 1, text: '# Mechanics' }),
  ];

  const alias = resolveWikiTarget('Isaac', 'mechanics', entries, records);
  assert.equal(alias.status, 'resolved');
  assert.equal(alias.entryId, 'newton');

  const current = resolveWikiTarget('', 'newton', entries, records, { heading: 'Laws', block: null });
  assert.deepEqual(current, { status: 'resolved', entryId: 'newton', heading: 'Laws', block: null });

  assert.ok(wikiSuggestions('Newt', 'mechanics', entries, records).some(item => item.insert === 'Newton'));
  assert.ok(wikiSuggestions('Newton#^la', 'mechanics', entries, records).some(item => item.insert === 'Newton#^law'));
});

test('resolver disambiguates duplicate titles with paths', () => {
  const entries = [
    directory('folder-a', 'A'),
    directory('folder-b', 'B'),
    note('idea-a', 'Ideas.md', 'folder-a'),
    note('idea-b', 'Ideas.md', 'folder-b'),
    note('home', 'Home.md'),
  ];
  const records = entries.filter(item => item.kind === 'markdown').map(item => parseKnowledge({ entryId: item.id, vaultId, localVersion: 1, text: '' }));
  assert.equal(resolveWikiTarget('Ideas', 'home', entries, records).status, 'ambiguous');
  const resolved = resolveWikiTarget('A/Ideas', 'home', entries, records);
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.entryId, 'idea-a');
});

test('automatic link rewriting preserves explicit and implicit aliases', () => {
  const oldEntries = [
    note('newton', 'Newton.md'),
    note('mechanics', 'Mechanics.md'),
  ];
  const newEntries = [
    note('newton', 'Isaac Newton.md', null, 2),
    note('mechanics', 'Mechanics.md'),
  ];
  const newtonText = ['---', 'aliases: [Isaac]', '---', '# Laws'].join('\n');
  const mechanics = 'See [[Isaac]] and [[Newton#Laws|the laws]].';
  const records = [
    parseKnowledge({ entryId: 'newton', vaultId, localVersion: 1, text: newtonText }),
    parseKnowledge({ entryId: 'mechanics', vaultId, localVersion: 1, text: mechanics }),
  ];
  assert.equal(
    rewriteInboundReferences(mechanics, 'mechanics', 'newton', oldEntries, newEntries, records),
    'See [[Isaac Newton|Isaac]] and [[Isaac Newton#Laws|the laws]].',
  );
});

test('heading and block fragments extract deterministic transclusion source', () => {
  const source = ['# First', 'A', '', '## Laws', 'F=ma ^law', '', '### Detail', 'More', '', '# Next', 'B'].join('\n');
  const record = parseKnowledge({ entryId: 'newton', vaultId, localVersion: 1, text: source });
  assert.equal(extractFragment(source, record, { heading: 'Laws', block: null }), '## Laws\nF=ma ^law\n\n### Detail\nMore');
  assert.equal(extractFragment(source, record, { heading: null, block: 'law' }), 'F=ma');
});
