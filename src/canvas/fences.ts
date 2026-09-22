import { parseCanvasDocument } from './model.js';

export interface CanvasFence {
  from: number;
  to: number;
  sourceFrom: number;
  sourceTo: number;
  widgetAt: number;
  source: string;
  canvasId: string | null;
}

export function parseCanvasFences(text: string): CanvasFence[] {
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

  const fences: CanvasFence[] = [];
  for (let index = 0; index < rows.length; index++) {
    const openRow = rows[index]!;
    const open = /^ {0,3}(\x60{3,}|~{3,})[ \t]*vault-canvas[ \t]*$/iu.exec(openRow.text);
    if (!open) continue;
    const marker = open[1]!;
    const markerCharacter = marker[0]!;

    for (let closeIndex = index + 1; closeIndex < rows.length; closeIndex++) {
      const closeRow = rows[closeIndex]!;
      const close = /^ {0,3}(\x60{3,}|~{3,})[ \t]*$/u.exec(closeRow.text);
      if (!close || close[1]![0] !== markerCharacter || close[1]!.length < marker.length) continue;
      const sourceFrom = openRow.endWithNewline;
      const sourceTo = closeRow.from;
      const source = text.slice(sourceFrom, sourceTo).replace(/\r?\n$/u, '');
      let canvasId: string | null = null;
      try { canvasId = parseCanvasDocument(source).id; } catch { /* invalid source still needs an editable fence */ }
      fences.push({
        from: openRow.from,
        to: closeRow.to,
        sourceFrom,
        sourceTo,
        widgetAt: closeRow.endWithNewline,
        source,
        canvasId,
      });
      index = closeIndex;
      break;
    }
  }
  return fences;
}

export function replaceCanvasFenceSource(markdown: string, canvasId: string, nextSource: string): string {
  const matches = parseCanvasFences(markdown).filter(fence => fence.canvasId === canvasId);
  if (!matches.length) throw new Error(`Canvas "${canvasId}" no longer exists in this note.`);
  if (matches.length > 1) throw new Error(`Canvas id "${canvasId}" is duplicated in this note.`);
  const fence = matches[0]!;
  const suffix = markdown.slice(fence.sourceFrom, fence.sourceTo).endsWith('\n') ? '\n' : '';
  return markdown.slice(0, fence.sourceFrom) + nextSource + suffix + markdown.slice(fence.sourceTo);
}
