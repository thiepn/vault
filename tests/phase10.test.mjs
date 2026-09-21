import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKnowledge } from '../build/core/knowledge/parser.js';
import {
  buildKnowledgeGraph,
  filterKnowledgeGraph,
  graphGroupKey,
  graphStats,
  localKnowledgeGraph,
  matchesPropertyFilter,
} from '../build/core/graph/model.js';

const vaultId = '11111111-1111-4111-8111-111111111111';
const now = '2026-09-22T00:00:00.000Z';

function entry(id, name, kind='markdown', parentId=null) {
  return {
    id, vaultId, parentId, name, kind,
    createdAt: now, updatedAt: now, localVersion: 1,
    deletedAt: null, deletionBatch: null, activeKey: id,
  };
}

function record(e, text) {
  return parseKnowledge({ entryId:e.id, vaultId, localVersion:e.localVersion, text });
}

test('Phase 10 builds weighted note/embed/attachment edges and marks true orphans', () => {
  const assets = entry('assets', 'Assets', 'directory');
  const a = entry('a', 'A.md');
  const b = entry('b', 'B.md');
  const c = entry('c', 'C.md');
  const orphan = entry('orphan', 'Orphan.md');
  const photo = entry('photo', 'photo.png', 'attachment', assets.id);
  const entries = [assets, a, b, c, orphan, photo];
  const records = [
    record(a, '[[B]] [[B]] ![[B]] ![[Assets/photo.png]] [[Missing]]'),
    record(b, '---\naliases: [Beta]\ntags: [project/math]\nstatus: active\n---\n# B'),
    record(c, '[[Beta]]'),
    record(orphan, '# Alone'),
  ];

  const graph = buildKnowledgeGraph(entries, records);
  const stats = graphStats(graph);
  assert.equal(stats.nodes, 5);
  assert.equal(stats.notes, 4);
  assert.equal(stats.attachments, 1);
  assert.equal(stats.references, 5);
  assert.equal(graph.unresolvedReferences, 1);
  assert.equal(graph.ambiguousReferences, 0);

  const link = graph.edges.find(edge => edge.source === a.id && edge.target === b.id && edge.kind === 'link');
  const embed = graph.edges.find(edge => edge.source === a.id && edge.target === b.id && edge.kind === 'embed');
  const attachment = graph.edges.find(edge => edge.source === a.id && edge.target === photo.id && edge.kind === 'attachment-embed');
  assert.equal(link?.weight, 2);
  assert.equal(embed?.weight, 1);
  assert.equal(attachment?.weight, 1);
  assert.equal(graph.nodes.find(node => node.id === orphan.id)?.orphan, true);
  assert.equal(graph.nodes.find(node => node.id === photo.id)?.orphan, false);
});

test('local graph uses undirected connection depth while preserving directed edges', () => {
  const a = entry('a', 'A.md');
  const b = entry('b', 'B.md');
  const c = entry('c', 'C.md');
  const d = entry('d', 'D.md');
  const entries = [a,b,c,d];
  const records = [
    record(a, '[[B]]'),
    record(b, '[[C]]'),
    record(c, ''),
    record(d, '[[C]]'),
  ];
  const graph = buildKnowledgeGraph(entries, records);
  assert.deepEqual(localKnowledgeGraph(graph, a.id, 1).nodes.map(node => node.id).sort(), ['a','b']);
  assert.deepEqual(localKnowledgeGraph(graph, a.id, 2).nodes.map(node => node.id).sort(), ['a','b','c']);
  assert.deepEqual(localKnowledgeGraph(graph, a.id, 3).nodes.map(node => node.id).sort(), ['a','b','c','d']);
  const depth2 = localKnowledgeGraph(graph, a.id, 2);
  assert.equal(depth2.edges.some(edge => edge.source === b.id && edge.target === c.id), true);
  assert.equal(depth2.edges.some(edge => edge.source === d.id), false);
});

test('graph filters support nested tags, properties, kinds, orphan discovery and search', () => {
  const project = entry('project', 'Project.md');
  const archive = entry('archive', 'Archive.md');
  const orphan = entry('orphan', 'Loose.md');
  const file = entry('file', 'diagram.png', 'attachment');
  const entries = [project,archive,orphan,file];
  const records = [
    record(project, '---\ntags: [project/math]\nstatus: active\nscore: 8\n---\n[[Archive]] ![[diagram.png]]'),
    record(archive, '---\ntags: [archive]\nstatus: done\n---'),
    record(orphan, '---\nstatus: active\n---\n# Loose'),
  ];
  const graph = buildKnowledgeGraph(entries, records);

  assert.deepEqual(filterKnowledgeGraph(graph, { tag:'#project' }).nodes.map(node => node.id), ['project']);
  assert.deepEqual(filterKnowledgeGraph(graph, { property:'status=active' }).nodes.map(node => node.id).sort(), ['orphan','project']);
  assert.deepEqual(filterKnowledgeGraph(graph, { property:'status!=active', kinds:['note'] }).nodes.map(node => node.id), ['archive']);
  assert.deepEqual(filterKnowledgeGraph(graph, { kinds:['attachment'] }).nodes.map(node => node.id), ['file']);
  assert.deepEqual(filterKnowledgeGraph(graph, { orphanOnly:true }).nodes.map(node => node.id), ['orphan']);
  assert.deepEqual(filterKnowledgeGraph(graph, { search:'math' }).nodes.map(node => node.id), ['project']);

  const node = graph.nodes.find(item => item.id === project.id);
  assert.ok(node);
  assert.equal(matchesPropertyFilter(node, 'score=8'), true);
  assert.equal(matchesPropertyFilter(node, 'missing'), false);
});

test('grouping is deterministic for folder, tag, kind and property modes', () => {
  const folder = entry('folder', 'Projects', 'directory');
  const note = entry('note', 'Alpha.md', 'markdown', folder.id);
  const attachment = entry('attachment', 'alpha.png', 'attachment', folder.id);
  const graph = buildKnowledgeGraph(
    [folder,note,attachment],
    [record(note, '---\ntags: [project/math, second]\nstatus: active\n---\n![[alpha.png]]')],
  );
  const noteNode = graph.nodes.find(node => node.id === note.id);
  const attachmentNode = graph.nodes.find(node => node.id === attachment.id);
  assert.ok(noteNode && attachmentNode);
  assert.equal(graphGroupKey(noteNode, 'folder'), 'Projects');
  assert.equal(graphGroupKey(noteNode, 'tag'), 'project/math');
  assert.equal(graphGroupKey(noteNode, 'kind'), 'Notes');
  assert.equal(graphGroupKey(attachmentNode, 'kind'), 'Attachments');
  assert.equal(graphGroupKey(noteNode, 'property', 'status'), 'active');
  assert.equal(graphGroupKey(attachmentNode, 'property', 'status'), 'No status');
});

test('ambiguous note references are reported and do not create false edges', () => {
  const left = entry('left', 'Left', 'directory');
  const right = entry('right', 'Right', 'directory');
  const one = entry('one', 'Duplicate.md', 'markdown', left.id);
  const two = entry('two', 'Duplicate.md', 'markdown', right.id);
  const source = entry('source', 'Source.md');
  const graph = buildKnowledgeGraph(
    [left,right,one,two,source],
    [record(one,''),record(two,''),record(source,'[[Duplicate]]')],
  );
  assert.equal(graph.ambiguousReferences, 1);
  assert.equal(graph.edges.length, 0);
  assert.equal(graph.nodes.find(node => node.id === source.id)?.orphan, true);
});
