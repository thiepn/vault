import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { planObsidianMigration } from '../build/core/interoperability/obsidian.js';

const encoder = new TextEncoder();
const files = [];

for (let index = 0; index < 8_000; index++) {
  const next = (index + 1) % 8_000;
  files.push({
    path: `Synthetic Vault/Notes/Note ${String(index).padStart(5,'0')}.md`,
    bytes: encoder.encode([
      '---',
      'tags: [project, benchmark]',
      `status: ${index % 3 === 0 ? 'active' : 'reference'}`,
      '---',
      `# Note ${index}`,
      '',
      `[[Note ${String(next).padStart(5,'0')}]]`,
      `![asset](../Assets/image-${index % 1800}.png)`,
    ].join('\n')),
    directory:false,
    modifiedAt:null,
  });
}

for (let index = 0; index < 1_800; index++) {
  files.push({
    path: `Synthetic Vault/Assets/image-${index}.png`,
    bytes: Uint8Array.from([137,80,78,71,index & 255]),
    directory:false,
    modifiedAt:null,
  });
}

for (let index = 0; index < 200; index++) {
  files.push({
    path: `Synthetic Vault/Canvas/Board-${index}.canvas`,
    bytes: encoder.encode(JSON.stringify({
      nodes:[
        {id:'note',type:'file',file:`../Notes/Note ${String(index).padStart(5,'0')}.md`,x:0,y:0,width:260,height:160},
        {id:'text',type:'text',text:`Board ${index}`,x:340,y:0,width:220,height:120},
      ],
      edges:[{id:'edge',fromNode:'note',toNode:'text',toEnd:'arrow'}],
    })),
    directory:false,
    modifiedAt:null,
  });
}

const start=performance.now();
const plan=planObsidianMigration(files,'synthetic-obsidian.zip');
const elapsedMs=performance.now()-start;

assert.equal(files.length,10_000);
assert.equal(plan.report.markdownNotes,8_200);
assert.equal(plan.report.attachments,1_800);
assert.equal(plan.report.canvasesConverted,200);
assert.equal(plan.report.rewrittenWikiLinks,8_000);
assert.equal(plan.report.rewrittenMarkdownLinks,8_000);
assert.equal(plan.suggestedVaultName,'Synthetic Vault');
assert.ok(elapsedMs < 5_000,`10k Obsidian migration planning took ${elapsedMs.toFixed(1)} ms (limit 5000 ms)`);

console.log(JSON.stringify({
  sourceEntries:files.length,
  markdownNotes:plan.report.markdownNotes,
  attachments:plan.report.attachments,
  canvasesConverted:plan.report.canvasesConverted,
  rewrittenWikiLinks:plan.report.rewrittenWikiLinks,
  rewrittenMarkdownLinks:plan.report.rewrittenMarkdownLinks,
  elapsedMs:Number(elapsedMs.toFixed(1)),
},null,2));
