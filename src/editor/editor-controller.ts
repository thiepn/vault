import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { openSearchPanel } from '@codemirror/search';
import { basicSetup } from 'codemirror';
import { livePreviewExtension } from './live-preview.js';
import { wikiCompletionExtension, wikiPreviewExtension, type WikiEditorBridge } from './wiki-links.js';
import { queryPreviewExtension, type QueryEditorBridge } from './query-preview.js';
import { boardPreviewExtension, type BoardEditorBridge } from './board-preview.js';

export type EditMode = 'source' | 'live';
export type MarkdownCommand =
  | 'bold' | 'italic' | 'inline-code' | 'link'
  | 'heading' | 'task' | 'bullet' | 'quote'
  | 'code-block' | 'math-block' | 'callout' | 'table' | 'wiki-link';

export interface EditorStats {
  characters: number;
  words: number;
  line: number;
  column: number;
  selectedWords: number;
  position: number;
}

export interface MarkdownEditorOptions {
  text: string;
  mode?: EditMode;
  readOnly?: boolean;
  lineNumbers?: boolean;
  wiki?: WikiEditorBridge;
  query?: QueryEditorBridge;
  board?: BoardEditorBridge;
  onChange(text: string): void;
  onStats?(stats: EditorStats): void;
}

const readOnlyCompartment = new Compartment();
const editableCompartment = new Compartment();
const previewCompartment = new Compartment();

function countWords(text: string): number {
  const matches = text.trim().match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu);
  return matches?.length ?? 0;
}

