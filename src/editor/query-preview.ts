import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';

export interface QueryEditorBridge {
  render(source: string): HTMLElement;
}

export interface QueryFence {
  from: number;
  to: number;
  source: string;
}

export function parseQueryFences(text: string): QueryFence[] {
  const rows: Array<{ from: number; to: number; endWithNewline: number; text: string }> = [];
  let from = 0;
  while (from <= text.length) {
    const newline = text.indexOf('\n', from);
    const lineEnd = newline < 0 ? text.length : newline;
    const raw = text.slice(from, lineEnd).replace(/\r$/u, '');
    rows.push({ from, to: lineEnd, endWithNewline: newline < 0 ? lineEnd : newline + 1, text: raw });
    if (newline < 0) break;
    from = newline + 1;
  }

  const fences: QueryFence[] = [];
  for (let index = 0; index < rows.length; index++) {
    const openRow = rows[index]!;
    const open = /^ {0,3}(\x60{3,}|~{3,})[ \t]*vault-query[ \t]*$/iu.exec(openRow.text);
    if (!open) continue;
    const marker = open[1]!;
    const markerCharacter = marker[0]!;

    for (let closeIndex = index + 1; closeIndex < rows.length; closeIndex++) {
      const closeRow = rows[closeIndex]!;
      const close = /^ {0,3}(\x60{3,}|~{3,})[ \t]*$/u.exec(closeRow.text);
      if (!close || close[1]![0] !== markerCharacter || close[1]!.length < marker.length) continue;
      const sourceFrom = openRow.endWithNewline;
      const sourceTo = closeRow.from;
      const rawSource = text.slice(sourceFrom, sourceTo).replace(/\r?\n$/u, '');
      fences.push({
        from: openRow.from,
        to: closeRow.to,
        source: rawSource,
      });
      index = closeIndex;
      break;
    }
  }
  return fences;
}

class QueryWidget extends WidgetType {
  constructor(
    private readonly source: string,
    private readonly from: number,
    private readonly bridge: QueryEditorBridge,
  ) {
    super();
  }

  eq(other: QueryWidget): boolean {
    return other.source === this.source && other.from === this.from && other.bridge === this.bridge;
  }

  toDOM(view: EditorView): HTMLElement {
    const shell = document.createElement('div');
    shell.className = 'cm-query-widget';

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'cm-query-edit';
    edit.textContent = 'Edit query';
    edit.setAttribute('aria-label', 'Edit this dynamic query');
    edit.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({
        selection: { anchor: Math.min(view.state.doc.length, this.from + 1) },
        scrollIntoView: true,
      });
      view.focus();
    });
    shell.append(edit);

    try {
      shell.append(this.bridge.render(this.source));
    } catch (error) {
      const warning = document.createElement('aside');
      warning.className = 'render-warning query-render-warning';
      warning.textContent = 'Vault query could not run: ' + (error instanceof Error ? error.message : 'invalid query');
      shell.append(warning);
    }
    return shell;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function buildDecorations(view: EditorView, bridge: QueryEditorBridge, fences: readonly QueryFence[]): DecorationSet {
  const ranges: ReturnType<Decoration['range']>[] = [];
  for (const fence of fences) {
    const active = view.state.selection.ranges.some(range => range.from <= fence.to && range.to >= fence.from);
    if (active) continue;
    ranges.push(Decoration.replace({
      widget: new QueryWidget(fence.source, fence.from, bridge),
      block: true,
    }).range(fence.from, fence.to));
  }
  return Decoration.set(ranges, true);
}

export function queryPreviewExtension(bridge: QueryEditorBridge) {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    fences: QueryFence[];

    constructor(view: EditorView) {
      this.fences = parseQueryFences(view.state.doc.toString());
      this.decorations = buildDecorations(view, bridge, this.fences);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged) this.fences = parseQueryFences(update.state.doc.toString());
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.view, bridge, this.fences);
      }
    }
  }, {
    decorations: value => value.decorations,
  });
}
