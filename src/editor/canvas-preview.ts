import { StateField, type EditorState } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { parseCanvasFences, type CanvasFence } from '../canvas/fences.js';

export interface CanvasEditorBridge {
  render(source: string): HTMLElement;
}

class CanvasWidget extends WidgetType {
  constructor(
    private readonly fence: CanvasFence,
    private readonly bridge: CanvasEditorBridge,
    private readonly generation: object,
  ) {
    super();
  }

  eq(other: CanvasWidget): boolean {
    const sameCanvas = this.fence.canvasId !== null && other.fence.canvasId !== null
      ? this.fence.canvasId === other.fence.canvasId
      : this.fence.source === other.fence.source;
    return sameCanvas
      && other.fence.from === this.fence.from
      && other.bridge === this.bridge
      && other.generation === this.generation;
  }

  toDOM(view: EditorView): HTMLElement {
    const shell = document.createElement('div');
    shell.className = 'cm-canvas-widget';

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'cm-canvas-edit';
    edit.textContent = 'Edit canvas source';
    edit.setAttribute('aria-label', 'Edit this spatial canvas source');
    edit.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({
        selection: { anchor: Math.min(view.state.doc.length, this.fence.from + 1) },
        scrollIntoView: true,
      });
      view.focus();
    });
    shell.append(edit);

    try {
      shell.append(this.bridge.render(this.fence.source));
    } catch (error) {
      const warning = document.createElement('aside');
      warning.className = 'render-warning canvas-render-warning';
      warning.textContent = 'Vault canvas could not run: ' + (error instanceof Error ? error.message : 'invalid canvas');
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
  bridge: CanvasEditorBridge,
  generation: object,
): DecorationSet {
  const ranges: ReturnType<Decoration['range']>[] = [];
  for (const fence of parseCanvasFences(state.doc.toString())) {
    const active = state.selection.ranges.some(range => range.from <= fence.to && range.to >= fence.from);
    if (active) continue;
    ranges.push(Decoration.widget({
      widget: new CanvasWidget(fence, bridge, generation),
      block: true,
      side: 1,
    }).range(fence.widgetAt));
  }
  return Decoration.set(ranges, true);
}

export function canvasPreviewExtension(bridge: CanvasEditorBridge) {
  const generation = {};
  return StateField.define<DecorationSet>({
    create(state) {
      return buildDecorations(state, bridge, generation);
    },
    update(_value, transaction) {
      return buildDecorations(transaction.state, bridge, generation);
    },
    provide: field => EditorView.decorations.from(field),
  });
}
