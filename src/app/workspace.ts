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

export interface WorkspaceOptions { databaseName?: string }
type EditorMode = 'source' | 'live' | 'reading';

/** Phase 2 browser workspace: Phase 1 storage plus the professional Markdown editor/rendering surface. */
export async function mountWorkspace(root: HTMLElement, options: WorkspaceOptions = {}): Promise<() => void> {
  const db = await openDatabase(options.databaseName);
  const repository = new LocalRepository(db);
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
  let collapsed = new Set<EntryId>();
  let filterText = '';
  let dirtyIds = new Set<EntryId>();
  let preferencesVaultId: VaultId | undefined;
  let draggedEntryId: EntryId | undefined;
  let editorMode: EditorMode = 'live';
  let lineNumbers = false;
  let editorStats: EditorStats = { characters: 0, words: 0, line: 1, column: 1, selectedWords: 0 };
  let renderGeneration = 0;
  let disposed = false;
  let chain: Promise<unknown> = Promise.resolve();

  // Static application markup only. All note titles and content use textContent/value below.
  root.innerHTML = `
    <div class="workspace" data-sidebar-open="false">
      <header class="topbar">
        <button class="mobile-toggle" data-action="files" aria-label="Toggle files" aria-expanded="false">\u2630</button>
        <div class="brand-mark" aria-hidden="true">V</div>
        <div class="brand"><strong>Vault</strong><span>Markdown knowledge workspace</span></div>
        <span class="stage">Phase 2 \u00b7 Markdown editor</span>
      </header>
      <aside class="sidebar" aria-label="Vault files">
        <label class="label" for="vault-vault">VAULT</label>
        <div class="vault-picker"><select id="vault-vault" aria-label="Active vault"></select><button data-action="vault-rename" aria-label="Rename active vault" title="Rename vault">\u270e</button></div>
        <button data-command="vault.create" class="quiet">+ New vault</button>
        <div class="section-heading"><span>EXPLORER</span><button data-action="reload" aria-label="Reload file list">\u21bb</button></div>
        <div class="button-row"><button data-command="file.create">+ Note</button><button data-command="folder.create">+ Folder</button></div>
        <input class="file-filter" type="search" placeholder="Filter files\u2026" aria-label="Filter files" />
        <div class="explorer-options"><select class="file-sort" aria-label="Sort files"><option value="name-asc">Name A\u2013Z</option><option value="name-desc">Name Z\u2013A</option><option value="modified-desc">Modified newest</option><option value="modified-asc">Modified oldest</option><option value="created-desc">Created newest</option><option value="created-asc">Created oldest</option></select><label><input class="folders-first" type="checkbox" checked /> Folders first</label></div>
        <div class="file-tree" role="tree" aria-label="Folders and notes" tabindex="0"></div>
        <button data-action="trash-view" class="quiet trash-button">Open Trash</button>
        <button data-action="recovery" class="quiet" disabled>Recovery drafts</button>
        <div class="mobile-exports"><button data-command="vault.export" disabled>Markdown ZIP</button><button data-command="vault.backup" disabled>Recovery backup</button></div>
        <div class="sidebar-bottom"><span class="local-dot"></span><span>Stored in this browser</span></div>
      </aside>
      <main class="main" aria-label="Markdown workspace">
        <div class="document-bar"><div class="breadcrumb">No file selected</div><div class="mode-switch" role="group" aria-label="Editor mode"><button type="button" data-editor-mode="source" aria-pressed="false">Source</button><button type="button" data-editor-mode="live" aria-pressed="true">Live Preview</button><button type="button" data-editor-mode="reading" aria-pressed="false">Reading</button></div></div>
        <div class="actions" aria-label="File actions">
          <button data-action="rename" disabled>Rename</button><button data-action="move" disabled>Move</button><button data-action="duplicate" disabled>Duplicate</button>
          <button data-action="delete" disabled>Move to Trash</button><button data-action="restore" hidden>Restore</button>
          <button data-action="export-draft" disabled>Export draft .md</button><button data-action="checkpoint" disabled>Checkpoint</button>
        </div>
        <div class="editor-toolbar" aria-label="Markdown formatting" hidden><button type="button" data-editor-command="heading" title="Heading">H</button><button type="button" data-editor-command="bold" title="Bold (Ctrl/Cmd+B)"><strong>B</strong></button><button type="button" data-editor-command="italic" title="Italic (Ctrl/Cmd+I)"><em>I</em></button><button type="button" data-editor-command="link" title="Link (Ctrl/Cmd+K)">Link</button><button type="button" data-editor-command="task">Task</button><button type="button" data-editor-command="bullet">List</button><button type="button" data-editor-command="inline-code">Code</button><button type="button" data-editor-command="code-block">Block</button><button type="button" data-editor-command="math-block">Math</button><button type="button" data-editor-command="callout">Callout</button><button type="button" data-editor-command="table">Table</button><button type="button" data-editor-action="search">Find</button><button type="button" data-editor-action="line-numbers" aria-pressed="false">Lines</button></div>
        <div class="error" role="alert" hidden></div>
        <div class="recovery-actions"><button data-action="retry-save" hidden>Retry local save</button><button data-action="reopen" hidden>Preserve draft and reopen saved version</button></div>
        <section class="empty-state">
          <p class="eyebrow">VAULT \u00b7 PHASE 2</p><h1>Markdown, without leaving the browser.</h1>
          <p>Create a vault and write in Source, Live Preview, or Reading mode. CodeMirror handles editing while ordinary Markdown remains the canonical note format.</p>
          <button data-command="vault.create" class="primary">Create a vault</button>
          <p class="fineprint">Cloud synchronization remains deliberately inactive. Phase 2 changes the editor and renderer, not the Phase 1 durability model.</p>
        </section>
        <div id="vault-editor" class="editor-host" hidden aria-label="Markdown source editor"></div>
        <article class="reading-view" hidden aria-label="Rendered Markdown"></article>
        <div class="folder-message" hidden></div>
      </main>
      <aside class="inspector" aria-label="Storage information">
        <p class="label">FILE INFORMATION</p><dl class="file-info"></dl>
        <div class="rule"></div><p class="label">DATA OWNERSHIP</p>
        <button data-command="vault.export" disabled>Markdown ZIP</button>
        <button data-command="vault.backup" disabled>Recovery backup</button>
        <p class="fineprint">ZIP exports active files and empty folders. Recovery backup also includes Trash, checkpoints and stored recovery drafts.</p>
        <div class="rule"></div><p class="label">CLOUD STATUS</p><p class="fineprint">Not configured. Nothing is uploaded. Signing in will not automatically upload local notes.</p>
        <button data-action="persist">Request persistent storage</button><p class="storage-message fineprint"></p>
      </aside>
      <footer class="statusbar"><span class="save-status" role="status">No file open</span><span class="counts"></span><span class="vault-counts"></span><span>IndexedDB \u00b7 schema 1</span></footer>
    </div>
    <dialog class="form-dialog" aria-labelledby="vault-dialog-title">
      <form method="dialog"><h2 id="vault-dialog-title"></h2><label class="dialog-label" for="vault-dialog-input"></label>
      <input id="vault-dialog-input" required autocomplete="off" /><select class="dialog-select" hidden aria-label="Destination folder"></select>
      <p class="dialog-help fineprint"></p><div class="dialog-buttons"><button value="cancel" formnovalidate>Cancel</button><button value="confirm" class="primary">Confirm</button></div></form>
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
  const fileTree = element<HTMLElement>('.file-tree');
  const pathOf = (id: EntryId): string => new VaultTree(entries).path(id);
  const editor = new MarkdownEditor(editorHost, {
    text: '', mode: 'live', readOnly: true, lineNumbers: false,
    onChange(text) { saver?.update(text); updateCounts(); },
    onStats(stats) { editorStats = stats; updateCounts(); },
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
  async function loadTreePreferences(): Promise<void> {
    if (!vault || preferencesVaultId === vault.id) return;
    const rawSort = await setting(`treeSort:${vault.id}`);
    const rawFoldersFirst = await setting(`foldersFirst:${vault.id}`);
    const rawCollapsed = await setting(`collapsedFolders:${vault.id}`);
    const rawFilter = await setting(`treeFilter:${vault.id}`);
    sortMode = isFileSort(rawSort) ? rawSort : 'name-asc';
    foldersFirst = typeof rawFoldersFirst === 'boolean' ? rawFoldersFirst : true;
    collapsed = new Set(Array.isArray(rawCollapsed) ? rawCollapsed.filter((id): id is EntryId => typeof id === 'string') : []);
    filterText = typeof rawFilter === 'string' ? rawFilter : '';
    preferencesVaultId = vault.id;
    fileSort.value = sortMode;
    foldersFirstToggle.checked = foldersFirst;
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
    } else {
      entries = [];
      dirtyIds.clear();
      preferencesVaultId = undefined;
      fileFilter.value = '';
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-command="file.create"],[data-command="folder.create"],[data-command="vault.export"],[data-command="vault.backup"],[data-action="vault-rename"]')) button.disabled = !vault;
    element<HTMLButtonElement>('[data-action="recovery"]').disabled = !vault;
    renderTree(); renderInfo(); updateVaultCounts();
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
  async function moveByDrop(sourceId: EntryId, parentId: EntryId | null): Promise<void> {
    const source = entries.find(entry => entry.id === sourceId && entry.deletedAt === null);
    if (!source) return;
    if (selected?.id === source.id && saver) await saver.flush();
    const current = entries.find(entry => entry.id === sourceId) ?? source;
    const moved = await repository.move(current.id, parentId, current.name, current.localVersion);
    if (selected?.id === moved.id) selected = moved;
    collapsed.delete(parentId as EntryId);
    await refresh();
    if (selected?.id === moved.id) await openEntry(moved.id);
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
  async function renderReadingCurrent(): Promise<void> {
    if (!selected || selected.kind !== 'markdown' || editorMode !== 'reading') return;
    const generation = ++renderGeneration;
    readingView.dataset.loading = 'true';
    const rendered = await renderMarkdown(saver?.draft ?? editor.getText());
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
    if (saver) { try { await saver.flush(); } catch (error) { if (!preserveCurrent) throw error; } }
    const item = await repository.read(id);
    const targetPath = pathOf(id);
    if (saver) { if (preserveCurrent) await saver.closeToRecovery(); else await saver.close(); }
    saver = undefined;
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
          if (updated) { selected = updated; const at = entries.findIndex(entry => entry.id === updated.id); if (at >= 0) entries[at] = updated; renderInfo(); }
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
    renderTree(); renderInfo(); updateCounts();
    await setting('lastVault', vault?.id);
    await setting('lastEntry', selected.id);
    workspace.dataset.sidebarOpen = 'false';
    element<HTMLElement>('[data-action="files"]').setAttribute('aria-expanded', 'false');
  }
  function updateCounts(): void {
    element<HTMLElement>('.counts').textContent = selected?.kind === 'markdown' ? `${editorStats.words.toLocaleString()} words \u00b7 ${editorStats.characters.toLocaleString()} characters \u00b7 Ln ${editorStats.line}, Col ${editorStats.column}${editorStats.selectedWords ? ` \u00b7 ${editorStats.selectedWords} selected` : ''}` : '';
  }
  async function clearSelection(): Promise<void> {
    if (saver) await saver.close();
    saver = undefined; selected = undefined; renderGeneration++; editorHost.hidden = true; readingView.hidden = true; readingView.replaceChildren(); editor.setReadOnly(true); editor.setText('');
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
    const button = (event.target as Element).closest<HTMLButtonElement>('button');
    if (!button || button.disabled) return;
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
        await repository.move(selected.id, action === 'move' ? (value || null) as EntryId | null : selected.parentId, action === 'rename' ? value : selected.name, selected.localVersion);
        const id = selected.id; if (saver) await saver.close(); saver = undefined; await refresh(); await openEntry(id);
      }
      if (action === 'delete') { await repository.trash(selected.id, selected.localVersion); if (saver) await saver.close(); saver = undefined; await clearSelection(); await refresh(); }
      if (action === 'restore') { await repository.restore(selected.id); const id = selected.id; showingTrash = false; await refresh(); await openEntry(id); }
    });
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
    if (dialog.open || recoveryDialog.open) return;
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
    editor.destroy();
    void (saver?.flush() ?? Promise.resolve()).catch(() => undefined).finally(() => db.close());
  };
}
