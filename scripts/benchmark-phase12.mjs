import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { parseCanvasDocument, serializeCanvasDocument } from '../build/core/canvas/model.js';

const nodes = Array.from({ length: 1000 }, (_, index) => ({
  id: `node-${index}`,
  type: index % 3 === 0 ? 'note' : index % 3 === 1 ? 'text' : 'media',
  ...(index % 3 === 0
    ? { target: `Notes/Note ${index}` }
    : index % 3 === 1
      ? { text: `Canvas card ${index}` }
      : { target: `Attachments/media-${index}.png`, alt: `Media ${index}` }),
  x: (index % 50) * 180,
  y: Math.floor(index / 50) * 130,
  width: 160,
  height: 100,
}));

const edges = Array.from({ length: 2000 }, (_, index) => ({
  id: `edge-${index}`,
  from: nodes[index % nodes.length].id,
  to: nodes[(index + 17) % nodes.length].id,
  label: index % 7 === 0 ? 'related' : null,
}));

const groups = Array.from({ length: 100 }, (_, index) => ({
  id: `group-${index}`,
  title: `Group ${index}`,
  x: (index % 10) * 900,
  y: Math.floor(index / 10) * 500,
  width: 820,
  height: 440,
}));

const input = { version:1, id:'benchmark-canvas', viewport:{x:80,y:80,zoom:1}, nodes, edges, groups };
const yaml = serializeCanvasDocument(input);

const start = performance.now();
const parsed = parseCanvasDocument(yaml);
const parseMs = performance.now() - start;

const serializeStart = performance.now();
const serialized = serializeCanvasDocument(parsed);
const serializeMs = performance.now() - serializeStart;

assert.equal(parsed.nodes.length, 1000);
assert.equal(parsed.edges.length, 2000);
assert.equal(parsed.groups.length, 100);
assert.ok(parseMs < 1500, `Canvas parse took ${parseMs.toFixed(1)} ms (limit 1500 ms)`);
assert.ok(serializeMs < 1000, `Canvas serialize took ${serializeMs.toFixed(1)} ms (limit 1000 ms)`);
assert.ok(serialized.length > 100_000);

console.log(JSON.stringify({
  nodes: parsed.nodes.length,
  edges: parsed.edges.length,
  groups: parsed.groups.length,
  sourceBytes: Buffer.byteLength(yaml),
  parseMs: Number(parseMs.toFixed(1)),
  serializeMs: Number(serializeMs.toFixed(1)),
}, null, 2));
