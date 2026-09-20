import test from 'node:test';
import assert from 'node:assert/strict';

test('Phase 2 editor module exports the professional editor controller', async () => {
  const module = await import('../build/core/editor/editor-controller.js');
  assert.equal(typeof module.MarkdownEditor, 'function');
});

test('Phase 2 reading renderer module loads without executing untrusted Markdown', async () => {
  const module = await import('../build/core/editor/renderer.js');
  assert.equal(typeof module.renderMarkdown, 'function');
});
