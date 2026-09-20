import { VaultError, explainError } from '../domain/errors.js';
import type { Entry, EntryId, RecoveryDraft, Vault, VaultId } from '../domain/model.js';
import { VaultTree } from '../domain/tree.js';
import { openDatabase } from '../storage/database.js';
import { LocalRepository } from '../storage/local-repository.js';
import { request, transact } from '../storage/idb.js';
import { SaveCoordinator } from '../services/save-coordinator.js';
import { markdownFiles, zipStore } from '../services/export.js';
import { CommandRegistry } from '../commands/registry.js';
import { isFileSort, trashRows, treeRows, type FileSort } from '../services/file-tree.js';
import { MarkdownEditor, type EditorStats, type MarkdownCommand } from '../editor/editor-controller.js';
import { renderMarkdown } from '../editor/renderer.js';
import { KnowledgeIndexService } from '../knowledge/index-service.js';
import { extractFragment } from '../knowledge/fragments.js';
import { updateInboundLinksAfterMove } from '../knowledge/link-updater.js';
import { canonicalWikiNote } from '../knowledge/resolver.js';
import type { WikiResolution } from '../knowledge/types.js';
import { SearchIndexClient } from '../search/client.js';
import type { QuickSwitchResult, SearchFacets, SearchInput, SearchResult, SearchStats } from '../search/types.js';

export interface WorkspaceOptions { databaseName?: string }
type EditorMode = 'source' | 'live' | 'reading';

