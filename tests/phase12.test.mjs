import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canvasBounds,
  deleteCanvasNode,
  emptyCanvasDocument,
  parseCanvasDocument,
  serializeCanvasDocument,
} from '../build/core/canvas/model.js';
import { parseCanvasFences, replaceCanvasFenceSource } from '../build/core/canvas/fences.js';

const source = [
  'version: 1',
  'id: canvas-main',
  'viewport:',
  '  x: 120',
  '  y: 80',
  '  zoom: 1.25',
  'nodes:',
  '  - id: note-a',
  '    type: note',
  '    target: Projects/Alpha',
  '    x: 10',
  '    y: 20',
  '    width: 260',
  '    height: 160',
  '  - id: text-a',
  '    type: text',
  '    text: Hello canvas',
  '    x: 350',
  '    y: 30',
  '    width: 240',
  '    height: 140',
  '  - id: media-a',
  '    type: media',
  '    target: Attachments/photo.png',
  '    alt: Photo',
  '    x: 100',
  '    y: 260',
  '    width: 300',
  '    height: 200',
  'edges:',
  '  - id: edge-a',
  '    from: note-a',
  '    to: text-a',
  '    label: explains',
  'groups:',
  '  - id: group-a',
  '    title: Research',
  '    x: -20',
  '    y: -30',
  '    width: 650',
  '    height: 520',
].join('\n');

test('Phase 12 parses and serializes the canonical spatial document', () => {
  const document = parseCanvasDocument(source);
  assert.equal(document.id, 'canvas-main');
  assert.equal(document.nodes.length, 3);
  assert.equal(document.edges.length, 1);
  assert.equal(document.groups.length, 1);
  assert.deepEqual(document.viewport, { x:120, y:80, zoom:1.25 });
  assert.equal(document.nodes[0].type, 'note');
  assert.equal(document.nodes[1].type, 'text');
  assert.equal(document.nodes[2].type, 'media');

  const roundTrip = parseCanvasDocument(serializeCanvasDocument(document));
  assert.deepEqual(roundTrip, document);
});

test('Canvas reference validation rejects broken, duplicate, and self edges', () => {
  assert.throws(() => parseCanvasDocument([
    'id: broken',
    'nodes:',
    '  - { id: a, type: text, text: A, x: 0, y: 0, width: 120, height: 80 }',
    'edges:',
    '  - { id: e, from: a, to: missing }',
  ].join('\n')), /missing target node/);

  assert.throws(() => parseCanvasDocument([
    'id: duplicate',
    'nodes:',
    '  - { id: a, type: text, text: A, x: 0, y: 0, width: 120, height: 80 }',
    '  - { id: a, type: text, text: B, x: 0, y: 0, width: 120, height: 80 }',
  ].join('\n')), /Duplicate node id/);

  assert.throws(() => parseCanvasDocument([
    'id: self-edge',
    'nodes:',
    '  - { id: a, type: text, text: A, x: 0, y: 0, width: 120, height: 80 }',
    'edges:',
    '  - { id: e, from: a, to: a }',
  ].join('\n')), /cannot connect a node to itself/);
});

test('deleting a Canvas node also removes its incident connections', () => {
  const document = parseCanvasDocument(source);
  const next = deleteCanvasNode(document, 'note-a');
  assert.equal(next.nodes.some(node => node.id === 'note-a'), false);
  assert.equal(next.edges.length, 0);
  assert.equal(document.nodes.some(node => node.id === 'note-a'), true);
});

test('Canvas bounds include both nodes and visual groups', () => {
  const document = parseCanvasDocument(source);
  assert.deepEqual(canvasBounds(document), { x:-20, y:-30, width:650, height:520 });
  assert.equal(canvasBounds(emptyCanvasDocument('blank-canvas')), null);
});

test('vault-canvas fences retain identity and replace only their YAML source', () => {
  const markdown = [
    '# Spatial',
    '',
    '```vault-canvas',
    source,
    '```',
    '',
    'After canvas.',
  ].join('\n');
  const fences = parseCanvasFences(markdown);
  assert.equal(fences.length, 1);
  assert.equal(fences[0].canvasId, 'canvas-main');

  const document = parseCanvasDocument(source);
  document.viewport.zoom = 2;
  document.nodes[0].x = 88;
  const replacement = serializeCanvasDocument(document);
  const updated = replaceCanvasFenceSource(markdown, 'canvas-main', replacement);
  assert.match(updated, /zoom: 2/);
  assert.match(updated, /x: 88/);
  assert.match(updated, /After canvas\.$/);
  assert.equal(updated.includes('# Spatial'), true);
});

test('fence parser recognizes backtick and tilde Canvas fences and leaves invalid source editable', () => {
  const markdown = [
    '```vault-canvas',
    'id: one',
    '```',
    '',
    '~~~VAULT-CANVAS',
    'not: [valid',
    '~~~',
  ].join('\n');
  const fences = parseCanvasFences(markdown);
  assert.equal(fences.length, 2);
  assert.equal(fences[0].canvasId, 'one');
  assert.equal(fences[1].canvasId, null);
});

test('Canvas geometry and document safety limits fail closed', () => {
  assert.throws(() => parseCanvasDocument([
    'id: geometry',
    'nodes:',
    '  - { id: a, type: text, text: A, x: 0, y: 0, width: 20, height: 80 }',
  ].join('\n')), /width/);

  const tooMany = {
    version: 1,
    id: 'too-many',
    viewport: { x:0, y:0, zoom:1 },
    nodes: Array.from({length:1001}, (_, index) => ({
      id:`n-${index}`, type:'text', text:'x', x:index, y:0, width:120, height:80,
    })),
    edges: [],
    groups: [],
  };
  assert.throws(() => parseCanvasDocument(JSON.stringify(tooMany)), /at most 1000 nodes/);
});
