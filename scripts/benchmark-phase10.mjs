import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { buildKnowledgeGraph, filterKnowledgeGraph, graphGroupKey, localKnowledgeGraph } from '../build/core/graph/model.js';

const COUNT = 10_000;
const vaultId = '11111111-1111-4111-8111-111111111111';
const now = '2026-09-22T00:00:00.000Z';

const entries = Array.from({ length: COUNT }, (_, index) => ({
  id: `note-${String(index).padStart(5, '0')}`,
  vaultId,
  parentId: null,
  name: `Note ${String(index).padStart(5, '0')}.md`,
  kind: 'markdown',
  createdAt: now,
  updatedAt: now,
  localVersion: 1,
  deletedAt: null,
  deletionBatch: null,
  activeKey: `entry-${index}`,
}));

function reference(target) {
  return {
    raw: `[[${target}]]`,
    from: 0,
    to: target.length + 4,
    innerFrom: 2,
    innerTo: target.length + 2,
    aliasFrom: null,
    pipeFrom: null,
    embed: false,
    targetText: target,
    note: target,
    heading: null,
    block: null,
    alias: null,
  };
}

const records = entries.map((entry, index) => {
  const next = entries[(index + 1) % COUNT];
  const jump = entries[(index + 97) % COUNT];
  return {
    entryId: entry.id,
    vaultId,
    localVersion: 1,
    indexVersion: 5,
    aliases: [],
    tags: [`bucket/${index % 20}`],
    properties: { status: index % 3 === 0 ? 'active' : 'reference', bucket: index % 20 },
    tasks: [],
    headings: [],
    blocks: [],
    links: [reference(next.name.replace(/\.md$/u, '')), reference(jump.name.replace(/\.md$/u, ''))],
    searchText: '',
    bodyText: '',
  };
});

const start = performance.now();
const graph = buildKnowledgeGraph(entries, records);
const buildMs = performance.now() - start;

const filterStart = performance.now();
const filtered = filterKnowledgeGraph(graph, { tag: '#bucket/7', property: 'status=active' });
const filterMs = performance.now() - filterStart;

const localStart = performance.now();
const local = localKnowledgeGraph(graph, entries[0].id, 3);
const localMs = performance.now() - localStart;

const groupStart = performance.now();
for (const node of graph.nodes) graphGroupKey(node, 'property', 'status');
const groupMs = performance.now() - groupStart;

assert.equal(graph.nodes.length, COUNT);
assert.equal(graph.edges.length, COUNT * 2);
assert.equal(graph.unresolvedReferences, 0);
assert.equal(graph.ambiguousReferences, 0);
assert.ok(filtered.nodes.length > 0);
assert.ok(local.nodes.length > 1);

const limits = {
  buildMs: 2500,
  filterMs: 300,
  localMs: 300,
  groupMs: 150,
};
assert.ok(buildMs < limits.buildMs, `10k graph build took ${buildMs.toFixed(1)} ms (limit ${limits.buildMs} ms)`);
assert.ok(filterMs < limits.filterMs, `10k graph filter took ${filterMs.toFixed(1)} ms (limit ${limits.filterMs} ms)`);
assert.ok(localMs < limits.localMs, `10k local graph took ${localMs.toFixed(1)} ms (limit ${limits.localMs} ms)`);
assert.ok(groupMs < limits.groupMs, `10k graph grouping took ${groupMs.toFixed(1)} ms (limit ${limits.groupMs} ms)`);

console.log(JSON.stringify({
  nodes: graph.nodes.length,
  edges: graph.edges.length,
  buildMs: Number(buildMs.toFixed(1)),
  filterMs: Number(filterMs.toFixed(1)),
  localMs: Number(localMs.toFixed(1)),
  groupMs: Number(groupMs.toFixed(1)),
  filteredNodes: filtered.nodes.length,
  localNodes: local.nodes.length,
}, null, 2));