/** Phase 4 browser workspace: worker-backed search/indexing on the accepted Phase 1-3 foundation. */
export async function mountWorkspace(root: HTMLElement, options: WorkspaceOptions = {}): Promise<() => void> {
  const db = await openDatabase(options.databaseName);
  const repository = new LocalRepository(db);
  const knowledge = new KnowledgeIndexService(db);
  const searchIndex = new SearchIndexClient({
    onWorkerRestart() {
      searchReady = false;
      searchVaultId = undefined;
      searchBuildTarget = undefined;
      searchIndexStatus.textContent = 'Restarting index…';
      queueSearchRebuild(true);
    },
    onWorkerFailure(error) {
      searchReady = false;
      searchIndexStatus.textContent = 'Index unavailable';
      searchStatus.textContent = error.message;
    },
  });
  const abort = new AbortController();
  const registry = new CommandRegistry();
  let vaults: Vault[] = [];
  let vault: Vault | undefined;
  let entries: Entry[] = [];
  let recoveryDrafts: RecoveryDraft[] = [];
  let selected: Entry | undefined;
  let saver: SaveCoordinator | undefined;
  let showingTrash = false;
  let sortMode: FileSort = 'name-asc';
  let foldersFirst = true;
  let autoUpdateLinks = true;
  let collapsed = new Set<EntryId>();
  let filterText = '';
  let dirtyIds = new Set<EntryId>();
  let preferencesVaultId: VaultId | undefined;
  let knowledgeVaultId: VaultId | undefined;
  let searchVaultId: VaultId | undefined;
  let searchReady = false;
  let searchBuildGeneration = 0;
  let searchRequestGeneration = 0;
  let searchIndexedIds = new Set<EntryId>();
  let searchMetadata = new Map<EntryId, string>();
  let recentEntries: EntryId[] = [];
  let sidebarPanel: 'files' | 'search' | 'tags' = 'files';
  let searchResults: SearchResult[] = [];
  let searchFacets: SearchFacets = { tags: [], properties: [] };
  let searchStats: SearchStats = { documents: 0, tokens: 0, tags: 0, properties: 0 };
  let quickResults: QuickSwitchResult[] = [];
  let quickSelection = 0;
  let draggedEntryId: EntryId | undefined;
  let editorMode: EditorMode = 'live';
  let lineNumbers = false;
  let editorStats: EditorStats = { characters: 0, words: 0, line: 1, column: 1, selectedWords: 0, position: 0 };
  let renderGeneration = 0;
  let disposed = false;
  let chain: Promise<unknown> = Promise.resolve();
  let searchBuildChain: Promise<void> = Promise.resolve();
  let searchBuildTarget: VaultId | undefined;

  // Static application markup only. All note titles and content use textContent/value below.
  root.innerHTML = `
    <div class="workspace" data-sidebar-open="false">
      <header class="topbar">
        <button class="mobile-toggle" data-action="files" aria-label="Toggle files" aria-expanded="false">\u2630</button>
        <div class="brand-mark" aria-hidden="true">V</div>
        <div class="brand"><strong>Vault</strong><span>Markdown knowledge workspace</span></div>
        <button type="button" class="quick-toggle" data-action="quick-switcher" aria-label="Open Quick Switcher" title="Quick Switcher">\u2315</button>
        <span class="stage">Phase 4 \u00b7 Search & index</span>
      </header>
      <aside class="sidebar" aria-label="Vault files">
        <label class="label" for="vault-vault">VAULT</label>
        <div class="vault-picker"><select id="vault-vault" aria-label="Active vault"></select><button data-action="vault-rename" aria-label="Rename active vault" title="Rename vault">\u270e</button></div>
        <button data-command="vault.create" class="quiet">+ New vault</button>
        <div class="sidebar-tabs" role="tablist" aria-label="Vault navigation"><button type="button" role="tab" data-sidebar-panel="files" aria-selected="true">Files</button><button type="button" role="tab" data-sidebar-panel="search" aria-selected="false">Search</button><button type="button" role="tab" data-sidebar-panel="tags" aria-selected="false">Tags</button></div>
        <section class="sidebar-panel files-panel" data-panel="files">
          <div class="section-heading"><span>EXPLORER</span><button data-action="reload" aria-label="Reload file list">\u21bb</button></div>
          <div class="button-row"><button data-command="file.create">+ Note</button><button data-command="folder.create">+ Folder</button></div>
          <input class="file-filter" type="search" placeholder="Filter files\u2026" aria-label="Filter files" />
          <div class="explorer-options"><select class="file-sort" aria-label="Sort files"><option value="name-asc">Name A\u2013Z</option><option value="name-desc">Name Z\u2013A</option><option value="modified-desc">Modified newest</option><option value="modified-asc">Modified oldest</option><option value="created-desc">Created newest</option><option value="created-asc">Created oldest</option></select><label><input class="folders-first" type="checkbox" checked /> Folders first</label></div>
          <div class="file-tree" role="tree" aria-label="Folders and notes" tabindex="0"></div>
          <button data-action="trash-view" class="quiet trash-button">Open Trash</button>
          <button data-action="recovery" class="quiet" disabled>Recovery drafts</button>
          <div class="mobile-exports"><button data-command="vault.export" disabled>Markdown ZIP</button><button data-command="vault.backup" disabled>Recovery backup</button></div>
        </section>
        <section class="sidebar-panel search-panel" data-panel="search" hidden>
          <div class="section-heading"><span>VAULT SEARCH</span><button data-action="rebuild-search" aria-label="Rebuild search index">\u21bb</button></div>
          <input class="global-search" type="search" placeholder="Search notes\u2026" aria-label="Search vault" autocomplete="off" />
          <p class="search-help">Try words, "exact phrase", tag:#math, path:University, file:Analysis, property:status=active, task:open, AND/OR/NOT.</p>
          <p class="search-status" role="status">Search index is preparing\u2026</p>
          <div class="search-results" role="list" aria-label="Search results"></div>
        </section>
        <section class="sidebar-panel tags-panel" data-panel="tags" hidden>
          <div class="section-heading"><span>TAGS & PROPERTIES</span></div>
          <input class="tag-filter" type="search" placeholder="Filter tags/properties\u2026" aria-label="Filter tags and properties" />
          <div class="facet-heading">TAGS</div><div class="tag-list"></div>
          <div class="facet-heading">PROPERTIES</div><div class="property-list"></div>
        </section>
        <div class="sidebar-bottom"><span class="local-dot"></span><span>Stored in this browser</span></div>
      </aside>
      <main class="main" aria-label="Markdown workspace">
        <div class="document-bar"><div class="breadcrumb">No file selected</div><div class="mode-switch" role="group" aria-label="Editor mode"><button type="button" data-editor-mode="source" aria-pressed="false">Source</button><button type="button" data-editor-mode="live" aria-pressed="true">Live Preview</button><button type="button" data-editor-mode="reading" aria-pressed="false">Reading</button></div></div>
        <div class="actions" aria-label="File actions">
          <button data-action="rename" disabled>Rename</button><button data-action="move" disabled>Move</button><button data-action="duplicate" disabled>Duplicate</button>
          <button data-action="delete" disabled>Move to Trash</button><button data-action="restore" hidden>Restore</button>
          <button data-action="export-draft" disabled>Export draft .md</button><button data-action="checkpoint" disabled>Checkpoint</button>
        </div>
        <div class="editor-toolbar" aria-label="Markdown formatting" hidden><button type="button" data-editor-command="heading" title="Heading">H</button><button type="button" data-editor-command="bold" title="Bold (Ctrl/Cmd+B)"><strong>B</strong></button><button type="button" data-editor-command="italic" title="Italic (Ctrl/Cmd+I)"><em>I</em></button><button type="button" data-editor-command="link" title="Link (Ctrl/Cmd+K)">Link</button><button type="button" data-editor-command="task">Task</button><button type="button" data-editor-command="bullet">List</button><button type="button" data-editor-command="inline-code">Code</button><button type="button" data-editor-command="code-block">Block</button><button type="button" data-editor-command="math-block">Math</button><button type="button" data-editor-command="callout">Callout</button><button type="button" data-editor-command="table">Table</button><button type="button" data-editor-command="wiki-link" title="Internal link">[[ ]]</button><button type="button" data-editor-action="search">Find</button><button type="button" data-editor-action="line-numbers" aria-pressed="false">Lines</button><button type="button" data-action="knowledge-panel" class="knowledge-toggle">Knowledge</button></div>
        <div class="error" role="alert" hidden></div>
        <div class="recovery-actions"><button data-action="retry-save" hidden>Retry local save</button><button data-action="reopen" hidden>Preserve draft and reopen saved version</button></div>
        <section class="empty-state">
          <p class="eyebrow">VAULT \u00b7 PHASE 4</p><h1>Find anything in your vault.</h1>
          <p>Search note text, titles, paths, aliases, tags, properties and tasks through a background index while Markdown stays canonical.</p>
          <button data-command="vault.create" class="primary">Create a vault</button>
          <p class="fineprint">Cloud synchronization remains deliberately inactive. Phase 2 changes the editor and renderer, not the Phase 1 durability model.</p>
        </section>
        <div id="vault-editor" class="editor-host" hidden aria-label="Markdown source editor"></div>
        <article class="reading-view" hidden aria-label="Rendered Markdown"></article>
        <div class="folder-message" hidden></div>
      </main>
      <aside class="inspector" aria-label="Knowledge and storage information"><button type="button" class="inspector-close" data-action="knowledge-panel" aria-label="Close knowledge panel">\u00d7</button>
        <p class="label">FILE INFORMATION</p><dl class="file-info"></dl>
        <div class="rule"></div><section class="outline-panel"><div class="panel-heading"><p class="label">OUTLINE</p><span class="outline-count"></span></div><div class="outline-list"></div></section>
        <div class="rule"></div><section class="backlinks-panel"><div class="panel-heading"><p class="label">BACKLINKS</p><span class="backlink-count"></span></div><div class="backlink-list"></div><div class="unlinked-heading">UNLINKED MENTIONS</div><div class="unlinked-list"></div></section>
        <label class="knowledge-setting"><input class="auto-update-links" type="checkbox" checked /> Update links on rename/move</label>
        <div class="rule"></div><p class="label">DATA OWNERSHIP</p>
        <button data-command="vault.export" disabled>Markdown ZIP</button>
        <button data-command="vault.backup" disabled>Recovery backup</button>
        <p class="fineprint">ZIP exports active files and empty folders. Recovery backup also includes Trash, checkpoints and stored recovery drafts.</p>
        <div class="rule"></div><p class="label">CLOUD STATUS</p><p class="fineprint">Not configured. Nothing is uploaded. Signing in will not automatically upload local notes.</p>
        <button data-action="persist">Request persistent storage</button><p class="storage-message fineprint"></p>
      </aside>
      <footer class="statusbar"><span class="save-status" role="status">No file open</span><span class="counts"></span><span class="search-index-status">Index idle</span><span class="vault-counts"></span><span>IndexedDB \u00b7 schema 2</span></footer>
    </div>
    <dialog class="form-dialog" aria-labelledby="vault-dialog-title">
      <form method="dialog"><h2 id="vault-dialog-title"></h2><label class="dialog-label" for="vault-dialog-input"></label>
      <input id="vault-dialog-input" required autocomplete="off" /><select class="dialog-select" hidden aria-label="Destination folder"></select>
      <p class="dialog-help fineprint"></p><div class="dialog-buttons"><button value="cancel" formnovalidate>Cancel</button><button value="confirm" class="primary">Confirm</button></div></form>
    </dialog>
    <dialog class="quick-switcher-dialog" aria-labelledby="quick-switcher-title">
      <div class="quick-switcher-shell"><h2 id="quick-switcher-title">Quick Switcher</h2><input class="quick-switcher-input" type="search" placeholder="Open a note\u2026" aria-label="Quick switcher" autocomplete="off" /><div class="quick-switcher-results" role="listbox" aria-label="Matching notes"></div><p class="quick-switcher-help">\u2191\u2193 navigate \u00b7 Enter open \u00b7 Esc close</p></div>
    </dialog>
    <dialog class="recovery-dialog" aria-labelledby="recovery-title">
      <form method="dialog"><h2 id="recovery-title">Recovery drafts</h2>
        <p class="fineprint">Each entry is a preserved snapshot, not the canonical note. Recovery creates a new Markdown file and never overwrites the original.</p>
        <label for="recovery-select">Choose a draft</label><select id="recovery-select"></select>
        <p class="recovery-meta fineprint"></p>
        <label for="recovery-text">Preserved Markdown</label><textarea id="recovery-text" readonly spellcheck="false"></textarea>
        <div class="dialog-buttons"><button type="button" data-recovery-action="download">Download .md</button><button type="button" data-recovery-action="recover" class="primary">Save as new note</button><button value="close">Close</button></div>
      </form>
    </dialog>`;

  function element<T extends Element>(selector: string): T {
    const value = root.querySelector<T>(selector);
    if (!value) throw new Error(`Missing Vault interface element: ${selector}`);
    return value;
  }
  const workspace = element<HTMLElement>('.workspace');
  const editorHost = element<HTMLElement>('#vault-editor');
  const readingView = element<HTMLElement>('.reading-view');
  const vaultSelect = element<HTMLSelectElement>('#vault-vault');
  const errorBox = element<HTMLElement>('.error');
  const dialog = element<HTMLDialogElement>('.form-dialog');
  const dialogInput = element<HTMLInputElement>('#vault-dialog-input');
  const dialogSelect = element<HTMLSelectElement>('.dialog-select');
  const recoveryDialog = element<HTMLDialogElement>('.recovery-dialog');
  const recoverySelect = element<HTMLSelectElement>('#recovery-select');
  const recoveryText = element<HTMLTextAreaElement>('#recovery-text');
  const fileFilter = element<HTMLInputElement>('.file-filter');
  const fileSort = element<HTMLSelectElement>('.file-sort');
  const foldersFirstToggle = element<HTMLInputElement>('.folders-first');
  const autoUpdateLinksToggle = element<HTMLInputElement>('.auto-update-links');
  const fileTree = element<HTMLElement>('.file-tree');
  const globalSearch = element<HTMLInputElement>('.global-search');
  const searchStatus = element<HTMLElement>('.search-status');
  const searchResultsElement = element<HTMLElement>('.search-results');
  const tagFilter = element<HTMLInputElement>('.tag-filter');
  const tagList = element<HTMLElement>('.tag-list');
  const propertyList = element<HTMLElement>('.property-list');
  const searchIndexStatus = element<HTMLElement>('.search-index-status');
  const quickDialog = element<HTMLDialogElement>('.quick-switcher-dialog');
  const quickInput = element<HTMLInputElement>('.quick-switcher-input');
  const quickResultsElement = element<HTMLElement>('.quick-switcher-results');
  const pathOf = (id: EntryId): string => new VaultTree(entries).path(id);
  const editor = new MarkdownEditor(editorHost, {
    text: '', mode: 'live', readOnly: true, lineNumbers: false,
    wiki: {
      suggest(query) {
        return selected?.kind === 'markdown'
          ? knowledge.suggestions(query, selected.id, entries)
          : [];
      },
      resolve(target) {
        return selected?.kind === 'markdown'
          ? knowledge.resolveRaw(target, selected.id, entries).status
          : 'unresolved';
      },
      activate(target) {
        if (selected?.kind === 'markdown') perform(() => activateWikiTarget(target, selected!.id));
      },
    },
    onChange(text) { saver?.update(text); updateCounts(); },
    onStats(stats) { editorStats = stats; updateCounts(); highlightCurrentOutline(); },
  });

  function showError(error: unknown): void {
    if (disposed) return;
    errorBox.textContent = explainError(error);
    errorBox.hidden = false;
  }
  function perform(action: () => Promise<void>): void {
    chain = chain.then(async () => {
      if (disposed) return;
      // Stop accepting keystrokes while replacing the editor's owning document.
      editor.setReadOnly(true);
      try { await action(); } finally { editor.setReadOnly(!selected || selected.deletedAt !== null || !saver || editorMode === 'reading'); }
    }).catch(showError);
  }
  function download(filename: string, content: BlobPart, type: string): void {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement('a');
    link.href = url; link.download = filename; link.click();
    // Delayed revocation is a browser download resource lifetime, not a state-race workaround.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
  function downloadDraft(): void {
    if (!selected || selected.kind !== 'markdown') return;
    download(selected.name, saver?.draft ?? editor.getText(), 'text/markdown;charset=utf-8');
  }
  async function setting(key: string, value?: unknown): Promise<unknown> {
    return transact(db, ['settings'], value === undefined ? 'readonly' : 'readwrite', async tx => {
      if (value !== undefined) { await request(tx.objectStore('settings').put({ key, value })); return value; }
      const item = await request<{ key: string; value: unknown } | undefined>(tx.objectStore('settings').get(key));
      return item?.value;
    });
  }
  async function ask(title: string, label: string, value = '', folders = false): Promise<string | null> {
    element<HTMLElement>('#vault-dialog-title').textContent = title;
    element<HTMLElement>('.dialog-label').textContent = label;
    dialogInput.value = value; dialogInput.hidden = folders; dialogInput.required = !folders;
    dialogSelect.hidden = !folders;
    element<HTMLElement>('.dialog-help').textContent = folders ? 'The file keeps its identity and revision history.' : 'Names are portable. Existing files are never overwritten.';
    if (folders) {
      dialogSelect.replaceChildren(new Option('Vault root', ''));
      const tree = new VaultTree(entries);
      const excluded = new Set(selected?.kind === 'directory' ? [selected.id, ...tree.descendants(selected.id).map(item => item.id)] : []);
      for (const folder of entries.filter(entry => entry.kind === 'directory' && entry.deletedAt === null && !excluded.has(entry.id))) {
        dialogSelect.add(new Option(tree.path(folder.id), folder.id));
      }
      dialogSelect.value = selected?.parentId ?? '';
    }
    dialog.returnValue = 'cancel';
    dialog.showModal();
    if (folders) dialogSelect.focus(); else { dialogInput.focus(); dialogInput.select(); }
    return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm' ? (folders ? dialogSelect.value : dialogInput.value) : null), { once: true }));
  }
  function parentForNew(): EntryId | null {
    if (!selected || selected.deletedAt !== null) return null;
    return selected.kind === 'directory' ? selected.id : selected.parentId;
  }
  function activeMarkdownEntries(): Entry[] {
    return entries.filter(entry => entry.kind === 'markdown' && entry.deletedAt === null);
  }

  function metadataKey(entry: Entry, path: string): string {
    return [entry.name, path, entry.createdAt, entry.updatedAt].join('\u0000');
  }

  function searchInput(entry: Entry, text: string, tree = new VaultTree(entries)): SearchInput {
    return {
      entryId: entry.id,
      vaultId: entry.vaultId,
      localVersion: entry.localVersion,
      title: entry.name,
      path: tree.path(entry.id),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      text,
    };
  }

  function switchSidebarPanel(panel: 'files' | 'search' | 'tags'): void {
    sidebarPanel = panel;
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-sidebar-panel]')) {
      const active = button.dataset.sidebarPanel === panel;
      button.setAttribute('aria-selected', String(active));
      button.classList.toggle('active', active);
    }
    for (const section of root.querySelectorAll<HTMLElement>('.sidebar-panel')) {
      section.hidden = section.dataset.panel !== panel;
    }
    if (panel === 'search') globalSearch.focus();
    if (panel === 'tags') tagFilter.focus();
  }

  function appendHighlightedText(target: HTMLElement, text: string, needles: readonly string[]): void {
    const candidates = [...new Set(needles.map(value => value.trim()).filter(Boolean))];
    if (!candidates.length) { target.textContent = text; return; }
    const lower = text.toLocaleLowerCase();
    const lowered = candidates.map(value => ({ raw: value, lower: value.toLocaleLowerCase() }));
    let cursor = 0;
    while (cursor < text.length) {
      let nextIndex = -1;
      let nextLength = 0;
      for (const candidate of lowered) {
        const index = lower.indexOf(candidate.lower, cursor);
        if (index >= 0 && (nextIndex < 0 || index < nextIndex || (index === nextIndex && candidate.raw.length > nextLength))) {
          nextIndex = index;
          nextLength = candidate.raw.length;
        }
      }
      if (nextIndex < 0) {
        target.append(document.createTextNode(text.slice(cursor)));
        break;
      }
      if (nextIndex > cursor) target.append(document.createTextNode(text.slice(cursor, nextIndex)));
      const mark = document.createElement('mark');
      mark.textContent = text.slice(nextIndex, nextIndex + nextLength);
      target.append(mark);
      cursor = nextIndex + nextLength;
    }
  }

  function renderSearchResults(): void {
    searchResultsElement.replaceChildren();
    if (!globalSearch.value.trim()) {
      const empty = document.createElement('p');
      empty.className = 'search-empty';
      empty.textContent = searchReady ? 'Type a query to search this vault.' : 'The background index is still preparing.';
      searchResultsElement.append(empty);
      return;
    }
    if (!searchResults.length) {
      const empty = document.createElement('p');
      empty.className = 'search-empty';
      empty.textContent = 'No matching notes.';
      searchResultsElement.append(empty);
      return;
    }
    for (const result of searchResults) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'search-result';
      button.dataset.searchEntry = result.entryId;
      const location = result.matches.find(match => (match.field === 'body' || match.field === 'heading' || match.field === 'task') && match.from !== null);
      if (location?.from !== null && location?.from !== undefined) {
        button.dataset.searchFrom = String(location.from);
        if (location.to !== null) button.dataset.searchTo = String(location.to);
      }
      const title = document.createElement('span');
      title.className = 'search-result-title';
      title.textContent = result.title;
      const path = document.createElement('span');
      path.className = 'search-result-path';
      path.textContent = result.path;
      const snippet = document.createElement('span');
      snippet.className = 'search-result-snippet';
      const snippetText = result.snippet || result.matches.slice(0, 3).map(match => match.text).join(' · ');
      appendHighlightedText(snippet, snippetText, result.matches.filter(match => match.field === 'body').map(match => match.text));
      const count = document.createElement('span');
      count.className = 'search-result-count';
      count.textContent = result.matchCount > 1 ? String(result.matchCount) : '';
      button.append(title, count, path, snippet);
      searchResultsElement.append(button);
    }
  }

  function renderFacets(): void {
    const filter = tagFilter.value.trim().normalize('NFC').toLocaleLowerCase();
    tagList.replaceChildren();
    propertyList.replaceChildren();

    for (const facet of searchFacets.tags.filter(item => !filter || item.tag.toLocaleLowerCase().includes(filter)).slice(0, 300)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'facet-item';
      button.dataset.searchQuery = 'tag:#' + facet.tag;
      button.style.paddingInlineStart = String(6 + Math.max(0, facet.tag.split('/').length - 1) * 10) + 'px';
      const label = document.createElement('span');
      label.textContent = '#' + facet.tag;
      const count = document.createElement('span');
      count.textContent = facet.count.toLocaleString();
      button.append(label, count);
      tagList.append(button);
    }
    if (!tagList.childElementCount) {
      const empty = document.createElement('p');
      empty.className = 'search-empty';
      empty.textContent = searchReady ? 'No tags.' : 'Indexing tags…';
      tagList.append(empty);
    }

    for (const facet of searchFacets.properties.filter(item => !filter || item.name.toLocaleLowerCase().includes(filter)).slice(0, 300)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'facet-item';
      button.dataset.searchQuery = 'property:' + facet.name;
      const label = document.createElement('span');
      label.textContent = facet.name;
      const count = document.createElement('span');
      count.textContent = facet.count.toLocaleString();
      button.append(label, count);
      propertyList.append(button);
    }
    if (!propertyList.childElementCount) {
      const empty = document.createElement('p');
      empty.className = 'search-empty';
      empty.textContent = searchReady ? 'No indexed properties.' : 'Indexing properties…';
      propertyList.append(empty);
    }
  }

  async function runGlobalSearch(): Promise<void> {
    const generation = ++searchRequestGeneration;
    const query = globalSearch.value.trim();
    if (!query) {
      searchResults = [];
      searchStatus.textContent = searchReady ? searchStats.documents.toLocaleString() + ' notes indexed.' : 'Search index is preparing…';
      renderSearchResults();
      return;
    }
    if (!searchReady) {
      searchResults = [];
      searchStatus.textContent = 'Search index is preparing…';
      renderSearchResults();
      return;
    }
    searchStatus.textContent = 'Searching…';
    try {
      const results = await searchIndex.search(query, 120);
      if (generation !== searchRequestGeneration) return;
      searchResults = results;
      searchStatus.textContent = results.length.toLocaleString() + ' result' + (results.length === 1 ? '' : 's') + '.';
      renderSearchResults();
    } catch (error) {
      if (generation !== searchRequestGeneration) return;
      searchResults = [];
      searchStatus.textContent = error instanceof Error ? error.message : 'Search failed.';
      renderSearchResults();
    }
  }

  async function refreshFacets(): Promise<void> {
    if (!searchReady) return;
    [searchFacets, searchStats] = await Promise.all([searchIndex.facets(), searchIndex.stats()]);
    searchIndexStatus.textContent = searchStats.documents.toLocaleString() + ' indexed';
    renderFacets();
  }

  async function buildSearchInputs(): Promise<SearchInput[]> {
    if (!vault) return [];
    const contents = await repository.listActiveMarkdownContents(vault.id);
    const contentById = new Map(contents.map(content => [content.entryId, content]));
    const tree = new VaultTree(entries);
    const inputs: SearchInput[] = [];
    for (const entry of activeMarkdownEntries()) {
      const content = contentById.get(entry.id);
      if (!content) continue;
      inputs.push(searchInput(entry, content.text, tree));
    }
    return inputs;
  }

  function queueSearchRebuild(force = false): void {
    if (!vault) return;
    if (!force && (searchVaultId === vault.id || searchBuildTarget === vault.id)) return;
    const targetVault = vault.id;
    const generation = ++searchBuildGeneration;
    searchBuildTarget = targetVault;
    searchReady = false;
    searchIndexStatus.textContent = 'Indexing…';
    searchStatus.textContent = 'Search index is preparing…';
    renderFacets();

    searchBuildChain = searchBuildChain.then(async () => {
      if (generation !== searchBuildGeneration || vault?.id !== targetVault) return;
      const inputs = await buildSearchInputs();
      if (generation !== searchBuildGeneration || vault?.id !== targetVault) return;
      const stats = await searchIndex.rebuild(inputs, (indexed, total) => {
        if (generation !== searchBuildGeneration || vault?.id !== targetVault) return;
        searchIndexStatus.textContent = indexed.toLocaleString() + ' / ' + total.toLocaleString() + ' indexed';
        searchStatus.textContent = 'Indexing ' + indexed.toLocaleString() + ' of ' + total.toLocaleString() + ' notes…';
      });
      if (generation !== searchBuildGeneration || vault?.id !== targetVault) return;
      searchVaultId = targetVault;
      searchBuildTarget = undefined;
      searchReady = true;
      searchStats = stats;
      searchIndexedIds = new Set(inputs.map(input => input.entryId));
      searchMetadata = new Map(inputs.map(input => {
        const entry = entries.find(item => item.id === input.entryId)!;
        return [input.entryId, metadataKey(entry, input.path)];
      }));
      await refreshFacets();
      searchStatus.textContent = stats.documents.toLocaleString() + ' notes indexed.';
      if (globalSearch.value.trim()) await runGlobalSearch();
      else renderSearchResults();
    }).catch(error => {
      if (generation === searchBuildGeneration) {
        searchReady = false;
        searchBuildTarget = undefined;
        searchIndexStatus.textContent = 'Index error';
        searchStatus.textContent = error instanceof Error ? error.message : 'Search index failed.';
      }
    });
  }

  async function reconcileSearchIndex(): Promise<void> {
    if (!vault || !searchReady || searchVaultId !== vault.id) return;
    const active = activeMarkdownEntries();
    const activeIds = new Set(active.map(entry => entry.id));
    const removed = [...searchIndexedIds].filter(entryId => !activeIds.has(entryId));
    if (removed.length) {
      await searchIndex.remove(removed);
      for (const entryId of removed) {
        searchIndexedIds.delete(entryId);
        searchMetadata.delete(entryId);
      }
    }

    const tree = new VaultTree(entries);
    const updates = [];
    const newEntries: Entry[] = [];
    for (const entry of active) {
      const path = tree.path(entry.id);
      const key = metadataKey(entry, path);
      if (!searchIndexedIds.has(entry.id)) newEntries.push(entry);
      else if (searchMetadata.get(entry.id) !== key) {
        updates.push({
          entryId: entry.id,
          title: entry.name,
          path,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
          localVersion: entry.localVersion,
        });
        searchMetadata.set(entry.id, key);
      }
    }
    if (updates.length) await searchIndex.updateMetadata(updates);
    for (const entry of newEntries) {
      const file = await repository.read(entry.id);
      if (!file.content) continue;
      const input = searchInput(entry, file.content.text, tree);
      await searchIndex.upsert(input);
      searchIndexedIds.add(entry.id);
      searchMetadata.set(entry.id, metadataKey(entry, input.path));
    }
    await refreshFacets();
  }

  async function refreshSearchEntry(entryId: EntryId): Promise<void> {
    if (!vault || !searchReady || searchVaultId !== vault.id) return;
    const entry = entries.find(item => item.id === entryId && item.kind === 'markdown' && item.deletedAt === null);
    if (!entry) {
      await searchIndex.remove([entryId]);
      searchIndexedIds.delete(entryId);
      searchMetadata.delete(entryId);
      return;
    }
    const file = await repository.read(entryId);
    if (!file.content) return;
    const tree = new VaultTree(entries);
    const input = searchInput(file.entry, file.content.text, tree);
    await searchIndex.upsert(input);
    searchIndexedIds.add(entryId);
    searchMetadata.set(entryId, metadataKey(file.entry, input.path));
    await refreshFacets();
  }

  function localQuickResults(query: string): QuickSwitchResult[] {
    const q = query.normalize('NFC').toLocaleLowerCase();
    const recentRank = new Map(recentEntries.map((entryId, index) => [entryId, 30 - index]));
    return activeMarkdownEntries()
      .map(entry => {
        const title = entry.name.replace(/\.md$/iu, '');
        const path = pathOf(entry.id);
        const titleLower = title.toLocaleLowerCase();
        const pathLower = path.toLocaleLowerCase();
        let score = !q ? 1 : titleLower === q ? 100 : titleLower.startsWith(q) ? 80 : titleLower.includes(q) ? 60 : pathLower.includes(q) ? 40 : -1;
        score += recentRank.get(entry.id) ?? 0;
        return { entryId: entry.id, title, path, alias: null, score };
      })
      .filter(result => result.score >= 0)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, 50);
  }

  function renderQuickResults(): void {
    quickResultsElement.replaceChildren();
    quickSelection = Math.max(0, Math.min(quickSelection, Math.max(0, quickResults.length - 1)));
    for (let index = 0; index < quickResults.length; index++) {
      const result = quickResults[index]!;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'quick-result' + (index === quickSelection ? ' selected' : '');
      button.dataset.quickEntry = result.entryId;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(index === quickSelection));
      const title = document.createElement('span');
      title.className = 'quick-result-title';
      title.textContent = result.alias ? result.alias + ' → ' + result.title : result.title;
      const path = document.createElement('span');
      path.className = 'quick-result-path';
      path.textContent = result.path;
      button.append(title, path);
      quickResultsElement.append(button);
    }
    if (!quickResults.length) {
      const empty = document.createElement('p');
      empty.className = 'search-empty';
      empty.textContent = 'No matching notes.';
      quickResultsElement.append(empty);
    }
  }

  async function runQuickSwitcher(): Promise<void> {
    const query = quickInput.value;
    quickResults = searchReady ? await searchIndex.quickSwitch(query, recentEntries, 50) : localQuickResults(query);
    quickSelection = 0;
    renderQuickResults();
  }

  async function openQuickSwitcher(): Promise<void> {
    if (!vault) return;
    quickInput.value = '';
    quickDialog.showModal();
    await runQuickSwitcher();
    quickInput.focus();
  }

  async function rememberRecent(entryId: EntryId): Promise<void> {
    if (!vault) return;
    recentEntries = [entryId, ...recentEntries.filter(id => id !== entryId)].slice(0, 40);
    await setting('recentEntries:' + vault.id, recentEntries);
  }

  async function openSearchResult(entryId: EntryId, from: number | null, to: number | null): Promise<void> {
    await openEntry(entryId);
    if (from !== null) {
      if (editorMode === 'reading') await setEditorMode('live');
      if (to !== null && to > from) editor.revealRange(from, to);
      else editor.revealOffset(from);
    }
  }

  async function loadTreePreferences(): Promise<void> {
    if (!vault || preferencesVaultId === vault.id) return;
    const rawSort = await setting(`treeSort:${vault.id}`);
    const rawFoldersFirst = await setting(`foldersFirst:${vault.id}`);
    const rawCollapsed = await setting(`collapsedFolders:${vault.id}`);
    const rawAutoUpdateLinks = await setting(`autoUpdateLinks:${vault.id}`);
    const rawFilter = await setting(`treeFilter:${vault.id}`);
    const rawRecent = await setting(`recentEntries:${vault.id}`);
    sortMode = isFileSort(rawSort) ? rawSort : 'name-asc';
    foldersFirst = typeof rawFoldersFirst === 'boolean' ? rawFoldersFirst : true;
    autoUpdateLinks = typeof rawAutoUpdateLinks === 'boolean' ? rawAutoUpdateLinks : true;
    collapsed = new Set(Array.isArray(rawCollapsed) ? rawCollapsed.filter((id): id is EntryId => typeof id === 'string') : []);
    filterText = typeof rawFilter === 'string' ? rawFilter : '';
    recentEntries = Array.isArray(rawRecent) ? rawRecent.filter((id): id is EntryId => typeof id === 'string').slice(0, 40) : [];
    preferencesVaultId = vault.id;
    fileSort.value = sortMode;
    foldersFirstToggle.checked = foldersFirst;
    autoUpdateLinksToggle.checked = autoUpdateLinks;
    fileFilter.value = filterText;
  }
  async function refresh(): Promise<void> {
    vaults = await repository.listVaults();
    vaultSelect.replaceChildren();
    for (const item of vaults.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))) vaultSelect.add(new Option(item.name, item.id));
    if (vault) vault = vaults.find(value => value.id === vault!.id);
    vault ??= vaults[0];
    if (vault) {
      vaultSelect.value = vault.id;
      await loadTreePreferences();
      entries = await repository.listEntries(vault.id, true);
      dirtyIds = new Set((await repository.listDirtyEntries(vault.id)).map(item => item.entryId));
      if (knowledgeVaultId !== vault.id) {
        await knowledge.loadVault(vault.id, entries);
        knowledgeVaultId = vault.id;
      }
      await knowledge.ensureVault(entries, repository);
      if (searchVaultId === vault.id && searchReady) {
        await reconcileSearchIndex();
      } else {
        if (searchVaultId !== vault.id) {
          searchResults = [];
          searchFacets = { tags: [], properties: [] };
          searchStats = { documents: 0, tokens: 0, tags: 0, properties: 0 };
          renderSearchResults();
          renderFacets();
        }
        queueSearchRebuild();
      }
    } else {
      entries = [];
      dirtyIds.clear();
      preferencesVaultId = undefined;
      knowledgeVaultId = undefined;
      searchReady = false;
      searchVaultId = undefined;
      searchBuildTarget = undefined;
      searchIndexedIds.clear();
      searchMetadata.clear();
      searchResults = [];
      searchFacets = { tags: [], properties: [] };
      searchStats = { documents: 0, tokens: 0, tags: 0, properties: 0 };
      recentEntries = [];
      searchIndexStatus.textContent = 'Index idle';
      searchStatus.textContent = 'No vault open.';
      fileFilter.value = '';
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-command="file.create"],[data-command="folder.create"],[data-command="vault.export"],[data-command="vault.backup"],[data-action="vault-rename"]')) button.disabled = !vault;
    element<HTMLButtonElement>('[data-action="recovery"]').disabled = !vault;
    renderTree(); renderInfo(); renderKnowledgePanels(); renderFacets(); renderSearchResults(); updateVaultCounts();
  }
  function updateVaultCounts(): void {
    const active = entries.filter(entry => entry.deletedAt === null);
    element<HTMLElement>('.vault-counts').textContent = vault ? `${active.filter(entry => entry.kind === 'markdown').length} notes \u00b7 ${active.filter(entry => entry.kind === 'directory').length} folders` : '';
  }
  function persistCollapsed(): void {
    if (!vault) return;
    void setting(`collapsedFolders:${vault.id}`, [...collapsed]).catch(showError);
  }
  function renderTree(): void {
    fileTree.replaceChildren();
    try {
      let rows = showingTrash
        ? trashRows(entries, sortMode)
        : treeRows(entries, { sort: sortMode, foldersFirst, collapsed, filter: filterText });
      if (showingTrash && filterText.trim()) {
        const query = filterText.trim().normalize('NFC').toLocaleLowerCase();
        rows = rows.filter(row => row.entry.name.toLocaleLowerCase().includes(query) || row.path.toLocaleLowerCase().includes(query));
      }
      for (const item of rows) {
        const entry = item.entry;
        const shell = document.createElement('div');
        shell.className = 'file-row-shell';
        shell.dataset.entryId = entry.id;
        shell.style.paddingInlineStart = `${4 + item.level * 14}px`;
        shell.setAttribute('role', 'treeitem');
        shell.setAttribute('aria-level', String(item.level + 1));
        if (entry.kind === 'directory' && !showingTrash) shell.setAttribute('aria-expanded', String(!item.collapsed));

        const toggle = document.createElement('button');
        toggle.className = 'tree-toggle';
        toggle.type = 'button';
        toggle.tabIndex = -1;
        if (entry.kind === 'directory' && !showingTrash) {
          toggle.textContent = item.hasChildren ? (item.collapsed ? '\u25b8' : '\u25be') : '\u00b7';
          toggle.disabled = !item.hasChildren;
          toggle.setAttribute('aria-label', `${item.collapsed ? 'Expand' : 'Collapse'} ${entry.name}`);
          toggle.onclick = event => {
            event.stopPropagation();
            if (!item.hasChildren) return;
            if (collapsed.has(entry.id)) collapsed.delete(entry.id); else collapsed.add(entry.id);
            persistCollapsed(); renderTree();
          };
        } else {
          toggle.textContent = '';
          toggle.disabled = true;
        }

        const row = document.createElement('button');
        row.className = `file-row${selected?.id === entry.id ? ' selected' : ''}`;
        row.dataset.entryId = entry.id;
        row.type = 'button';
        row.draggable = !showingTrash;
        row.title = item.path;
        row.setAttribute('aria-label', `${entry.kind === 'directory' ? 'Folder' : 'Note'} ${entry.name}`);
        const icon = document.createElement('span'); icon.className = 'file-icon'; icon.textContent = entry.kind === 'directory' ? '\u25b1' : '\u00b7';
        const label = document.createElement('span'); label.className = 'file-name'; label.textContent = showingTrash ? item.path : entry.name;
        row.append(icon, label);
        if (dirtyIds.has(entry.id) && !showingTrash) {
          const dirty = document.createElement('span'); dirty.className = 'dirty-indicator'; dirty.title = 'Local change pending future cloud sync'; dirty.setAttribute('aria-label', 'Locally modified'); dirty.textContent = '\u2022'; row.append(dirty);
        }
        row.onclick = () => perform(() => openEntry(entry.id));
        row.addEventListener('dragstart', event => {
          if (showingTrash) return;
          draggedEntryId = entry.id;
          event.dataTransfer?.setData('text/plain', entry.id);
          if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
          shell.classList.add('dragging');
        });
        row.addEventListener('dragend', () => { draggedEntryId = undefined; shell.classList.remove('dragging'); root.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target')); });
        if (entry.kind === 'directory' && !showingTrash) {
          shell.addEventListener('dragover', event => { if (!draggedEntryId || draggedEntryId === entry.id) return; event.preventDefault(); shell.classList.add('drop-target'); });
          shell.addEventListener('dragleave', () => shell.classList.remove('drop-target'));
          shell.addEventListener('drop', event => {
            event.preventDefault(); shell.classList.remove('drop-target');
            const sourceId = (draggedEntryId ?? event.dataTransfer?.getData('text/plain')) as EntryId | undefined;
            if (!sourceId || sourceId === entry.id) return;
            perform(() => moveByDrop(sourceId, entry.id));
          });
        }
        shell.append(toggle, row); fileTree.append(shell);
      }
      if (!rows.length) {
        const p = document.createElement('p'); p.className = 'tree-empty';
        p.textContent = showingTrash ? (filterText ? 'No deleted files match.' : 'Trash is empty.') : (filterText ? 'No files match.' : 'No files yet.');
        fileTree.append(p);
      }
    } catch (error) { showError(error); }
    element<HTMLButtonElement>('[data-action="trash-view"]').textContent = showingTrash ? 'Back to files' : 'Open Trash';
  }
  async function moveEntryWithLinkUpdates(entry: Entry, parentId: EntryId | null, name: string): Promise<Entry> {
    const oldEntries = entries.map(item => ({ ...item }));
    const oldRecords = knowledge.records();
    const affectedIds: EntryId[] = entry.kind === 'markdown'
      ? [entry.id]
      : new VaultTree(oldEntries).descendants(entry.id)
          .filter(item => item.kind === 'markdown' && item.deletedAt === null)
          .map(item => item.id);

    const moved = await repository.move(entry.id, parentId, name, entry.localVersion);
    const locationChanged = moved.parentId !== entry.parentId || moved.name !== entry.name;
    await refresh();

    if (autoUpdateLinks && locationChanged && affectedIds.length) {
      for (const targetEntryId of affectedIds) {
        await updateInboundLinksAfterMove({
          targetEntryId,
          oldEntries,
          newEntries: entries,
          oldRecords,
          repository,
          index: knowledge,
        });
      }
      await refresh();
    }
    return entries.find(item => item.id === moved.id) ?? moved;
  }

  async function moveByDrop(sourceId: EntryId, parentId: EntryId | null): Promise<void> {
    const source = entries.find(entry => entry.id === sourceId && entry.deletedAt === null);
    if (!source) return;
    if (selected?.id === source.id && saver) {
      await saver.flush();
      await saver.close();
      saver = undefined;
      await refreshKnowledgeEntry(source.id);
    }
    const current = entries.find(entry => entry.id === sourceId) ?? source;
    const wasSelected = selected?.id === source.id;
    const moved = await moveEntryWithLinkUpdates(current, parentId, current.name);
    if (wasSelected) selected = moved;
    if (parentId) collapsed.delete(parentId);
    if (wasSelected) await openEntry(moved.id);
  }
  async function openRecovery(): Promise<void> {
    if (!vault) return;
    // Recovery inspection remains available even when the current canonical writer failed.
    try { await saver?.flush(); } catch { /* The error banner and current draft remain visible. */ }
    recoveryDrafts = (await repository.listRecoveryDrafts(vault.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    recoverySelect.replaceChildren();
    for (const draft of recoveryDrafts) {
      const source = entries.find(entry => entry.id === draft.entryId);
      recoverySelect.add(new Option(`${source?.name ?? 'Unavailable source'} \u00b7 ${new Date(draft.createdAt).toLocaleString()}`, draft.id));
    }
    showRecoverySelection(); recoveryDialog.showModal(); recoverySelect.focus();
  }
  function showRecoverySelection(): void {
    const draft = recoveryDrafts.find(item => item.id === recoverySelect.value);
    recoveryText.value = draft?.text ?? '';
    element<HTMLElement>('.recovery-meta').textContent = draft ? `Base version ${draft.baseVersion} \u00b7 ${draft.reason} \u00b7 ${draft.text.length.toLocaleString()} characters` : 'There are no preserved drafts in this vault.';
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-recovery-action]')) button.disabled = !draft;
  }
  function renderInfo(): void {
    const info = element<HTMLElement>('.file-info'); info.replaceChildren();
    const data = selected ? [['Format', selected.kind === 'markdown' ? 'Markdown (.md)' : 'Folder'], ['Local version', String(selected.localVersion)], ['Storage', 'This browser only'], ['File ID', selected.id]] : [['Files', String(entries.filter(entry => entry.kind === 'markdown' && !entry.deletedAt).length)], ['Folders', String(entries.filter(entry => entry.kind === 'directory' && !entry.deletedAt).length)], ['Cloud sync', 'Not active']];
    for (const [key, value] of data) { const dt = document.createElement('dt'); dt.textContent = key!; const dd = document.createElement('dd'); dd.textContent = value!; info.append(dt, dd); }
  }
  function highlightCurrentOutline(): void {
    const record = selected?.kind === 'markdown' ? knowledge.get(selected.id) : undefined;
    const current = record?.headings.filter(heading => heading.from <= editorStats.position).at(-1);
    for (const button of root.querySelectorAll<HTMLButtonElement>('.outline-item')) {
      button.classList.toggle('current', current !== undefined && button.dataset.outlineOffset === String(current.from));
      if (current !== undefined && button.dataset.outlineOffset === String(current.from)) button.setAttribute('aria-current', 'location');
      else button.removeAttribute('aria-current');
    }
  }

  function renderKnowledgePanels(): void {
    const outlineList = element<HTMLElement>('.outline-list');
    const backlinkList = element<HTMLElement>('.backlink-list');
    const unlinkedList = element<HTMLElement>('.unlinked-list');
    outlineList.replaceChildren();
    backlinkList.replaceChildren();
    unlinkedList.replaceChildren();

    const record = selected?.kind === 'markdown' ? knowledge.get(selected.id) : undefined;
    const outlineCount = element<HTMLElement>('.outline-count');
    const backlinkCount = element<HTMLElement>('.backlink-count');

    if (!selected || selected.kind !== 'markdown' || !record) {
      outlineCount.textContent = '';
      backlinkCount.textContent = '';
      const emptyOutline = document.createElement('p');
      emptyOutline.className = 'panel-empty';
      emptyOutline.textContent = 'Open a Markdown note to see its outline.';
      outlineList.append(emptyOutline);
      const emptyBacklinks = document.createElement('p');
      emptyBacklinks.className = 'panel-empty';
      emptyBacklinks.textContent = 'No note selected.';
      backlinkList.append(emptyBacklinks);
      return;
    }

    outlineCount.textContent = String(record.headings.length);
    for (const heading of record.headings) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'outline-item';
      button.style.paddingInlineStart = `${Math.max(0, heading.depth - 1) * 10 + 4}px`;
      button.dataset.outlineOffset = String(heading.from);
      button.textContent = heading.text;
      button.title = `H${heading.depth} · ${heading.text}`;
      outlineList.append(button);
    }
    if (!record.headings.length) {
      const empty = document.createElement('p');
      empty.className = 'panel-empty';
      empty.textContent = 'No headings.';
      outlineList.append(empty);
    }

    const backlinks = knowledge.backlinks(selected.id, entries);
    backlinkCount.textContent = String(backlinks.length);
    const backlinkGroups = new Map<EntryId, typeof backlinks>();
    for (const mention of backlinks) {
      const group = backlinkGroups.get(mention.sourceEntryId) ?? [];
      group.push(mention);
      backlinkGroups.set(mention.sourceEntryId, group);
    }
    for (const [sourceEntryId, mentions] of [...backlinkGroups.entries()].slice(0, 40)) {
      const source = entries.find(entry => entry.id === sourceEntryId);
      if (!source) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'backlink-item';
      button.dataset.backlinkEntry = source.id;
      const title = document.createElement('span');
      title.className = 'backlink-title';
      title.textContent = source.name.replace(/\.md$/i, '');
      const detail = document.createElement('span');
      detail.className = 'backlink-detail';
      const examples = mentions.slice(0, 2).map(mention => mention.reference.raw).join(' · ');
      detail.textContent = mentions.length > 1 ? `${mentions.length} mentions · ${examples}` : examples;
      button.append(title, detail);
      backlinkList.append(button);
    }
    if (!backlinks.length) {
      const empty = document.createElement('p');
      empty.className = 'panel-empty';
      empty.textContent = 'No linked mentions.';
      backlinkList.append(empty);
    }

    const unlinked = knowledge.unlinkedMentions(selected.id, entries);
    for (const mention of unlinked.slice(0, 30)) {
      const source = entries.find(entry => entry.id === mention.sourceEntryId);
      if (!source) continue;
      const row = document.createElement('div');
      row.className = 'unlinked-item';
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'unlinked-open';
      open.dataset.backlinkEntry = source.id;
      open.textContent = `${source.name.replace(/\.md$/i, '')}: ${mention.term}`;
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'unlinked-link';
      link.dataset.unlinkedSource = source.id;
      link.dataset.unlinkedFrom = String(mention.from);
      link.dataset.unlinkedTo = String(mention.to);
      link.dataset.unlinkedTerm = mention.term;
      link.textContent = 'Link';
      row.append(open, link);
      unlinkedList.append(row);
    }
    if (!unlinked.length) {
      const empty = document.createElement('p');
      empty.className = 'panel-empty';
      empty.textContent = 'No unlinked mentions.';
      unlinkedList.append(empty);
    }
    highlightCurrentOutline();
  }

  async function refreshKnowledgeEntry(entryId: EntryId): Promise<void> {
    const file = await repository.read(entryId);
    if (file.entry.kind === 'markdown' && file.content && file.entry.deletedAt === null) {
      await knowledge.upsert(file.entry, file.content.text);
      await refreshSearchEntry(entryId);
    } else if (searchReady) {
      await refreshSearchEntry(entryId);
    }
    renderKnowledgePanels();
  }

  function fragmentOffset(resolution: WikiResolution): number | null {
    if (resolution.status !== 'resolved') return null;
    const record = knowledge.get(resolution.entryId);
    if (!record) return null;
    if (resolution.block) return record.blocks.find(block => block.id.normalize('NFC').toLocaleLowerCase() === resolution.block!.normalize('NFC').toLocaleLowerCase())?.from ?? null;
    if (resolution.heading) return record.headings.find(heading => heading.text.normalize('NFC').toLocaleLowerCase() === resolution.heading!.normalize('NFC').toLocaleLowerCase())?.from ?? null;
    return null;
  }

  async function revealResolution(resolution: WikiResolution): Promise<void> {
    if (resolution.status !== 'resolved' || (!resolution.heading && !resolution.block)) return;
    const offset = fragmentOffset(resolution);
    if (offset === null) return;
    if (editorMode === 'reading' && resolution.heading) {
      const wanted = resolution.heading.normalize('NFC').toLocaleLowerCase();
      const heading = [...readingView.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')]
        .find(item => (item.textContent ?? '').trim().normalize('NFC').toLocaleLowerCase() === wanted);
      if (heading) { heading.scrollIntoView({ block: 'start' }); return; }
    }
    if (editorMode === 'reading') await setEditorMode('live');
    editor.revealOffset(offset);
  }

  async function createLinkedNote(rawTarget: string, sourceEntryId: EntryId): Promise<void> {
    if (!vault) return;
    const hash = rawTarget.indexOf('#');
    const notePart = (hash >= 0 ? rawTarget.slice(0, hash) : rawTarget).trim().replace(/\.md$/iu, '');
    if (!notePart) throw new VaultError('NOT_FOUND', 'The linked heading or block does not exist in this note.');

    const segments = notePart.split('/').map(segment => segment.trim()).filter(Boolean);
    if (!segments.length || segments.some(segment => segment === '.' || segment === '..')) {
      throw new VaultError('INVALID_NAME', 'This unresolved link is not a safe note path.');
    }

    let parentId: EntryId | null = null;
    if (segments.length === 1) {
      parentId = entries.find(entry => entry.id === sourceEntryId)?.parentId ?? null;
    } else {
      for (const segment of segments.slice(0, -1)) {
        const existing = entries.find(entry => entry.kind === 'directory' && entry.deletedAt === null && entry.parentId === parentId && entry.name.normalize('NFC').toLocaleLowerCase() === segment.normalize('NFC').toLocaleLowerCase());
        if (existing) parentId = existing.id;
        else {
          const folder = await repository.createEntry(vault.id, parentId, segment, 'directory');
          parentId = folder.id;
          entries.push(folder);
        }
      }
    }

    const label = segments.at(-1)!;
    const name = await ask('Create linked note', 'Note name', label);
    if (name === null) return;
    const created = await repository.createEntry(vault.id, parentId, name, 'markdown');
    await refresh();
    await openEntry(created.id);
  }

  async function activateWikiTarget(target: string, sourceEntryId: EntryId): Promise<void> {
    const resolution = knowledge.resolveRaw(target, sourceEntryId, entries);
    if (resolution.status === 'ambiguous') {
      throw new VaultError('COLLISION', 'This Wiki link is ambiguous. Use a folder-qualified path to choose the intended note.');
    }
    if (resolution.status === 'unresolved') {
      await createLinkedNote(target, sourceEntryId);
      return;
    }
    await openEntry(resolution.entryId);
    await revealResolution(resolution);
  }

  async function convertUnlinkedMention(sourceEntryId: EntryId, from: number, to: number, expectedTerm: string): Promise<void> {
    if (!selected || selected.kind !== 'markdown') return;
    if (saver) await saver.flush();
    const targetId = selected.id;
    const source = await repository.read(sourceEntryId);
    if (!source.content || source.entry.deletedAt !== null) throw new VaultError('NOT_FOUND', 'The source note is unavailable.');
    const visible = source.content.text.slice(from, to);
    if (visible.normalize('NFC').toLocaleLowerCase() !== expectedTerm.normalize('NFC').toLocaleLowerCase()) {
      throw new VaultError('STALE_WRITE', 'The unlinked mention changed. Refresh backlinks before converting it.');
    }
    const canonical = canonicalWikiNote(targetId, entries);
    if (!canonical) throw new VaultError('NOT_FOUND', 'The target note is unavailable.');
    const replacement = visible.normalize('NFC').toLocaleLowerCase() === canonical.normalize('NFC').toLocaleLowerCase()
      ? `[[${canonical}]]`
      : `[[${canonical}|${visible}]]`;
    const text = source.content.text.slice(0, from) + replacement + source.content.text.slice(to);
    const saved = await repository.saveMarkdown(source.entry.id, text, source.entry.localVersion);
    await knowledge.upsert(saved, text);
    const at = entries.findIndex(entry => entry.id === saved.id);
    if (at >= 0) entries[at] = saved;
    dirtyIds.add(saved.id);
    renderTree();
    renderKnowledgePanels();
  }

  async function renderReadingCurrent(): Promise<void> {
    if (!selected || selected.kind !== 'markdown' || editorMode !== 'reading') return;
    const generation = ++renderGeneration;
    readingView.dataset.loading = 'true';
    const rootEntryId = selected.id;
    const rendered = await renderMarkdown(saver?.draft ?? editor.getText(), {
      sourceEntryId: rootEntryId,
      stack: [rootEntryId],
      wiki: {
        status(target, sourceEntryId) {
          const source = entries.find(entry => entry.id === sourceEntryId) ? sourceEntryId as EntryId : rootEntryId;
          return knowledge.resolveRaw(target, source, entries).status;
        },
        async load(target, sourceEntryId) {
          const source = entries.find(entry => entry.id === sourceEntryId) ? sourceEntryId as EntryId : rootEntryId;
          const resolution = knowledge.resolveRaw(target, source, entries);
          if (resolution.status !== 'resolved') return null;
          const file = await repository.read(resolution.entryId);
          if (!file.content || file.entry.deletedAt !== null) return null;
          const markdown = extractFragment(file.content.text, knowledge.get(resolution.entryId), {
            heading: resolution.heading,
            block: resolution.block,
          });
          return markdown === null ? null : { entryId: resolution.entryId, markdown };
        },
      },
    });
    if (generation !== renderGeneration || editorMode !== 'reading' || selected?.kind !== 'markdown') return;
    readingView.replaceChildren(rendered);
    delete readingView.dataset.loading;
  }
  async function syncEditorSurface(): Promise<void> {
    const noteOpen = selected?.kind === 'markdown';
    editorHost.hidden = !noteOpen || editorMode === 'reading';
    readingView.hidden = !noteOpen || editorMode !== 'reading';
    element<HTMLElement>('.editor-toolbar').hidden = !noteOpen || editorMode === 'reading' || selected?.deletedAt !== null;
    editor.setMode(editorMode === 'source' ? 'source' : 'live');
    editor.setLineNumbers(lineNumbers);
    editor.setReadOnly(!noteOpen || selected?.deletedAt !== null || !saver || editorMode === 'reading');
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-editor-mode]')) {
      const active = button.dataset.editorMode === editorMode;
      button.setAttribute('aria-pressed', String(active));
      button.classList.toggle('active', active);
      button.disabled = !noteOpen;
    }
    const lines = element<HTMLButtonElement>('[data-editor-action="line-numbers"]');
    lines.setAttribute('aria-pressed', String(lineNumbers));
    lines.classList.toggle('active', lineNumbers);
    if (noteOpen && editorMode === 'reading') await renderReadingCurrent();
    else { renderGeneration++; readingView.replaceChildren(); delete readingView.dataset.loading; }
  }
  async function setEditorMode(mode: EditorMode): Promise<void> {
    if (!selected || selected.kind !== 'markdown') return;
    if (mode === 'reading' && saver) await saver.flush();
    editorMode = mode;
    await setting('editorMode', mode);
    await syncEditorSurface();
    if (mode !== 'reading') editor.focus();
  }
  async function openEntry(id: EntryId, preserveCurrent = false): Promise<void> {
    // Validate the destination before closing a functioning editor. Failed navigation
    // must not leave the previous editor attached to a closed save coordinator.
    const previousEntryId = selected?.kind === 'markdown' ? selected.id : undefined;
    if (saver) { try { await saver.flush(); } catch (error) { if (!preserveCurrent) throw error; } }
    const item = await repository.read(id);
    const targetPath = pathOf(id);
    if (saver) { if (preserveCurrent) await saver.closeToRecovery(); else await saver.close(); }
    saver = undefined;
    if (previousEntryId && entries.some(entry => entry.id === previousEntryId && entry.deletedAt === null)) {
      await refreshKnowledgeEntry(previousEntryId);
    }
    selected = item.entry;
    errorBox.hidden = true;
    element<HTMLElement>('[data-action="reopen"]').hidden = true;
    element<HTMLElement>('[data-action="retry-save"]').hidden = true;
    element<HTMLElement>('.empty-state').hidden = true;
    editor.setReadOnly(selected.deletedAt !== null);
    element<HTMLElement>('.folder-message').hidden = selected.kind !== 'directory';
    element<HTMLElement>('.folder-message').textContent = selected.deletedAt ? 'This folder is in Trash. Restore its parent first, then restore the folder.' : 'Folder selected. New files will be created inside this folder.';
    element<HTMLElement>('.breadcrumb').textContent = targetPath;
    element<HTMLElement>('.save-status').textContent = selected.deletedAt ? 'In Trash \u00b7 read only' : 'Saved locally \u00b7 not synced';
    for (const action of ['rename', 'move', 'duplicate', 'delete']) element<HTMLButtonElement>(`[data-action="${action}"]`).disabled = selected.deletedAt !== null;
    element<HTMLElement>('[data-action="restore"]').hidden = selected.deletedAt === null;
    element<HTMLButtonElement>('[data-action="export-draft"]').disabled = selected.kind !== 'markdown';
    element<HTMLButtonElement>('[data-action="checkpoint"]').disabled = selected.kind !== 'markdown' || selected.deletedAt !== null;
    if (selected.kind === 'markdown' && item.content) {
      editor.setText(item.content.text);
      if (selected.deletedAt === null) {
        const opened = selected; const draftId = `editor:${crypto.randomUUID()}`;
        saver = new SaveCoordinator(repository, selected.id, { version: selected.localVersion, text: item.content.text }, (state, updated) => {
          if (disposed || selected?.id !== opened.id) return;
          element<HTMLElement>('.save-status').textContent = state.kind === 'saving' ? 'Saving locally\u2026' : state.kind === 'error'
            ? state.recovery === 'stored' ? 'Draft preserved \u00b7 canonical save blocked' : state.recovery === 'pending' ? 'Preserving recovery draft\u2026' : 'Not saved \u00b7 export your draft'
            : 'Saved locally \u00b7 not synced';
          if (updated) { selected = updated; const at = entries.findIndex(entry => entry.id === updated.id); if (at >= 0) entries[at] = updated; renderInfo(); void refreshKnowledgeEntry(updated.id).catch(showError); }
          element<HTMLElement>('[data-action="retry-save"]').hidden = state.kind !== 'error' || !saver?.canRetry;
          if (state.kind === 'error') {
            showError(state.error);
            if (state.recovery === 'failed') errorBox.textContent += ' The recovery write also failed. Export the current draft before closing this window.';
            element<HTMLElement>('[data-action="reopen"]').hidden = false;
          } else if (state.kind === 'saved-local') { errorBox.hidden = true; element<HTMLElement>('[data-action="reopen"]').hidden = true; }
        }, { persistRecovery: (text, baseVersion) => repository.preserveDraft({ id: draftId, entryId: opened.id, vaultId: opened.vaultId, baseVersion, text }) });
      }
    }
    await syncEditorSurface();
    renderTree(); renderInfo(); renderKnowledgePanels(); updateCounts();
    await setting('lastVault', vault?.id);
    await setting('lastEntry', selected.id);
    if (selected.kind === 'markdown' && selected.deletedAt === null) await rememberRecent(selected.id);
    workspace.dataset.sidebarOpen = 'false';
    workspace.dataset.knowledgeOpen = 'false';
    element<HTMLElement>('[data-action="files"]').setAttribute('aria-expanded', 'false');
  }
  function updateCounts(): void {
    element<HTMLElement>('.counts').textContent = selected?.kind === 'markdown' ? `${editorStats.words.toLocaleString()} words \u00b7 ${editorStats.characters.toLocaleString()} characters \u00b7 Ln ${editorStats.line}, Col ${editorStats.column}${editorStats.selectedWords ? ` \u00b7 ${editorStats.selectedWords} selected` : ''}` : '';
  }
  async function clearSelection(): Promise<void> {
    const previousEntryId = selected?.kind === 'markdown' ? selected.id : undefined;
    if (saver) await saver.close();
    saver = undefined;
    if (previousEntryId && entries.some(entry => entry.id === previousEntryId && entry.deletedAt === null)) await refreshKnowledgeEntry(previousEntryId);
    selected = undefined; renderGeneration++; editorHost.hidden = true; readingView.hidden = true; readingView.replaceChildren(); editor.setReadOnly(true); editor.setText('');
    element<HTMLElement>('.empty-state').hidden = false;
    element<HTMLElement>('.folder-message').hidden = true;
    element<HTMLElement>('.breadcrumb').textContent = 'No file selected';
    element<HTMLElement>('.save-status').textContent = 'No file open';
    for (const action of ['reopen', 'retry-save']) element<HTMLElement>(`[data-action="${action}"]`).hidden = true;
    errorBox.hidden = true;
    for (const action of ['rename', 'move', 'duplicate', 'delete', 'export-draft', 'checkpoint']) element<HTMLButtonElement>(`[data-action="${action}"]`).disabled = true;
    element<HTMLElement>('[data-action="restore"]').hidden = true;
    await syncEditorSurface();
    updateCounts();
  }

  registry.register({ id: 'vault.create', label: 'Create vault', run: async () => {
    const name = await ask('Create a vault', 'Vault name'); if (name === null) return;
    await clearSelection(); vault = await repository.createVault(name); preferencesVaultId = undefined; showingTrash = false; filterText = ''; await refresh(); await setting('lastVault', vault.id);
  } });
  for (const kind of ['markdown', 'directory'] as const) registry.register({ id: kind === 'markdown' ? 'file.create' : 'folder.create', label: kind === 'markdown' ? 'Create Markdown note' : 'Create folder', enabled: () => !!vault, run: async () => {
    if (!vault) return;
    const name = await ask(kind === 'markdown' ? 'Create a Markdown note' : 'Create a folder', 'Name'); if (name === null) return;
    if (saver) await saver.flush();
    const entry = await repository.createEntry(vault.id, parentForNew(), name, kind);
    showingTrash = false; await refresh(); await openEntry(entry.id);
    if (kind === 'markdown') editor.focus();
  } });
  registry.register({ id: 'vault.export', label: 'Export active Markdown ZIP', enabled: () => !!vault, run: async () => {
    if (!vault) return; if (saver) await saver.flush();
    const bytes = zipStore(markdownFiles(await repository.snapshot(vault.id)));
    download(`${vault.name}.zip`, new Uint8Array(bytes).buffer, 'application/zip');
  } });
  registry.register({ id: 'vault.backup', label: 'Export recovery backup', enabled: () => !!vault, run: async () => {
    if (!vault) return;
    // A failed writer must not prevent exporting previously durable notes and recovery drafts.
    if (saver?.hasUnsavedChanges) downloadDraft();
    download(`${vault.name}-recovery.json`, JSON.stringify(await repository.snapshot(vault.id), null, 2), 'application/json');
  } });

  root.addEventListener('click', event => {
    const panelButton = (event.target as Element).closest<HTMLButtonElement>('[data-sidebar-panel]');
    if (panelButton?.dataset.sidebarPanel) {
      const panel = panelButton.dataset.sidebarPanel;
      if (panel === 'files' || panel === 'search' || panel === 'tags') switchSidebarPanel(panel);
      return;
    }

    const searchResult = (event.target as Element).closest<HTMLButtonElement>('[data-search-entry]');
    if (searchResult?.dataset.searchEntry) {
      const fromValue = searchResult.dataset.searchFrom === undefined ? null : Number(searchResult.dataset.searchFrom);
      const toValue = searchResult.dataset.searchTo === undefined ? null : Number(searchResult.dataset.searchTo);
      const from = fromValue !== null && Number.isFinite(fromValue) ? fromValue : null;
      const to = toValue !== null && Number.isFinite(toValue) ? toValue : null;
      perform(() => openSearchResult(searchResult.dataset.searchEntry as EntryId, from, to));
      return;
    }

    const facetButton = (event.target as Element).closest<HTMLButtonElement>('[data-search-query]');
    if (facetButton?.dataset.searchQuery) {
      globalSearch.value = facetButton.dataset.searchQuery;
      switchSidebarPanel('search');
      void runGlobalSearch();
      return;
    }

    const quickButton = (event.target as Element).closest<HTMLButtonElement>('[data-quick-entry]');
    if (quickButton?.dataset.quickEntry) {
      const entryId = quickButton.dataset.quickEntry as EntryId;
      quickDialog.close();
      perform(() => openEntry(entryId));
      return;
    }

    const targetElement = (event.target as Element).closest<HTMLElement>('[data-vault-target]');
    if (targetElement && readingView.contains(targetElement)) {
      event.preventDefault();
      const source = targetElement.dataset.vaultSource as EntryId | undefined;
      const sourceEntryId = entries.some(entry => entry.id === source) ? source! : selected?.id;
      if (sourceEntryId && targetElement.dataset.vaultTarget) perform(() => activateWikiTarget(targetElement.dataset.vaultTarget!, sourceEntryId));
      return;
    }

    const button = (event.target as Element).closest<HTMLButtonElement>('button');
    if (!button || button.disabled) return;
    if (button.dataset.outlineOffset) {
      const offset = Number(button.dataset.outlineOffset);
      if (Number.isFinite(offset)) perform(async () => {
        if (editorMode === 'reading') await setEditorMode('live');
        editor.revealOffset(offset);
      });
      return;
    }
    if (button.dataset.backlinkEntry) {
      perform(() => openEntry(button.dataset.backlinkEntry as EntryId));
      return;
    }
    if (button.dataset.unlinkedSource) {
      const from = Number(button.dataset.unlinkedFrom);
      const to = Number(button.dataset.unlinkedTo);
      const term = button.dataset.unlinkedTerm ?? '';
      if (Number.isInteger(from) && Number.isInteger(to)) perform(() => convertUnlinkedMention(button.dataset.unlinkedSource as EntryId, from, to, term));
      return;
    }
    if (button.dataset.recoveryAction) {
      const draft = recoveryDrafts.find(item => item.id === recoverySelect.value); if (!draft) return;
      if (button.dataset.recoveryAction === 'download') { download('recovery-draft.md', draft.text, 'text/markdown;charset=utf-8'); return; }
      perform(async () => {
        const source = entries.find(item => item.id === draft.entryId);
        const name = await ask('Recover as a new note', 'New filename', `${source?.name.replace(/\.md$/i, '') ?? 'Note'} recovered`);
        if (name === null) return;
        const recovered = await repository.recoverDraft(draft.id, name);
        showingTrash = false; await refresh(); await openEntry(recovered.id, true); recoveryDialog.close(); editor.focus();
      }); return;
    }
    if (button.dataset.command) { perform(async () => { await registry.execute(button.dataset.command!); }); return; }
    if (button.dataset.editorMode) {
      const mode = button.dataset.editorMode;
      if (mode === 'source' || mode === 'live' || mode === 'reading') perform(() => setEditorMode(mode));
      return;
    }
    if (button.dataset.editorCommand) {
      if (editorMode !== 'reading') editor.run(button.dataset.editorCommand as MarkdownCommand);
      return;
    }
    if (button.dataset.editorAction === 'search') { editor.openSearch(); return; }
    if (button.dataset.editorAction === 'line-numbers') {
      lineNumbers = !lineNumbers; editor.setLineNumbers(lineNumbers);
      button.setAttribute('aria-pressed', String(lineNumbers)); button.classList.toggle('active', lineNumbers);
      void setting('lineNumbers', lineNumbers).catch(showError); return;
    }
    const action = button.dataset.action;
    if (!action) return;
    if (action === 'files') { const open = workspace.dataset.sidebarOpen !== 'true'; workspace.dataset.sidebarOpen = String(open); button.setAttribute('aria-expanded', String(open)); return; }
    if (action === 'quick-switcher') { void openQuickSwitcher().catch(showError); return; }
    if (action === 'knowledge-panel') { workspace.dataset.knowledgeOpen = String(workspace.dataset.knowledgeOpen !== 'true'); return; }
    if (action === 'export-draft') { downloadDraft(); return; }
    perform(async () => {
      if (action === 'recovery') { await openRecovery(); return; }
      if (action === 'vault-rename') {
        if (!vault) return;
        const name = await ask('Rename vault', 'Vault name', vault.name); if (name === null) return;
        vault = await repository.renameVault(vault.id, name); await refresh(); return;
      }
      if (action === 'retry-save') { await saver?.retry(); return; }
      if (action === 'reload') { await refresh(); return; }
      if (action === 'rebuild-search') { queueSearchRebuild(true); return; }
      if (action === 'trash-view') { await clearSelection(); showingTrash = !showingTrash; await refresh(); return; }
      if (action === 'persist') {
        const persistent = navigator.storage?.persist ? await navigator.storage.persist() : false;
        element<HTMLElement>('.storage-message').textContent = persistent ? 'Persistent storage granted. Export backups are still recommended.' : 'Persistent storage was not granted. Export backups regularly.'; return;
      }
      if (!selected) return;
      if (action === 'reopen') { await openEntry(selected.id, true); return; }
      if (saver) await saver.flush();
      if (action === 'checkpoint') { await repository.checkpoint(selected.id); element<HTMLElement>('.save-status').textContent = 'Local checkpoint saved'; return; }
      if (action === 'duplicate') {
        const source = selected;
        const duplicate = await repository.duplicate(source.id, source.localVersion);
        if (saver) await saver.close(); saver = undefined; showingTrash = false; await refresh(); await openEntry(duplicate.id);
        if (duplicate.kind === 'markdown') editor.focus();
        return;
      }
      if (action === 'rename' || action === 'move') {
        const value = await ask(action === 'rename' ? 'Rename' : 'Move', action === 'rename' ? 'New name' : 'Destination folder', selected.name, action === 'move');
        if (value === null) return;
        const current = selected;
        if (saver) {
          await saver.close();
          saver = undefined;
          if (current.kind === 'markdown') await refreshKnowledgeEntry(current.id);
        }
        const moved = await moveEntryWithLinkUpdates(
          current,
          action === 'move' ? (value || null) as EntryId | null : current.parentId,
          action === 'rename' ? value : current.name,
        );
        selected = moved;
        await openEntry(moved.id);
      }
      if (action === 'delete') { await repository.trash(selected.id, selected.localVersion); if (saver) await saver.close(); saver = undefined; await clearSelection(); await refresh(); }
      if (action === 'restore') { await repository.restore(selected.id); const id = selected.id; showingTrash = false; await refresh(); await openEntry(id); }
    });
  }, { signal: abort.signal });
  globalSearch.addEventListener('input', () => { void runGlobalSearch(); }, { signal: abort.signal });
  tagFilter.addEventListener('input', renderFacets, { signal: abort.signal });
  quickInput.addEventListener('input', () => { void runQuickSwitcher().catch(showError); }, { signal: abort.signal });
  quickInput.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      quickSelection = Math.min(quickResults.length - 1, quickSelection + 1);
      renderQuickResults();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      quickSelection = Math.max(0, quickSelection - 1);
      renderQuickResults();
    } else if (event.key === 'Enter') {
      const result = quickResults[quickSelection];
      if (!result) return;
      event.preventDefault();
      quickDialog.close();
      perform(() => openEntry(result.entryId));
    }
  }, { signal: abort.signal });
  recoverySelect.addEventListener('change', showRecoverySelection, { signal: abort.signal });
  fileFilter.addEventListener('input', () => {
    filterText = fileFilter.value;
    renderTree();
    if (vault) void setting(`treeFilter:${vault.id}`, filterText).catch(showError);
  }, { signal: abort.signal });
  fileSort.addEventListener('change', () => {
    if (!isFileSort(fileSort.value)) return;
    sortMode = fileSort.value;
    renderTree();
    if (vault) void setting(`treeSort:${vault.id}`, sortMode).catch(showError);
  }, { signal: abort.signal });
  foldersFirstToggle.addEventListener('change', () => {
    foldersFirst = foldersFirstToggle.checked;
    renderTree();
    if (vault) void setting(`foldersFirst:${vault.id}`, foldersFirst).catch(showError);
  }, { signal: abort.signal });
  autoUpdateLinksToggle.addEventListener('change', () => {
    autoUpdateLinks = autoUpdateLinksToggle.checked;
    if (vault) void setting(`autoUpdateLinks:${vault.id}`, autoUpdateLinks).catch(showError);
  }, { signal: abort.signal });
  fileTree.addEventListener('dragover', event => {
    if (!draggedEntryId || showingTrash || (event.target as Element).closest('.file-row-shell')) return;
    event.preventDefault(); fileTree.classList.add('drop-root');
  }, { signal: abort.signal });
  fileTree.addEventListener('dragleave', event => {
    if (!fileTree.contains(event.relatedTarget as Node | null)) fileTree.classList.remove('drop-root');
  }, { signal: abort.signal });
  fileTree.addEventListener('drop', event => {
    if ((event.target as Element).closest('.file-row-shell')) return;
    event.preventDefault(); fileTree.classList.remove('drop-root');
    const sourceId = (draggedEntryId ?? event.dataTransfer?.getData('text/plain')) as EntryId | undefined;
    if (sourceId) perform(() => moveByDrop(sourceId, null));
  }, { signal: abort.signal });
  vaultSelect.addEventListener('change', () => {
    const id = vaultSelect.value;
    perform(async () => {
      try { await clearSelection(); } catch (error) { vaultSelect.value = vault?.id ?? ''; throw error; }
      vault = vaults.find(item => item.id === id); preferencesVaultId = undefined; showingTrash = false; filterText = ''; await refresh();  if (vault) await setting('lastVault', vault.id);
    });
  }, { signal: abort.signal });
  window.addEventListener('beforeunload', event => { if (saver?.hasUnsavedChanges) { event.preventDefault(); event.returnValue = ''; } }, { signal: abort.signal });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void saver?.flush().catch(showError); }, { signal: abort.signal });
  window.addEventListener('keydown', event => {
    if (quickDialog.open) return;
    if (dialog.open || recoveryDialog.open) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o' && !event.shiftKey) {
      event.preventDefault();
      void openQuickSwitcher().catch(showError);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      workspace.dataset.sidebarOpen = 'true';
      element<HTMLElement>('[data-action="files"]').setAttribute('aria-expanded', 'true');
      switchSidebarPanel('search');
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); perform(async () => registry.execute('file.create')); return; }
    if (event.key === 'F2' && selected && selected.deletedAt === null) { event.preventDefault(); element<HTMLButtonElement>('[data-action="rename"]').click(); return; }
    if ((event.key === 'Delete' || event.key === 'Backspace') && selected && selected.deletedAt === null && !editor.hasFocus() && document.activeElement !== fileFilter) {
      event.preventDefault(); element<HTMLButtonElement>('[data-action="delete"]').click();
    }
  }, { signal: abort.signal });

  const storedMode = await setting('editorMode');
  if (storedMode === 'source' || storedMode === 'live' || storedMode === 'reading') editorMode = storedMode;
  lineNumbers = (await setting('lineNumbers')) === true;
  editor.setLineNumbers(lineNumbers);
  const lastVault = await setting('lastVault');
  vaults = await repository.listVaults();
  vault = vaults.find(item => item.id === lastVault);
  await refresh();
  const lastEntry = await setting('lastEntry');
  const previous = entries.find(entry => entry.id === lastEntry && entry.deletedAt === null);
  if (previous) await openEntry(previous.id);

  return () => {
    disposed = true;
    abort.abort();
    if (dialog.open) dialog.close('cancel');
    if (recoveryDialog.open) recoveryDialog.close();
    if (quickDialog.open) quickDialog.close();
    searchIndex.close();
    editor.destroy();
    void (saver?.flush() ?? Promise.resolve()).catch(() => undefined).finally(() => db.close());
  };
}
