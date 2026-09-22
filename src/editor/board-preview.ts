import { StateField, type EditorState } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';

export interface BoardEditorBridge {
  render(source: string): HTMLElement;
}

export interface BoardFence {
  from: number;
  to: number;
  widgetAt: number;
  source: string;
}

export function parseBoardFences(text: string): BoardFence[] {
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

  const fences: BoardFence[] = [];
  for (let index = 0; index < rows.length; index++) {
    const openRow = rows[index]!;
    const open = /^ {0,3}(\x60{3,}|~{3,})[ \t]*vault-board[ \t]*$/iu.exec(openRow.text);
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

class BoardWidget extends WidgetType {
  constructor(
    private readonly source: string,
    private readonly from: number,
    private readonly bridge: BoardEditorBridge,
    private readonly generation: object,
  ) {
    super();
  }

  eq(other: BoardWidget): boolean {
    return other.source === this.source
      && other.from === this.from
      && other.bridge === this.bridge
      && other.generation === this.generation;
  }

  toDOM(view: EditorView): HTMLElement {
    const shell = document.createElement('div');
    shell.className = 'cm-board-widget';

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'cm-board-edit';
    edit.textContent = 'Edit board';
    edit.setAttribute('aria-label', 'Edit this board definition');
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
      warning.className = 'render-warning board-render-warning';
      warning.textContent = 'Vault board could not run: ' + (error instanceof Error ? error.message : 'invalid board');
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
  bridge: BoardEditorBridge,
  fences: readonly BoardFence[],
  generation: object,
): DecorationSet {
  const ranges: ReturnType<Decoration['range']>[] = [];
  for (const fence of fences) {
    const active = state.selection.ranges.some(range => range.from <= fence.to && range.to >= fence.from);
    if (active) continue;
    ranges.push(Decoration.widget({
      widget: new BoardWidget(fence.source, fence.from, bridge, generation),
      block: true,
      side: 1,
    }).range(fence.widgetAt));
  }
  return Decoration.set(ranges, true);
}

export function boardPreviewExtension(bridge: BoardEditorBridge) {
  const generation = {};
  return StateField.define<DecorationSet>({
    create(state) {
      return buildDecorations(state, bridge, parseBoardFences(state.doc.toString()), generation);
    },
    update(_value, transaction) {
      return buildDecorations(transaction.state, bridge, parseBoardFences(transaction.state.doc.toString()), generation);
    },
    provide: field => EditorView.decorations.from(field),
  });
}
