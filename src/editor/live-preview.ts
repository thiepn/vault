import { syntaxTree } from '@codemirror/language';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';

function buildDecorations(view: EditorView): DecorationSet {
  const ranges: ReturnType<Decoration['range']>[] = [];
  const lineDecorated = new Set<number>();

  for (const visible of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from: visible.from,
      to: visible.to,
      enter(node) {
        const name = node.name;
        const heading = /^ATXHeading([1-6])$/.exec(name);
        if (heading) {
          const line = view.state.doc.lineAt(node.from);
          if (!lineDecorated.has(line.from)) {
            lineDecorated.add(line.from);
            ranges.push(Decoration.line({ class: `cm-live-heading cm-live-h${heading[1]}` }).range(line.from));
          }
          return;
        }
        if (name === 'StrongEmphasis') {
          ranges.push(Decoration.mark({ class: 'cm-live-strong' }).range(node.from, node.to));
        } else if (name === 'Emphasis') {
          ranges.push(Decoration.mark({ class: 'cm-live-emphasis' }).range(node.from, node.to));
        } else if (name === 'InlineCode') {
          ranges.push(Decoration.mark({ class: 'cm-live-inline-code' }).range(node.from, node.to));
        } else if (name.includes('Link') || name === 'URL') {
          ranges.push(Decoration.mark({ class: 'cm-live-link' }).range(node.from, node.to));
        } else if (name === 'Blockquote') {
          const start = view.state.doc.lineAt(node.from).number;
          const end = view.state.doc.lineAt(Math.max(node.from, node.to - 1)).number;
          for (let lineNumber = start; lineNumber <= end; lineNumber++) {
            const line = view.state.doc.line(lineNumber);
            if (!lineDecorated.has(line.from)) {
              lineDecorated.add(line.from);
              ranges.push(Decoration.line({ class: 'cm-live-blockquote' }).range(line.from));
            }
          }
        } else if (name === 'FencedCode') {
          ranges.push(Decoration.mark({ class: 'cm-live-codeblock' }).range(node.from, node.to));
        }
      },
    });
  }
  return Decoration.set(ranges, true);
}

/**
 * Phase 2 live-preview foundation: semantic typography is derived from the
 * incremental Markdown syntax tree. Markdown remains visible/editable; syntax
 * concealment is intentionally deferred until links/embeds land in Phase 3.
 */
export const livePreviewExtension = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) {
    this.decorations = buildDecorations(view);
  }
  update(update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged || update.selectionSet) {
      this.decorations = buildDecorations(update.view);
    }
  }
}, {
  decorations: plugin => plugin.decorations,
});
