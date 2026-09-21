import { StateField, type EditorState } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';

export interface QueryEditorBridge {
  render(source: string): HTMLElement;
}

export interface QueryFence {
  from: number;
  to: number;
  widgetAt: number;
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
        widgetAt: closeRow.endWithNewline,
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
    private readonly generation: object,
  ) {
    super();
  }

  eq(other: QueryWidget): boolean {
    return other.source === this.source
      && other.from === this.from
      && other.bridge === this.bridge
      && other.generation === this.generation;
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

function buildDecorations(
  state: EditorState,
  bridge: QueryEditorBridge,
  fences: readonly QueryFence[],
  generation: object,
): DecorationSet {
  const ranges: ReturnType<Decoration['range']>[] = [];
  for (const fence of fences) {
    const active = state.selection.ranges.some(range => range.from <= fence.to && range.to >= fence.from);
    if (active) continue;
    ranges.push(Decoration.widget({
      widget: new QueryWidget(fence.source, fence.from, bridge, generation),
      block: true,
      side: 1,
    }).range(fence.widgetAt));
  }
  return Decoration.set(ranges, true);
}

export function queryPreviewExtension(bridge: QueryEditorBridge) {
  // Block widgets change the editor's vertical geometry, so they must be
  // supplied as direct decorations from editor state rather than through
  // a viewport-derived ViewPlugin decoration source.
  const generation = {};
  return StateField.define<DecorationSet>({
    create(state) {
      const fences = parseQueryFences(state.doc.toString());
      return buildDecorations(state, bridge, fences, generation);
    },
    update(_value, transaction) {
      const fences = parseQueryFences(transaction.state.doc.toString());
      return buildDecorations(transaction.state, bridge, fences, generation);
    },
    provide: field => EditorView.decorations.from(field),
  });
}