function replaceSelection(view: EditorView, insert: string, anchorOffset = insert.length): boolean {
  const selection = view.state.selection.main;
  view.dispatch({
    changes: { from: selection.from, to: selection.to, insert },
    selection: { anchor: selection.from + anchorOffset },
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

function wrapSelection(view: EditorView, before: string, after = before, placeholder = ''): boolean {
  const selection = view.state.selection.main;
  const selected = view.state.sliceDoc(selection.from, selection.to);
  const inner = selected || placeholder;
  const insert = `${before}${inner}${after}`;
  view.dispatch({
    changes: { from: selection.from, to: selection.to, insert },
    selection: selected
      ? { anchor: selection.from + insert.length }
      : { anchor: selection.from + before.length, head: selection.from + before.length + inner.length },
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

function prefixLine(view: EditorView, prefix: string): boolean {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  view.dispatch({ changes: { from: line.from, insert: prefix }, selection: { anchor: head + prefix.length } });
  view.focus();
  return true;
}

export class MarkdownEditor {
  readonly view: EditorView;
  private readonly onChange: (text: string) => void;
  private readonly onStats: ((stats: EditorStats) => void) | undefined;
  private suppressChange = false;
  private mode: EditMode;
  private readonly wiki: WikiEditorBridge | undefined;
  private readonly query: QueryEditorBridge | undefined;
  private readonly board: BoardEditorBridge | undefined;
  private cachedCharacters = 0;
  private cachedWords = 0;

  constructor(readonly host: HTMLElement, options: MarkdownEditorOptions) {
    this.onChange = options.onChange;
    this.onStats = options.onStats;
    this.mode = options.mode ?? 'live';
    this.wiki = options.wiki;
    this.query = options.query;
    this.board = options.board;
    host.dataset.lineNumbers = String(options.lineNumbers ?? false);
    host.dataset.mode = this.mode;

    const markdownKeys = keymap.of([
      { key: 'Mod-b', run: view => wrapSelection(view, '**', '**', 'bold text') },
      { key: 'Mod-i', run: view => wrapSelection(view, '*', '*', 'italic text') },
      { key: 'Mod-`', run: view => wrapSelection(view, '`', '`', 'code') },
      { key: 'Mod-k', run: view => wrapSelection(view, '[', '](https://)', 'link text') },
      indentWithTab,
    ]);

    const state = EditorState.create({
      doc: options.text,
      extensions: [
        basicSetup,
        markdown(),
        EditorView.lineWrapping,
        markdownKeys,
        readOnlyCompartment.of(EditorState.readOnly.of(options.readOnly ?? false)),
        editableCompartment.of(EditorView.editable.of(!(options.readOnly ?? false))),
        previewCompartment.of(this.mode === 'live' ? this.previewExtensions() : []),
        this.wiki ? wikiCompletionExtension(this.wiki) : [],
        EditorView.updateListener.of(update => {
          if (update.docChanged) {
            this.recount(update.state);
            if (!this.suppressChange) this.onChange(update.state.doc.toString());
          }
          if (update.docChanged || update.selectionSet) this.emitStats(update.state);
        }),
        EditorView.theme({
          '&': { height: '100%' },
          '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--editor)' },
          '.cm-content': { minHeight: '100%', caretColor: 'var(--accent)' },
          '&.cm-focused': { outline: 'none' },
        }),
      ],
    });

    this.view = new EditorView({ state, parent: host });
    this.recount(state);
    this.emitStats(state);
  }

  getText(): string {
    return this.view.state.doc.toString();
  }

  setText(text: string): void {
    if (text === this.getText()) return;
    this.suppressChange = true;
    try {
      this.view.dispatch({
        changes: { from: 0, to: this.view.state.doc.length, insert: text },
        selection: { anchor: 0 },
        scrollIntoView: true,
      });
    } finally {
      this.suppressChange = false;
    }
    this.recount(this.view.state);
    this.emitStats(this.view.state);
  }

  /** Apply a storage/identity normalization without resetting the user's selection. */
  reconcileText(text: string): void {
    const current = this.getText();
    if (text === current) return;
    let prefix = 0;
    const maxPrefix = Math.min(current.length, text.length);
    while (prefix < maxPrefix && current[prefix] === text[prefix]) prefix++;

    let suffix = 0;
    const maxSuffix = Math.min(current.length - prefix, text.length - prefix);
    while (
      suffix < maxSuffix
      && current[current.length - 1 - suffix] === text[text.length - 1 - suffix]
    ) suffix++;

    this.suppressChange = true;
    try {
      this.view.dispatch({
        changes: {
          from: prefix,
          to: current.length - suffix,
          insert: text.slice(prefix, text.length - suffix),
        },
      });
    } finally {
      this.suppressChange = false;
    }
    this.recount(this.view.state);
    this.emitStats(this.view.state);
  }

  setReadOnly(value: boolean): void {
    this.view.dispatch({
      effects: [
        readOnlyCompartment.reconfigure(EditorState.readOnly.of(value)),
        editableCompartment.reconfigure(EditorView.editable.of(!value)),
      ],
    });
    this.host.dataset.readonly = String(value);
  }

  setMode(mode: EditMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.view.dispatch({
      effects: previewCompartment.reconfigure(mode === 'live' ? this.previewExtensions() : []),
    });
    this.host.dataset.mode = mode;
  }

  refreshPreview(): void {
    if (this.mode !== 'live') return;
    this.view.dispatch({
      effects: previewCompartment.reconfigure(this.previewExtensions()),
    });
  }

  private previewExtensions(): Extension[] {
    return [
      livePreviewExtension,
      ...(this.wiki ? [wikiPreviewExtension(this.wiki)] : []),
      ...(this.query ? [queryPreviewExtension(this.query)] : []),
      ...(this.board ? [boardPreviewExtension(this.board)] : []),
    ];
  }

  setLineNumbers(show: boolean): void {
    this.host.dataset.lineNumbers = String(show);
  }

  getLineNumbers(): boolean {
    return this.host.dataset.lineNumbers === 'true';
  }

  focus(): void {
    this.view.focus();
  }

  hasFocus(): boolean {
    return this.view.hasFocus;
  }

  openSearch(): void {
    openSearchPanel(this.view);
    this.view.focus();
  }

  stats(): EditorStats {
    return this.computeStats(this.view.state);
  }

  run(command: MarkdownCommand): boolean {
    const view = this.view;
    switch (command) {
      case 'bold': return wrapSelection(view, '**', '**', 'bold text');
      case 'italic': return wrapSelection(view, '*', '*', 'italic text');
      case 'inline-code': return wrapSelection(view, '`', '`', 'code');
      case 'link': return wrapSelection(view, '[', '](https://)', 'link text');
      case 'heading': return prefixLine(view, '## ');
      case 'task': return prefixLine(view, '- [ ] ');
      case 'bullet': return prefixLine(view, '- ');
      case 'quote': return prefixLine(view, '> ');
      case 'code-block': return replaceSelection(view, '```\n\n```', 4);
      case 'math-block': return replaceSelection(view, '$$\n\n$$', 3);
      case 'callout': return replaceSelection(view, '> [!NOTE]\n> ', 12);
      case 'table': return replaceSelection(view, '| Column 1 | Column 2 |\n| --- | --- |\n| Value | Value |\n');
      case 'wiki-link': return wrapSelection(view, '[[', ']]', 'Note');
    }
  }

  insertText(text: string, cursorOffset: number | null = null): void {
    const selection = this.view.state.selection.main;
    const anchor = selection.from + Math.max(0, Math.min(cursorOffset ?? text.length, text.length));
    this.view.dispatch({
      changes: { from: selection.from, to: selection.to, insert: text },
      selection: { anchor },
      scrollIntoView: true,
    });
    this.view.focus();
  }

  revealOffset(offset: number): void {
    const position = Math.max(0, Math.min(offset, this.view.state.doc.length));
    this.view.dispatch({ selection: { anchor: position }, scrollIntoView: true });
    this.view.focus();
  }
  revealRange(from: number, to: number): void {
    const start = Math.max(0, Math.min(from, this.view.state.doc.length));
    const end = Math.max(start, Math.min(to, this.view.state.doc.length));
    this.view.dispatch({ selection: { anchor: start, head: end }, scrollIntoView: true });
    this.view.focus();
  }

  destroy(): void {
    this.view.destroy();
    this.host.replaceChildren();
  }

  private recount(state: EditorState): void {
    const text = state.doc.toString();
    this.cachedCharacters = text.length;
    this.cachedWords = countWords(text);
  }

  private computeStats(state: EditorState): EditorStats {
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    const selectedText = state.sliceDoc(state.selection.main.from, state.selection.main.to);
    return {
      characters: this.cachedCharacters,
      words: this.cachedWords,
      line: line.number,
      column: head - line.from + 1,
      selectedWords: countWords(selectedText),
      position: head,
    };
  }

  private emitStats(state: EditorState): void {
    this.onStats?.(this.computeStats(state));
  }
}
