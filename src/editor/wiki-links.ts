import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { parseWikiReferences } from '../knowledge/parser.js';
import type { WikiSuggestion } from '../knowledge/types.js';

export interface WikiEditorBridge {
  suggest(query: string): WikiSuggestion[];
  resolve(target: string): 'resolved' | 'ambiguous' | 'unresolved';
  activate(target: string): void;
}

function completionSource(bridge: WikiEditorBridge) {
  return (context: CompletionContext): CompletionResult | null => {
    const match = context.matchBefore(/!?\[\[[^\]\n]*$/);
    if (!match) return null;
    const prefix = match.text.startsWith('![') ? 3 : 2;
    const query = match.text.slice(prefix);
    const suggestions = bridge.suggest(query);
    return {
      from: match.from + prefix,
      options: suggestions.map(item => ({
        label: item.label,
        detail: item.detail,
        boost: item.boost,
        type: 'text',
        apply: `${item.insert}]]`,
      })),
      validFor: /^[^\]\n]*$/,
    };
  };
}

class EmbedBadge extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-wiki-embed-badge';
    span.textContent = '\u21b3';
    span.setAttribute('aria-hidden', 'true');
    return span;
  }
  eq(): boolean { return true; }
}

function decorations(view: EditorView, bridge: WikiEditorBridge, references: ReturnType<typeof parseWikiReferences>): DecorationSet {
  const ranges: ReturnType<Decoration['range']>[] = [];
  for (const reference of references) {
    const status = bridge.resolve(reference.targetText);
    const active = view.state.selection.ranges.some(range => range.from <= reference.to && range.to >= reference.from);
    const className = `cm-wiki-link-source cm-wiki-${status}${reference.embed ? ' cm-wiki-embed-source' : ''}`;

    if (active) {
      ranges.push(Decoration.mark({ class: className }).range(reference.from, reference.to));
      continue;
    }

    if (reference.from < reference.innerFrom) {
      ranges.push(Decoration.replace({}).range(reference.from, reference.innerFrom));
    }
    if (reference.aliasFrom !== null && reference.pipeFrom !== null && reference.innerFrom < reference.aliasFrom) {
      ranges.push(Decoration.replace({}).range(reference.innerFrom, reference.aliasFrom));
    }
    if (reference.innerTo < reference.to) {
      ranges.push(Decoration.replace({}).range(reference.innerTo, reference.to));
    }
    const visibleFrom = reference.aliasFrom ?? reference.innerFrom;
    if (reference.embed) {
      ranges.push(Decoration.widget({ widget: new EmbedBadge(), side: -1 }).range(visibleFrom));
    }
    if (visibleFrom < reference.innerTo) {
      ranges.push(Decoration.mark({ class: className }).range(visibleFrom, reference.innerTo));
    }
  }
  return Decoration.set(ranges, true);
}

export function wikiPreviewExtension(bridge: WikiEditorBridge) {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    private references: ReturnType<typeof parseWikiReferences>;
    constructor(view: EditorView) {
      this.references = parseWikiReferences(view.state.doc.toString());
      this.decorations = decorations(view, bridge, this.references);
    }
    update(update: ViewUpdate): void {
      if (update.docChanged) this.references = parseWikiReferences(update.state.doc.toString());
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = decorations(update.view, bridge, this.references);
      }
    }
  }, {
    decorations: value => value.decorations,
    eventHandlers: {
      click(event, view) {
        if (!(event.ctrlKey || event.metaKey)) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) return false;
        const reference = parseWikiReferences(view.state.doc.toString()).find(item => pos >= item.from && pos <= item.to);
        if (!reference) return false;
        event.preventDefault();
        bridge.activate(reference.targetText);
        return true;
      },
    },
  });
}

export function wikiCompletionExtension(bridge: WikiEditorBridge) {
  return autocompletion({ override: [completionSource(bridge)] });
}
