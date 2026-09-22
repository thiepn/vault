import { VaultError, explainError } from '../domain/errors.js';
import type { Entry, EntryId, RecoveryDraft, Vault, VaultId } from '../domain/model.js';
import { VaultTree } from '../domain/tree.js';
import { openDatabase } from '../storage/database.js';
import { LocalRepository } from '../storage/local-repository.js';
import { request, transact } from '../storage/idb.js';
import { SaveCoordinator } from '../services/save-coordinator.js';
import { vaultFiles, zipStore } from '../services/export.js';
import { CommandRegistry } from '../commands/registry.js';
import { isFileSort, trashRows, treeRows, type FileSort } from '../services/file-tree.js';
import { MarkdownEditor, type EditorStats, type MarkdownCommand } from '../editor/editor-controller.js';
import { renderMarkdown } from '../editor/renderer.js';
import { KnowledgeIndexService } from '../knowledge/index-service.js';
import { extractFragment } from '../knowledge/fragments.js';
import { updateInboundLinksAfterMove } from '../knowledge/link-updater.js';
import { canonicalWikiNote } from '../knowledge/resolver.js';
import type { KnowledgeTask, WikiResolution } from '../knowledge/types.js';
import { taskDateState, taskEffectiveDate, updateTaskMarkdown, type TaskPatch, type TaskPriority } from '../tasks/markdown.js';
import { SearchIndexClient } from '../search/client.js';
import type { QuickSwitchResult, SearchFacets, SearchInput, SearchResult, SearchStats } from '../search/types.js';
import { deleteFrontmatterProperty, inspectFrontmatter, rawValueForProperty, renameFrontmatterProperty, setFrontmatterProperty, valueForKind, type PropertyKind } from '../metadata/frontmatter.js';
import { addLocalDays, dateKey, renderTemplate, safeDailyFilename } from '../planning/templates.js';
import { buildCalendarMonth, dailyDateForEntry, dailyEntryForDate } from '../planning/calendar.js';
import { dynamicFieldLabel, parseDynamicQuery, runDynamicQuery } from '../queries/dynamic.js';
import { attachmentMediaKind, attachmentReferenceCounts, attachmentSuggestions, canonicalAttachmentTarget, formatAttachmentSize, resolveAttachmentTarget, type AttachmentMediaKind } from '../media/attachments.js';
import { updateAttachmentLinksAfterMove } from '../media/link-updater.js';
import { buildKnowledgeGraph, filterKnowledgeGraph, graphStats, localKnowledgeGraph, type GraphGroupMode, type GraphNode, type KnowledgeGraph } from '../graph/model.js';
import { GraphCanvasView } from '../graph/canvas-view.js';
import { boardFieldLabel, parseBoard, runBoard, type BoardCard, type BoardColumn, type BoardPlan } from '../boards/kanban.js';

export interface WorkspaceOptions { databaseName?: string }
type EditorMode = 'source' | 'live' | 'reading';

/** Phase 11 browser workspace: Markdown-native Kanban boards on the accepted Phase 1-10 foundation. */
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
  let searchIndexedVersions = new Map<EntryId, number>();
  let searchMetadata = new Map<EntryId, string>();
  let recentEntries: EntryId[] = [];
  let sidebarPanel: 'files' | 'search' | 'tags' | 'tasks' | 'media' | 'calendar' = 'files';
  let searchResults: SearchResult[] = [];
  let searchFacets: SearchFacets = { tags: [], properties: [] };
  let searchStats: SearchStats = { documents: 0, tokens: 0, tags: 0, properties: 0 };
  let quickResults: QuickSwitchResult[] = [];
  let quickSelection = 0;
  let draggedEntryId: EntryId | undefined;
  const pendingCursorOffsets = new Map<EntryId, number>();
  let editorMode: EditorMode = 'live';
  let lineNumbers = false;
  let editorStats: EditorStats = { characters: 0, words: 0, line: 1, column: 1, selectedWords: 0, position: 0 };
  let renderGeneration = 0;
  let propertyRenderTimer: number | undefined;
  let templatesFolderId: EntryId | null = null;
  let defaultTemplateId: EntryId | null = null;
  let dailyFolderId: EntryId | null = null;
  let dailyTemplateId: EntryId | null = null;
  let dailyFormat = 'YYYY-MM-DD';
  let folderTemplates: Record<string, string> = {};
  let calendarCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1, 12, 0, 0, 0);
  let calendarSelectedKey = dateKey(new Date());
  let taskStatusFilter: 'open' | 'done' | 'all' = 'open';
  let taskDateFilter: 'all' | 'overdue' | 'today' | 'upcoming' | 'undated' = 'all';
  let taskPriorityFilter: 'all' | TaskPriority | 'none' = 'all';
  let taskGroup: 'date' | 'note' | 'priority' | 'none' = 'date';
  let taskFilterText = '';
  let attachmentPolicy: 'folder' | 'note-folder' = 'folder';
  let attachmentFolderId: EntryId | null = null;
  const attachmentObjectUrls = new Map<EntryId, string>();
  let graphOpen = false;
  let graphMode: 'full' | 'local' = 'full';
  let graphDepth = 2;
  let graphGroupMode: GraphGroupMode = 'none';
  let graphGroupProperty = '';
  let graphSearchText = '';
  let graphTagText = '';
  let graphPropertyText = '';
  let graphOrphanOnly = false;
  let graphIncludeAttachments = true;
  let graphModel: KnowledgeGraph = { nodes: [], edges: [], unresolvedReferences: 0, ambiguousReferences: 0 };
  let graphBaseModel: KnowledgeGraph | null = null;
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
        <button type="button" class="graph-toggle" data-action="graph-open" aria-label="Open knowledge graph" title="Knowledge Graph">Graph</button>
        <button type="button" class="quick-toggle" data-action="quick-switcher" aria-label="Open Quick Switcher" title="Quick Switcher">\u2315</button>
        <span class="stage">Phase 11 \u00b7 Boards</span>
      </header>
      <aside class="sidebar" aria-label="Vault files">
        <label class="label" for="vault-vault">VAULT</label>
        <div class="vault-picker"><select id="vault-vault" aria-label="Active vault"></select><button data-action="vault-rename" aria-label="Rename active vault" title="Rename vault">\u270e</button></div>
        <button data-command="vault.create" class="quiet">+ New vault</button>
        <div class="sidebar-tabs" role="tablist" aria-label="Vault navigation"><button type="button" role="tab" data-sidebar-panel="files" aria-selected="true">Files</button><button type="button" role="tab" data-sidebar-panel="search" aria-selected="false">Search</button><button type="button" role="tab" data-sidebar-panel="tags" aria-selected="false">Tags</button><button type="button" role="tab" data-sidebar-panel="tasks" aria-selected="false">Tasks</button><button type="button" role="tab" data-sidebar-panel="media" aria-selected="false">Media</button><button type="button" role="tab" data-sidebar-panel="calendar" aria-selected="false">Calendar</button></div>
        <section class="sidebar-panel files-panel" data-panel="files">
          <div class="section-heading"><span>EXPLORER</span><button data-action="reload" aria-label="Reload file list">\u21bb</button></div>
          <div class="button-row"><button data-command="file.create">+ Note</button><button data-command="folder.create">+ Folder</button><button type="button" data-action="attachment-upload">+ Media</button></div><button type="button" class="quiet create-template-note" data-action="create-from-template">+ Note from template</button>
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
          <p class="search-help">Try words, "exact phrase", tag:#math, property:status=active, task:open, task:overdue, task:recurring, AND/OR/NOT.</p>
          <p class="search-status" role="status">Search index is preparing\u2026</p>
          <div class="search-results" role="list" aria-label="Search results"></div>
        </section>
        <section class="sidebar-panel tags-panel" data-panel="tags" hidden>
          <div class="section-heading"><span>TAGS & PROPERTIES</span></div>
          <input class="tag-filter" type="search" placeholder="Filter tags/properties\u2026" aria-label="Filter tags and properties" />
          <div class="facet-heading">TAGS</div><div class="tag-list"></div>
          <div class="facet-heading">PROPERTIES</div><div class="property-list"></div>
        </section>
        <section class="sidebar-panel tasks-panel" data-panel="tasks" hidden>
          <div class="section-heading"><span>TASKS</span><button type="button" data-task-action="add" class="task-add">+ Current note</button></div>
          <input class="task-filter" type="search" placeholder="Filter tasks…" aria-label="Filter tasks" />
          <div class="task-filter-grid">
            <select class="task-status-filter" aria-label="Task status"><option value="open">Open</option><option value="done">Done</option><option value="all">All</option></select>
            <select class="task-date-filter" aria-label="Task date"><option value="all">Any date</option><option value="overdue">Overdue</option><option value="today">Today</option><option value="upcoming">Upcoming</option><option value="undated">Undated</option></select>
            <select class="task-priority-filter" aria-label="Task priority"><option value="all">Any priority</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option><option value="none">No priority</option></select>
            <select class="task-group-select" aria-label="Group tasks"><option value="date">Group: date</option><option value="note">Group: note</option><option value="priority">Group: priority</option><option value="none">No grouping</option></select>
          </div>
          <p class="task-summary" role="status"></p>
          <div class="task-list" aria-label="Vault tasks"></div>
          <p class="task-syntax-help">Metadata stays in Markdown: @due(YYYY-MM-DD) · @scheduled(YYYY-MM-DD) · @priority(high) · @repeat(weekly)</p>
        </section>
        <section class="sidebar-panel media-panel" data-panel="media" hidden>
          <div class="section-heading"><span>ATTACHMENTS</span><button type="button" data-action="attachment-upload">+ Add</button></div>
          <p class="media-summary" role="status"></p>
          <div class="media-list" aria-label="Vault attachments"></div>
          <details class="media-settings"><summary>Attachment location</summary>
            <label>Save new attachments<select class="attachment-policy-select"><option value="folder">In attachment folder</option><option value="note-folder">Beside current note</option></select></label>
            <label class="attachment-folder-setting">Attachment folder<select class="attachment-folder-select"></select></label>
            <p class="media-help">Paste or drop files into the editor. Images, audio and video use embedded <code>![[...]]</code> references; other files use <code>[[...]]</code>.</p>
          </details>
        </section>
        <section class="sidebar-panel calendar-panel" data-panel="calendar" hidden>
          <div class="calendar-heading"><button type="button" data-calendar-action="prev-month" aria-label="Previous month">‹</button><strong class="calendar-label"></strong><button type="button" data-calendar-action="next-month" aria-label="Next month">›</button></div>
          <div class="calendar-weekdays" aria-hidden="true"><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span></div>
          <div class="calendar-grid" role="grid" aria-label="Daily notes calendar"></div>
          <div class="daily-nav"><button type="button" data-daily-nav="-1">Previous</button><button type="button" data-daily-nav="0">Today</button><button type="button" data-daily-nav="1">Next</button></div>
          <div class="calendar-day-notes"></div>
          <details class="calendar-settings"><summary>Daily Notes & Templates</summary>
            <label>Templates folder<select class="templates-folder-select"></select></label>
            <label>Default note template<select class="default-template-select"></select></label>
            <label>Daily notes folder<select class="daily-folder-select"></select></label>
            <label>Daily note template<select class="daily-template-select"></select></label>
            <label>Daily filename format<input class="daily-format-input" type="text" value="YYYY-MM-DD" /></label>
            <div class="folder-template-settings"><p>Folder-specific template</p><select class="folder-template-folder"></select><select class="folder-template-template"></select></div>
            <p class="calendar-help">Template variables: {{title}}, {{date}}, {{time}}, {{weekday}}, {{yesterday}}, {{tomorrow}}, {{date:YYYY-MM-DD}}, {{cursor}}.</p>
          </details>
        </section>
        <div class="sidebar-bottom"><span class="local-dot"></span><span>Stored in this browser</span></div>
      </aside>
      <main class="main" aria-label="Markdown workspace">
        <div class="document-bar"><div class="breadcrumb">No file selected</div><div class="daily-document-nav" hidden><button type="button" data-daily-nav="-1" aria-label="Previous daily note">‹</button><button type="button" data-daily-nav="0">Today</button><button type="button" data-daily-nav="1" aria-label="Next daily note">›</button></div><div class="mode-switch" role="group" aria-label="Editor mode"><button type="button" data-editor-mode="source" aria-pressed="false">Source</button><button type="button" data-editor-mode="live" aria-pressed="true">Live Preview</button><button type="button" data-editor-mode="reading" aria-pressed="false">Reading</button></div></div>
        <div class="actions" aria-label="File actions">
          <button data-action="rename" disabled>Rename</button><button data-action="move" disabled>Move</button><button data-action="duplicate" disabled>Duplicate</button>
          <button data-action="delete" disabled>Move to Trash</button><button data-action="restore" hidden>Restore</button>
          <button data-action="export-draft" disabled>Export draft .md</button><button data-action="checkpoint" disabled>Checkpoint</button>
        </div>
        <div class="editor-toolbar" aria-label="Markdown formatting" hidden><button type="button" data-editor-command="heading" title="Heading">H</button><button type="button" data-editor-command="bold" title="Bold (Ctrl/Cmd+B)"><strong>B</strong></button><button type="button" data-editor-command="italic" title="Italic (Ctrl/Cmd+I)"><em>I</em></button><button type="button" data-editor-command="link" title="Link (Ctrl/Cmd+K)">Link</button><button type="button" data-editor-command="task">Task</button><button type="button" data-editor-command="bullet">List</button><button type="button" data-editor-command="inline-code">Code</button><button type="button" data-editor-command="code-block">Block</button><button type="button" data-editor-command="math-block">Math</button><button type="button" data-editor-command="callout">Callout</button><button type="button" data-editor-command="table">Table</button><button type="button" data-editor-command="wiki-link" title="Internal link">[[ ]]</button><button type="button" data-action="insert-template">Template</button><button type="button" data-action="insert-query" title="Insert dynamic query">Query</button><button type="button" data-action="insert-board" title="Insert Kanban board">Board</button><button type="button" data-action="attachment-upload" title="Attach file">Media</button><button type="button" data-editor-action="search">Find</button><button type="button" data-editor-action="line-numbers" aria-pressed="false">Lines</button><button type="button" data-action="knowledge-panel" class="knowledge-toggle">Details</button></div>
        <div class="error" role="alert" hidden></div>
        <div class="recovery-actions"><button data-action="retry-save" hidden>Retry local save</button><button data-action="reopen" hidden>Preserve draft and reopen saved version</button></div>
        <section class="graph-surface" hidden aria-label="Knowledge graph">
          <header class="graph-header">
            <div class="graph-heading"><p class="eyebrow">KNOWLEDGE GRAPH</p><h1>See how the vault connects.</h1><p class="graph-summary" role="status"></p></div>
            <button type="button" class="graph-close" data-action="graph-close">Back to note</button>
          </header>
          <div class="graph-controls">
            <label>View<select class="graph-mode"><option value="full">Full vault</option><option value="local">Local graph</option></select></label>
            <label class="graph-depth-setting">Depth<select class="graph-depth"><option value="1">1 hop</option><option value="2" selected>2 hops</option><option value="3">3 hops</option><option value="4">4 hops</option></select></label>
            <label>Group<select class="graph-group"><option value="none">No grouping</option><option value="folder">Folder</option><option value="tag">Primary tag</option><option value="kind">Note / attachment</option><option value="property">Property</option></select></label>
            <label class="graph-group-property-setting" hidden>Group property<input class="graph-group-property" type="text" placeholder="status" /></label>
            <label>Find<input class="graph-search" type="search" placeholder="Title, path, tag…" /></label>
            <label>Tag<input class="graph-tag" type="search" placeholder="#project" /></label>
            <label>Property<input class="graph-property" type="search" placeholder="status=active" /></label>
            <label class="graph-check"><input class="graph-attachments" type="checkbox" checked /> Attachments</label>
            <label class="graph-check"><input class="graph-orphans" type="checkbox" /> Orphans only</label>
          </div>
          <div class="graph-toolbar" role="group" aria-label="Graph navigation"><button type="button" data-graph-action="zoom-out" aria-label="Zoom out">−</button><button type="button" data-graph-action="fit">Fit</button><button type="button" data-graph-action="zoom-in" aria-label="Zoom in">+</button><span class="graph-hover">Drag to pan · wheel or buttons to zoom · tap a node to open</span></div>
          <div class="graph-body">
            <div class="graph-canvas-wrap"><canvas class="graph-canvas"></canvas></div>
            <aside class="graph-browser" aria-label="Visible graph nodes"><div class="graph-browser-heading"><strong>Visible nodes</strong><span class="graph-browser-count"></span></div><div class="graph-node-list"></div></aside>
          </div>
        </section>
        <section class="empty-state">
          <p class="eyebrow">VAULT \u00b7 PHASE 11</p><h1>Turn note properties into working boards.</h1>
          <p>Keep projects as Markdown notes, then organize them into live Kanban lanes without creating a second task database.</p>
          <button data-command="vault.create" class="primary">Create a vault</button>
          <p class="fineprint">Cloud synchronization remains deliberately inactive. Phase 2 changes the editor and renderer, not the Phase 1 durability model.</p>
        </section>
        <div id="vault-editor" class="editor-host" hidden aria-label="Markdown source editor"></div>
        <article class="reading-view" hidden aria-label="Rendered Markdown"></article>
        <section class="attachment-view" hidden aria-label="Attachment preview"><div class="attachment-preview"></div><div class="attachment-meta"><h2 class="attachment-title"></h2><p class="attachment-detail"></p><button type="button" data-action="attachment-download">Download</button></div></section>
        <div class="folder-message" hidden></div>
        <input class="attachment-file-input" type="file" multiple hidden />
      </main>
      <aside class="inspector" aria-label="Knowledge and storage information"><button type="button" class="inspector-close" data-action="knowledge-panel" aria-label="Close knowledge panel">\u00d7</button>
        <p class="label">FILE INFORMATION</p><dl class="file-info"></dl>
        <div class="rule"></div><section class="properties-panel"><div class="panel-heading"><p class="label">PROPERTIES</p><button type="button" class="property-add" data-property-action="add">+ Add</button></div><p class="properties-status panel-empty"></p><div class="properties-list"></div><button type="button" class="property-source" data-property-action="source">Edit frontmatter in Source</button></section>
        <div class="rule"></div><section class="outline-panel"><div class="panel-heading"><p class="label">OUTLINE</p><span class="outline-count"></span></div><div class="outline-list"></div></section>
        <div class="rule"></div><section class="backlinks-panel"><div class="panel-heading"><p class="label">BACKLINKS</p><span class="backlink-count"></span></div><div class="backlink-list"></div><div class="unlinked-heading">UNLINKED MENTIONS</div><div class="unlinked-list"></div></section>
        <button type="button" class="local-graph-button" data-action="graph-local">Open local graph</button>
        <label class="knowledge-setting"><input class="auto-update-links" type="checkbox" checked /> Update links on rename/move</label>
        <div class="rule"></div><p class="label">DATA OWNERSHIP</p>
        <button data-command="vault.export" disabled>Markdown ZIP</button>
        <button data-command="vault.backup" disabled>Recovery backup</button>
        <p class="fineprint">ZIP exports active files and empty folders. Recovery backup also includes Trash, checkpoints and stored recovery drafts.</p>
        <div class="rule"></div><p class="label">CLOUD STATUS</p><p class="fineprint">Not configured. Nothing is uploaded. Signing in will not automatically upload local notes.</p>
        <button data-action="persist">Request persistent storage</button><p class="storage-message fineprint"></p>
      </aside>
      <footer class="statusbar"><span class="save-status" role="status">No file open</span><span class="counts"></span><span class="search-index-status">Index idle</span><span class="vault-counts"></span><span>IndexedDB \u00b7 schema 3</span></footer>
    </div>
    <dialog class="form-dialog" aria-labelledby="vault-dialog-title">
      <form method="dialog"><h2 id="vault-dialog-title"></h2><label class="dialog-label" for="vault-dialog-input"></label>
      <input id="vault-dialog-input" required autocomplete="off" /><select class="dialog-select" hidden aria-label="Destination folder"></select>
      <p class="dialog-help fineprint"></p><div class="dialog-buttons"><button value="cancel" formnovalidate>Cancel</button><button value="confirm" class="primary">Confirm</button></div></form>
    </dialog>
    <dialog class="template-dialog" aria-labelledby="template-dialog-title"><form method="dialog"><h2 id="template-dialog-title">Choose template</h2><select class="template-dialog-select" aria-label="Template"></select><p class="template-dialog-help fineprint"></p><div class="dialog-buttons"><button value="cancel">Cancel</button><button value="confirm" class="primary">Use template</button></div></form></dialog>
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
  const templateDialog = element<HTMLDialogElement>('.template-dialog');
  const templateDialogSelect = element<HTMLSelectElement>('.template-dialog-select');
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
  const mediaList = element<HTMLElement>('.media-list');
  const mediaSummary = element<HTMLElement>('.media-summary');
  const attachmentPolicySelect = element<HTMLSelectElement>('.attachment-policy-select');
  const attachmentFolderSelect = element<HTMLSelectElement>('.attachment-folder-select');
  const attachmentView = element<HTMLElement>('.attachment-view');
  const attachmentPreview = element<HTMLElement>('.attachment-preview');
  const attachmentTitle = element<HTMLElement>('.attachment-title');
  const attachmentDetail = element<HTMLElement>('.attachment-detail');
  const attachmentFileInput = element<HTMLInputElement>('.attachment-file-input');
  const graphSurface = element<HTMLElement>('.graph-surface');
  const graphCanvas = element<HTMLCanvasElement>('.graph-canvas');
  const graphModeSelect = element<HTMLSelectElement>('.graph-mode');
  const graphDepthSelect = element<HTMLSelectElement>('.graph-depth');
  const graphGroupSelect = element<HTMLSelectElement>('.graph-group');
  const graphGroupPropertyInput = element<HTMLInputElement>('.graph-group-property');
  const graphSearchInput = element<HTMLInputElement>('.graph-search');
  const graphTagInput = element<HTMLInputElement>('.graph-tag');
  const graphPropertyInput = element<HTMLInputElement>('.graph-property');
  const graphAttachmentsToggle = element<HTMLInputElement>('.graph-attachments');
  const graphOrphansToggle = element<HTMLInputElement>('.graph-orphans');
  const graphSummary = element<HTMLElement>('.graph-summary');
  const graphHover = element<HTMLElement>('.graph-hover');
  const graphNodeList = element<HTMLElement>('.graph-node-list');
  const graphBrowserCount = element<HTMLElement>('.graph-browser-count');
  const taskList = element<HTMLElement>('.task-list');
  const taskFilter = element<HTMLInputElement>('.task-filter');
  const taskStatusSelect = element<HTMLSelectElement>('.task-status-filter');
  const taskDateSelect = element<HTMLSelectElement>('.task-date-filter');
  const taskPrioritySelect = element<HTMLSelectElement>('.task-priority-filter');
  const taskGroupSelect = element<HTMLSelectElement>('.task-group-select');
  const taskSummary = element<HTMLElement>('.task-summary');
  const searchIndexStatus = element<HTMLElement>('.search-index-status');
  const quickDialog = element<HTMLDialogElement>('.quick-switcher-dialog');
  const quickInput = element<HTMLInputElement>('.quick-switcher-input');
  const quickResultsElement = element<HTMLElement>('.quick-switcher-results');
  const calendarGrid = element<HTMLElement>('.calendar-grid');
  const calendarLabel = element<HTMLElement>('.calendar-label');
  const calendarDayNotes = element<HTMLElement>('.calendar-day-notes');
  const templatesFolderSelect = element<HTMLSelectElement>('.templates-folder-select');
  const defaultTemplateSelect = element<HTMLSelectElement>('.default-template-select');
  const dailyFolderSelect = element<HTMLSelectElement>('.daily-folder-select');
  const dailyTemplateSelect = element<HTMLSelectElement>('.daily-template-select');
  const dailyFormatInput = element<HTMLInputElement>('.daily-format-input');
  const folderTemplateFolder = element<HTMLSelectElement>('.folder-template-folder');
  const folderTemplateTemplate = element<HTMLSelectElement>('.folder-template-template');
  const pathOf = (id: EntryId): string => new VaultTree(entries).path(id);
  const graphCanvasView = new GraphCanvasView(graphCanvas, {
    onOpen(entryId) {
      perform(async () => {
        closeGraph();
        await openEntry(entryId);
      });
    },
    onHover(node) {
      graphHover.textContent = node
        ? `${node.label} · ${node.kind} · ${node.degree} connection${node.degree === 1 ? '' : 's'}`
        : 'Drag to pan · wheel or buttons to zoom · tap a node to open';
    },
  });

  const editor = new MarkdownEditor(editorHost, {
    text: '', mode: 'live', readOnly: true, lineNumbers: false,
    wiki: {
      suggest(query) {
        if (selected?.kind !== 'markdown') return [];
        return [...knowledge.suggestions(query, selected.id, entries), ...attachmentSuggestions(query, entries)]
          .sort((a, b) => b.boost - a.boost || a.label.localeCompare(b.label))
          .slice(0, 60);
      },
      resolve(target) {
        if (selected?.kind !== 'markdown') return 'unresolved';
        const attachment = resolveAttachmentTarget(target.split('#', 1)[0] ?? target, selected.id, entries);
        if (attachment.status !== 'unresolved') return attachment.status;
        return knowledge.resolveRaw(target, selected.id, entries).status;
      },
      activate(target) {
        if (selected?.kind === 'markdown') perform(() => activateWikiTarget(target, selected!.id));
      },
    },
    query: {
      render(source) {
        return renderDynamicQueryBlock(source, selected?.id);
      },
    },
    board: {
      render(source) {
        return renderBoardBlock(source, selected?.id);
      },
    },
    onChange(text) { saver?.update(text); updateCounts(); schedulePropertiesRender(text); },
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

  async function attachmentObjectUrl(entryId: EntryId): Promise<string> {
    const cached = attachmentObjectUrls.get(entryId);
    if (cached) return cached;
    const attachment = await repository.readAttachment(entryId);
    const url = URL.createObjectURL(new Blob([attachment.bytes], { type: attachment.mimeType }));
    attachmentObjectUrls.set(entryId, url);
    return url;
  }

  function revokeAttachmentUrl(entryId: EntryId): void {
    const url = attachmentObjectUrls.get(entryId);
    if (!url) return;
    URL.revokeObjectURL(url);
    attachmentObjectUrls.delete(entryId);
  }

  async function attachmentRenderPayload(target: string, sourceEntryId?: string): Promise<{ entryId: string; name: string; mimeType: string; size: number; url: string } | null> {
    const source = sourceEntryId && entries.some(entry => entry.id === sourceEntryId) ? sourceEntryId as EntryId : selected?.id;
    const resolution = resolveAttachmentTarget(target, source, entries);
    if (resolution.status !== 'resolved') return null;
    const entry = entries.find(item => item.id === resolution.entryId && item.kind === 'attachment' && item.deletedAt === null);
    if (!entry) return null;
    const attachment = await repository.readAttachment(entry.id);
    return {
      entryId: entry.id,
      name: entry.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
      url: await attachmentObjectUrl(entry.id),
    };
  }
  async function setting(key: string, value?: unknown): Promise<unknown> {
    return transact(db, ['settings'], value === undefined ? 'readonly' : 'readwrite', async tx => {
      if (value !== undefined) { await request(tx.objectStore('settings').put({ key, value })); return value; }
      const item = await request<{ key: string; value: unknown } | undefined>(tx.objectStore('settings').get(key));
      return item?.value;
    });
  }
  function invalidateGraphModel(): void {
    graphBaseModel = null;
  }

  function graphCenterId(): EntryId | null {
    return selected && selected.deletedAt === null && (selected.kind === 'markdown' || selected.kind === 'attachment')
      ? selected.id
      : null;
  }

  function renderGraph(preserveViewport = false): void {
    if (!graphOpen) return;
    const base = graphBaseModel ??= buildKnowledgeGraph(entries, knowledge.records());
    const centerId = graphCenterId();
    let scoped = graphMode === 'local'
      ? centerId ? localKnowledgeGraph(base, centerId, graphDepth) : { ...base, nodes: [], edges: [] }
      : base;

    scoped = filterKnowledgeGraph(scoped, {
      kinds: graphIncludeAttachments ? ['note', 'attachment'] : ['note'],
      tag: graphTagText,
      property: graphPropertyText,
      orphanOnly: graphOrphanOnly,
    });
    graphModel = scoped;

    const searchMatches = graphSearchText.trim()
      ? filterKnowledgeGraph(scoped, { search: graphSearchText }).nodes
      : [];
    const highlightedIds = new Set(searchMatches.map(node => node.id));
    const stats = graphStats(scoped);
    const modeLabel = graphMode === 'local'
      ? centerId ? `Local · ${graphDepth} hop${graphDepth === 1 ? '' : 's'}` : 'Local · open a note or attachment first'
      : 'Full vault';
    const warningParts: string[] = [];
    if (base.unresolvedReferences) warningParts.push(`${base.unresolvedReferences} unresolved`);
    if (base.ambiguousReferences) warningParts.push(`${base.ambiguousReferences} ambiguous`);
    graphSummary.textContent = [
      modeLabel,
      `${stats.nodes} node${stats.nodes === 1 ? '' : 's'}`,
      `${stats.edges} edge${stats.edges === 1 ? '' : 's'}`,
      `${stats.orphans} orphan${stats.orphans === 1 ? '' : 's'}`,
      ...warningParts,
    ].join(' · ');

    graphModeSelect.value = graphMode;
    graphDepthSelect.value = String(graphDepth);
    graphGroupSelect.value = graphGroupMode;
    graphGroupPropertyInput.value = graphGroupProperty;
    graphSearchInput.value = graphSearchText;
    graphTagInput.value = graphTagText;
    graphPropertyInput.value = graphPropertyText;
    graphAttachmentsToggle.checked = graphIncludeAttachments;
    graphOrphansToggle.checked = graphOrphanOnly;
    element<HTMLElement>('.graph-depth-setting').hidden = graphMode !== 'local';
    element<HTMLElement>('.graph-group-property-setting').hidden = graphGroupMode !== 'property';

    graphCanvasView.setGraph(scoped, {
      groupMode: graphGroupMode,
      groupProperty: graphGroupProperty,
      highlightedIds,
      centerId,
      preserveViewport,
    });

    graphNodeList.replaceChildren();
    const sorted = (graphSearchText.trim() ? searchMatches : scoped.nodes)
      .slice()
      .sort((a, b) => {
        const aHighlight = highlightedIds.has(a.id) ? 1 : 0;
        const bHighlight = highlightedIds.has(b.id) ? 1 : 0;
        return bHighlight - aHighlight || b.degree - a.degree || a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' });
      });
    const visible = sorted.slice(0, 200);
    graphBrowserCount.textContent = graphSearchText.trim()
      ? `${sorted.length} match${sorted.length === 1 ? '' : 'es'} · ${stats.nodes} visible`
      : stats.nodes > 200 ? `200 of ${stats.nodes}` : String(stats.nodes);

    for (const node of visible) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'graph-node-button';
      button.dataset.graphEntry = node.id;
      if (highlightedIds.has(node.id)) button.classList.add('match');
      if (node.orphan) button.classList.add('orphan');
      const title = document.createElement('span');
      title.className = 'graph-node-title';
      title.textContent = node.label;
      const meta = document.createElement('span');
      meta.className = 'graph-node-meta';
      meta.textContent = `${node.kind} · ${node.degree} connection${node.degree === 1 ? '' : 's'} · ${node.path}`;
      button.append(title, meta);
      graphNodeList.append(button);
    }

    if (!visible.length) {
      const empty = document.createElement('p');
      empty.className = 'graph-node-empty';
      empty.textContent = graphSearchText.trim() ? 'No visible nodes match this search.' : 'No graph nodes match these filters.';
      graphNodeList.append(empty);
    }
  }

  async function openGraph(mode: 'full' | 'local' = graphMode): Promise<void> {
    if (saver) {
      await saver.flush();
      if (selected?.kind === 'markdown' && selected.deletedAt === null) await refreshKnowledgeEntry(selected.id);
    }
    graphMode = mode;
    graphOpen = true;
    graphSurface.hidden = false;
    workspace.dataset.graphOpen = 'true';
    workspace.dataset.sidebarOpen = 'false';
    element<HTMLElement>('[data-action="files"]').setAttribute('aria-expanded', 'false');
    renderGraph();
    graphCanvas.focus();
  }

  function closeGraph(): void {
    graphOpen = false;
    graphSurface.hidden = true;
    workspace.dataset.graphOpen = 'false';
    graphHover.textContent = 'Drag to pan · wheel or buttons to zoom · tap a node to open';
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

  function inputMetadataKey(input: SearchInput): string {
    return [input.title, input.path, input.createdAt, input.updatedAt].join('\u0000');
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

  function isInsideFolder(entryId: EntryId, folderId: EntryId | null): boolean {
    if (!folderId) return false;
    let current = entries.find(entry => entry.id === entryId);
    while (current) {
      if (current.parentId === folderId) return true;
      current = current.parentId ? entries.find(entry => entry.id === current!.parentId) : undefined;
    }
    return false;
  }

  function activeFolders(): Entry[] {
    return entries.filter(entry => entry.kind === 'directory' && entry.deletedAt === null);
  }

  function activeAttachments(): Entry[] {
    return entries.filter(entry => entry.kind === 'attachment' && entry.deletedAt === null);
  }

  function uniqueAttachmentName(parentId: EntryId | null, rawName: string): string {
    const siblings = new Set(entries
      .filter(entry => entry.deletedAt === null && entry.parentId === parentId)
      .map(entry => entry.name.normalize('NFC').toLocaleLowerCase()));
    if (!siblings.has(rawName.normalize('NFC').toLocaleLowerCase())) return rawName;
    const dot = rawName.lastIndexOf('.');
    const base = dot > 0 ? rawName.slice(0, dot) : rawName;
    const extension = dot > 0 ? rawName.slice(dot) : '';
    for (let index = 2; index <= 10_000; index++) {
      const candidate = `${base} ${index}${extension}`;
      if (!siblings.has(candidate.normalize('NFC').toLocaleLowerCase())) return candidate;
    }
    throw new VaultError('COLLISION', 'Could not find an available attachment filename.');
  }

  async function ensureAttachmentFolder(): Promise<EntryId | null> {
    if (!vault) return null;
    if (attachmentFolderId && activeFolders().some(folder => folder.id === attachmentFolderId)) return attachmentFolderId;
    const existing = activeFolders().find(folder => folder.parentId === null && folder.name.normalize('NFC').toLocaleLowerCase() === 'attachments');
    if (existing) {
      attachmentFolderId = existing.id;
      await setting(`attachmentFolder:${vault.id}`, existing.id);
      return existing.id;
    }
    const created = await repository.createEntry(vault.id, null, 'Attachments', 'directory');
    entries.push(created);
    attachmentFolderId = created.id;
    await setting(`attachmentFolder:${vault.id}`, created.id);
    return created.id;
  }

  async function attachmentUploadParent(): Promise<EntryId | null> {
    if (attachmentPolicy === 'note-folder' && selected?.kind === 'markdown' && selected.deletedAt === null) return selected.parentId;
    return await ensureAttachmentFolder();
  }

  function renderMediaSettings(): void {
    const folderIds = new Set(activeFolders().map(entry => entry.id));
    if (attachmentFolderId && !folderIds.has(attachmentFolderId)) attachmentFolderId = null;
    attachmentPolicySelect.value = attachmentPolicy;
    fillFolderSelect(attachmentFolderSelect, true);
    if (attachmentFolderSelect.options[0]) attachmentFolderSelect.options[0].textContent = 'Automatic: Attachments';
    attachmentFolderSelect.value = attachmentFolderId && [...attachmentFolderSelect.options].some(option => option.value === attachmentFolderId)
      ? attachmentFolderId
      : '';
    element<HTMLElement>('.attachment-folder-setting').hidden = attachmentPolicy === 'note-folder';
    attachmentPolicySelect.disabled = !vault;
    attachmentFolderSelect.disabled = !vault || attachmentPolicy === 'note-folder';
  }

  function renderMedia(): void {
    mediaList.replaceChildren();
    const attachments = activeAttachments().sort((a, b) => pathOf(a.id).localeCompare(pathOf(b.id), undefined, { numeric: true, sensitivity: 'base' }));
    const counts = attachmentReferenceCounts(entries, knowledge.records());
    const orphaned = attachments.filter(entry => (counts.get(entry.id) ?? 0) === 0);
    mediaSummary.textContent = `${attachments.length} attachment${attachments.length === 1 ? '' : 's'} · ${orphaned.length} unreferenced`;

    if (!attachments.length) {
      const empty = document.createElement('p');
      empty.className = 'media-empty';
      empty.textContent = 'No attachments yet. Paste, drop, or add files.';
      mediaList.append(empty);
      renderMediaSettings();
      return;
    }

    for (const entry of attachments) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'media-item';
      button.dataset.mediaEntry = entry.id;
      const name = document.createElement('span');
      name.className = 'media-item-name';
      name.textContent = entry.name;
      const path = document.createElement('span');
      path.className = 'media-item-path';
      path.textContent = pathOf(entry.id);
      const count = document.createElement('span');
      count.className = 'media-item-count';
      const references = counts.get(entry.id) ?? 0;
      count.textContent = references ? `${references} ref${references === 1 ? '' : 's'}` : 'Unreferenced';
      if (!references) button.classList.add('orphan');
      button.append(name, path, count);
      mediaList.append(button);
    }
    renderMediaSettings();
  }

  async function uploadAttachmentFiles(files: readonly File[], insertIntoNote = true): Promise<void> {
    if (!vault || !files.length) return;
    const noteId = insertIntoNote && selected?.kind === 'markdown' && selected.deletedAt === null ? selected.id : undefined;
    if (noteId && editorMode === 'reading') await setEditorMode('live');
    if (noteId && saver) await saver.flush();
    const parentId = await attachmentUploadParent();
    const references: string[] = [];

    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const name = uniqueAttachmentName(parentId, file.name || 'attachment');
      const created = await repository.createAttachment(vault.id, parentId, name, file.type, bytes);
      entries.push(created);
      const attachment = await repository.readAttachment(created.id);
      const target = new VaultTree(entries).path(created.id);
      const kind = attachmentMediaKind(attachment.mimeType);
      const embed = kind === 'image' || kind === 'audio' || kind === 'video';
      references.push(`${embed ? '!' : ''}[[${target}]]`);
    }

    await refresh();
    if (noteId && selected?.id === noteId && saver && references.length) {
      const source = editor.getText();
      const at = Math.max(0, Math.min(editorStats.position, source.length));
      const before = at > 0 && source[at - 1] !== '\n' ? '\n' : '';
      const after = at < source.length && source[at] !== '\n' ? '\n' : (source.length ? '\n' : '');
      editor.insertText(before + references.join('\n') + after);
    }
    renderMedia();
  }

  async function renderAttachmentViewer(): Promise<void> {
    attachmentPreview.replaceChildren();
    attachmentView.hidden = selected?.kind !== 'attachment';
    if (!selected || selected.kind !== 'attachment') return;
    const attachment = await repository.readAttachment(selected.id);
    const url = await attachmentObjectUrl(selected.id);
    const kind = attachmentMediaKind(attachment.mimeType);
    attachmentTitle.textContent = selected.name;
    attachmentDetail.textContent = `${attachment.mimeType} · ${formatAttachmentSize(attachment.size)} · stored locally`;

    if (kind === 'image') {
      const image = document.createElement('img');
      image.src = url;
      image.alt = selected.name;
      image.className = 'attachment-preview-image';
      attachmentPreview.append(image);
    } else if (kind === 'audio') {
      const audio = document.createElement('audio');
      audio.src = url;
      audio.controls = true;
      audio.preload = 'metadata';
      attachmentPreview.append(audio);
    } else if (kind === 'video') {
      const video = document.createElement('video');
      video.src = url;
      video.controls = true;
      video.preload = 'metadata';
      attachmentPreview.append(video);
    } else {
      const card = document.createElement('a');
      card.className = 'attachment-preview-file';
      card.href = url;
      card.download = selected.name;
      card.textContent = kind === 'pdf' ? 'Open / download PDF' : 'Download file';
      attachmentPreview.append(card);
    }
  }

  function templateEntries(): Entry[] {
    if (!templatesFolderId) return [];
    return activeMarkdownEntries()
      .filter(entry => entry.parentId === templatesFolderId || isInsideFolder(entry.id, templatesFolderId))
      .sort((a, b) => pathOf(a.id).localeCompare(pathOf(b.id), undefined, { numeric: true, sensitivity: 'base' }));
  }

  function fillFolderSelect(select: HTMLSelectElement, includeRoot: boolean): void {
    const current = select.value;
    select.replaceChildren();
    if (includeRoot) select.add(new Option('Vault root', ''));
    for (const folder of activeFolders().sort((a, b) => pathOf(a.id).localeCompare(pathOf(b.id)))) {
      select.add(new Option(pathOf(folder.id), folder.id));
    }
    if ([...select.options].some(option => option.value === current)) select.value = current;
  }

  function fillTemplateSelect(select: HTMLSelectElement, selectedId: EntryId | null, emptyLabel = 'None'): void {
    select.replaceChildren(new Option(emptyLabel, ''));
    for (const template of templateEntries()) select.add(new Option(pathOf(template.id), template.id));
    select.value = selectedId && [...select.options].some(option => option.value === selectedId) ? selectedId : '';
  }

  function renderPlanningSettings(): void {
    const folderIds = new Set(activeFolders().map(entry => entry.id));
    if (templatesFolderId && !folderIds.has(templatesFolderId)) templatesFolderId = null;
    if (dailyFolderId && !folderIds.has(dailyFolderId)) dailyFolderId = null;
    const availableTemplateIds = new Set(templateEntries().map(entry => entry.id));
    if (defaultTemplateId && !availableTemplateIds.has(defaultTemplateId)) defaultTemplateId = null;
    if (dailyTemplateId && !availableTemplateIds.has(dailyTemplateId)) dailyTemplateId = null;
    for (const [folderId, templateId] of Object.entries(folderTemplates)) {
      if (!folderIds.has(folderId as EntryId) || !availableTemplateIds.has(templateId as EntryId)) delete folderTemplates[folderId];
    }

    fillFolderSelect(templatesFolderSelect, true);
    if (templatesFolderSelect.options[0]) templatesFolderSelect.options[0].textContent = 'None';
    templatesFolderSelect.value = templatesFolderId && [...templatesFolderSelect.options].some(option => option.value === templatesFolderId) ? templatesFolderId : '';
    fillFolderSelect(dailyFolderSelect, true);
    dailyFolderSelect.value = dailyFolderId && [...dailyFolderSelect.options].some(option => option.value === dailyFolderId) ? dailyFolderId : '';
    fillTemplateSelect(defaultTemplateSelect, defaultTemplateId);
    fillTemplateSelect(dailyTemplateSelect, dailyTemplateId);

    const currentFolder = folderTemplateFolder.value;
    fillFolderSelect(folderTemplateFolder, false);
    if (currentFolder && [...folderTemplateFolder.options].some(option => option.value === currentFolder)) folderTemplateFolder.value = currentFolder;
    const folderId = folderTemplateFolder.value;
    fillTemplateSelect(folderTemplateTemplate, folderId && folderTemplates[folderId] ? folderTemplates[folderId] as EntryId : null);

    dailyFormatInput.value = dailyFormat;
    const enabled = !!vault;
    for (const control of [templatesFolderSelect, defaultTemplateSelect, dailyFolderSelect, dailyTemplateSelect, dailyFormatInput, folderTemplateFolder, folderTemplateTemplate]) control.disabled = !enabled;
  }

  async function readTemplate(templateId: EntryId): Promise<string> {
    const file = await repository.read(templateId);
    if (file.entry.kind !== 'markdown' || file.entry.deletedAt !== null || !file.content) {
      throw new VaultError('NOT_FOUND', 'The selected template is unavailable.');
    }
    return file.content.text;
  }

  async function chooseTemplate(title: string): Promise<EntryId | null> {
    const templates = templateEntries();
    templateDialogSelect.replaceChildren();
    for (const template of templates) templateDialogSelect.add(new Option(pathOf(template.id), template.id));
    element<HTMLElement>('#template-dialog-title').textContent = title;
    element<HTMLElement>('.template-dialog-help').textContent = templates.length
      ? 'Templates are ordinary Markdown files. Variables are expanded when inserted.'
      : 'Choose a Templates folder containing Markdown template files in Calendar settings.';
    element<HTMLButtonElement>('.template-dialog button[value="confirm"]').disabled = templates.length === 0;
    templateDialog.returnValue = 'cancel';
    templateDialog.showModal();
    if (templates.length) templateDialogSelect.focus();
    return new Promise(resolve => templateDialog.addEventListener('close', () => {
      resolve(templateDialog.returnValue === 'confirm' && templateDialogSelect.value ? templateDialogSelect.value as EntryId : null);
    }, { once: true }));
  }

  async function renderTemplateEntry(templateId: EntryId, title: string, date: Date): Promise<{ text: string; cursorOffset: number | null }> {
    return renderTemplate(await readTemplate(templateId), { title, date });
  }

  function templateForParent(parentId: EntryId | null): EntryId | null {
    if (templatesFolderId && (parentId === templatesFolderId || (parentId && isInsideFolder(parentId, templatesFolderId)))) return null;
    if (parentId && folderTemplates[parentId]) return folderTemplates[parentId] as EntryId;
    return defaultTemplateId;
  }

  async function createMarkdownNote(parentId: EntryId | null, rawName: string, explicitTemplateId: EntryId | null = null, date = new Date()): Promise<Entry> {
    if (!vault) throw new VaultError('NOT_FOUND', 'No vault is open.');
    const title = rawName.replace(/\.md$/iu, '');
    const templateId = explicitTemplateId ?? templateForParent(parentId);
    let text = '';
    let cursorOffset: number | null = null;
    if (templateId) {
      const rendered = await renderTemplateEntry(templateId, title, date);
      text = rendered.text;
      cursorOffset = rendered.cursorOffset;
    }
    const created = await repository.createEntry(vault.id, parentId, rawName, 'markdown', text);
    if (cursorOffset !== null) pendingCursorOffsets.set(created.id, cursorOffset);
    return created;
  }

  async function openOrCreateDaily(date: Date): Promise<void> {
    if (!vault) return;
    const existing = dailyEntryForDate(date, entries, dailyFolderId, dailyFormat);
    if (existing) {
      calendarSelectedKey = dateKey(date);
      calendarCursor = new Date(date.getFullYear(), date.getMonth(), 1, 12, 0, 0, 0);
      await openEntry(existing.id);
      renderCalendar();
      return;
    }

    const name = safeDailyFilename(date, dailyFormat);
    let rendered: { text: string; cursorOffset: number | null };
    if (dailyTemplateId) {
      rendered = await renderTemplateEntry(dailyTemplateId, name, date);
    } else {
      rendered = renderTemplate('---\ndate: {{date}}\n---\n# {{date}}\n\n{{cursor}}', { title: name, date });
    }
    const created = await repository.createEntry(vault.id, dailyFolderId, name, 'markdown', rendered.text);
    if (rendered.cursorOffset !== null) pendingCursorOffsets.set(created.id, rendered.cursorOffset);
    calendarSelectedKey = dateKey(date);
    calendarCursor = new Date(date.getFullYear(), date.getMonth(), 1, 12, 0, 0, 0);
    await refresh();
    await openEntry(created.id);
    renderCalendar();
  }

  function currentDailyDate(): Date | null {
    return selected ? dailyDateForEntry(selected, dailyFolderId, dailyFormat) : null;
  }

  async function navigateDaily(delta: number): Promise<void> {
    const base = delta === 0 ? new Date() : currentDailyDate() ?? new Date();
    await openOrCreateDaily(delta === 0 ? base : addLocalDays(base, delta));
  }

  function updateDailyDocumentNav(): void {
    const nav = element<HTMLElement>('.daily-document-nav');
    const date = selected ? dailyDateForEntry(selected, dailyFolderId, dailyFormat) : null;
    nav.hidden = date === null;
    if (date) {
      calendarSelectedKey = dateKey(date);
      calendarCursor = new Date(date.getFullYear(), date.getMonth(), 1, 12, 0, 0, 0);
    }
  }

  interface TaskViewItem {
    entry: Entry;
    path: string;
    task: KnowledgeTask;
  }

  function allTaskItems(): TaskViewItem[] {
    const tree = new VaultTree(entries);
    const byId = new Map(entries.filter(entry => entry.kind === 'markdown' && entry.deletedAt === null).map(entry => [entry.id, entry]));
    const items: TaskViewItem[] = [];
    for (const record of knowledge.records()) {
      const entry = byId.get(record.entryId);
      if (!entry) continue;
      const path = tree.path(entry.id);
      for (const task of record.tasks) items.push({ entry, path, task });
    }
    return items;
  }

  function taskPriorityRank(priority: TaskPriority | null): number {
    return priority === 'high' ? 0 : priority === 'medium' ? 1 : priority === 'low' ? 2 : 3;
  }

  function taskGroupLabel(item: TaskViewItem): string {
    if (taskGroup === 'note') return item.path;
    if (taskGroup === 'priority') return item.task.priority ? `${item.task.priority[0]!.toUpperCase()}${item.task.priority.slice(1)} priority` : 'No priority';
    if (taskGroup === 'date') {
      const state = taskDateState(item.task);
      return state === 'overdue' ? 'Overdue' : state === 'today' ? 'Today' : state === 'upcoming' ? 'Upcoming' : state === 'undated' ? 'Undated' : 'Completed';
    }
    return '';
  }

  function taskSort(left: TaskViewItem, right: TaskViewItem): number {
    if (left.task.completed !== right.task.completed) return left.task.completed ? 1 : -1;
    const leftDate = taskEffectiveDate(left.task) ?? '9999-99-99';
    const rightDate = taskEffectiveDate(right.task) ?? '9999-99-99';
    if (leftDate !== rightDate) return leftDate.localeCompare(rightDate);
    const priority = taskPriorityRank(left.task.priority) - taskPriorityRank(right.task.priority);
    if (priority) return priority;
    return left.path.localeCompare(right.path) || left.task.from - right.task.from;
  }

  function assignTaskDataset(element: HTMLElement, item: TaskViewItem): void {
    element.dataset.taskEntry = item.entry.id;
    element.dataset.taskFrom = String(item.task.from);
    element.dataset.taskTo = String(item.task.to);
    element.dataset.taskRaw = item.task.raw;
  }

  function taskItemFromDataset(element: HTMLElement): { entryId: EntryId; task: Pick<KnowledgeTask, 'from' | 'to' | 'raw'> } | null {
    const entryId = element.dataset.taskEntry as EntryId | undefined;
    const from = Number(element.dataset.taskFrom);
    const to = Number(element.dataset.taskTo);
    const raw = element.dataset.taskRaw;
    if (!entryId || !Number.isInteger(from) || !Number.isInteger(to) || raw === undefined) return null;
    return { entryId, task: { from, to, raw } };
  }

  async function mutateTask(
    entryId: EntryId,
    task: Pick<KnowledgeTask, 'from' | 'to' | 'raw'>,
    patch: TaskPatch,
  ): Promise<void> {
    if (selected?.id === entryId && saver) await saver.flush();
    const file = await repository.read(entryId);
    if (file.entry.kind !== 'markdown' || file.entry.deletedAt !== null || !file.content) {
      throw new VaultError('NOT_FOUND', 'The task source note is unavailable.');
    }
    const mutation = updateTaskMarkdown(file.content.text, task, patch);

    if (selected?.id === entryId && saver) {
      editor.setText(mutation.text);
      saver.update(mutation.text);
      await saver.flush();
      await refreshKnowledgeEntry(entryId);
    } else {
      const saved = await repository.saveMarkdown(entryId, mutation.text, file.entry.localVersion);
      const index = entries.findIndex(entry => entry.id === saved.id);
      if (index >= 0) entries[index] = saved;
      await knowledge.upsert(saved, mutation.text);
      await refreshSearchEntry(entryId);
      renderTree();
      renderTasks();
      renderCalendar();
    }
    editor.refreshPreview();
    if (editorMode === 'reading') await renderReadingCurrent();
  }

  async function openTaskSource(entryId: EntryId, from: number): Promise<void> {
    await openEntry(entryId);
    if (editorMode === 'reading') await setEditorMode('live');
    const record = knowledge.get(entryId);
    const current = record?.tasks.find(task => task.from === from) ?? record?.tasks.find(task => task.from >= from);
    editor.revealRange(current?.from ?? from, current?.to ?? from);
  }

  function renderTaskCard(item: TaskViewItem): HTMLElement {
    const card = document.createElement('article');
    card.className = 'task-card';
    card.dataset.taskText = item.task.text;
    if (item.task.completed) card.classList.add('completed');
    card.classList.add(`task-state-${taskDateState(item.task)}`);
    if (item.task.priority) card.classList.add(`task-priority-${item.task.priority}`);
    assignTaskDataset(card, item);

    const top = document.createElement('div');
    top.className = 'task-card-top';

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'task-check';
    check.checked = item.task.completed;
    check.dataset.taskRole = 'completed';
    check.setAttribute('aria-label', `Complete task: ${item.task.text}`);

    const title = document.createElement('input');
    title.type = 'text';
    title.className = 'task-title-input';
    title.value = item.task.text;
    title.dataset.taskRole = 'text';
    title.setAttribute('aria-label', 'Task text');

    const source = document.createElement('button');
    source.type = 'button';
    source.className = 'task-source';
    source.dataset.taskAction = 'source';
    source.textContent = item.path;
    source.title = `Open ${item.path}`;

    top.append(check, title);
    card.append(top, source);

    const metadata = document.createElement('div');
    metadata.className = 'task-metadata';

    const scheduled = document.createElement('input');
    scheduled.type = 'date';
    scheduled.className = 'task-date-input';
    scheduled.value = item.task.scheduled ?? '';
    scheduled.dataset.taskRole = 'scheduled';
    scheduled.title = 'Scheduled date';
    scheduled.setAttribute('aria-label', 'Scheduled date');

    const due = document.createElement('input');
    due.type = 'date';
    due.className = 'task-date-input';
    due.value = item.task.due ?? '';
    due.dataset.taskRole = 'due';
    due.title = 'Due date';
    due.setAttribute('aria-label', 'Due date');

    const priority = document.createElement('select');
    priority.className = 'task-priority-input';
    priority.dataset.taskRole = 'priority';
    priority.setAttribute('aria-label', 'Task priority');
    priority.add(new Option('No priority', ''));
    priority.add(new Option('High', 'high'));
    priority.add(new Option('Medium', 'medium'));
    priority.add(new Option('Low', 'low'));
    priority.value = item.task.priority ?? '';

    const recurrence = document.createElement('input');
    recurrence.type = 'text';
    recurrence.className = 'task-repeat-input';
    recurrence.dataset.taskRole = 'recurrence';
    recurrence.value = item.task.recurrence ?? '';
    recurrence.placeholder = 'repeat';
    recurrence.title = 'daily, weekly, monthly, yearly, every 2w…';
    recurrence.setAttribute('aria-label', 'Task recurrence');

    metadata.append(scheduled, due, priority, recurrence);
    card.append(metadata);

    if (item.task.completedOn) {
      const done = document.createElement('span');
      done.className = 'task-done-date';
      done.textContent = `Done ${item.task.completedOn}`;
      card.append(done);
    }
    return card;
  }

  function renderTasks(): void {
    taskList.replaceChildren();
    const all = allTaskItems();
    const open = all.filter(item => !item.task.completed);
    const overdue = open.filter(item => taskDateState(item.task) === 'overdue').length;
    const today = open.filter(item => taskDateState(item.task) === 'today').length;
    taskSummary.textContent = `${open.length} open · ${overdue} overdue · ${today} today · ${all.length} total`;
    element<HTMLButtonElement>('[data-task-action="add"]').disabled = !selected || selected.kind !== 'markdown' || selected.deletedAt !== null;

    const query = taskFilterText.trim().normalize('NFC').toLocaleLowerCase();
    const filtered = all.filter(item => {
      if (taskStatusFilter === 'open' && item.task.completed) return false;
      if (taskStatusFilter === 'done' && !item.task.completed) return false;
      if (taskDateFilter !== 'all' && taskDateState(item.task) !== taskDateFilter) return false;
      if (taskPriorityFilter !== 'all') {
        if (taskPriorityFilter === 'none' ? item.task.priority !== null : item.task.priority !== taskPriorityFilter) return false;
      }
      if (query && !item.task.text.normalize('NFC').toLocaleLowerCase().includes(query) && !item.path.normalize('NFC').toLocaleLowerCase().includes(query)) return false;
      return true;
    }).sort(taskSort);

    if (!filtered.length) {
      const empty = document.createElement('p');
      empty.className = 'task-empty';
      empty.textContent = all.length ? 'No tasks match these filters.' : 'No Markdown tasks found. Use - [ ] in any note.';
      taskList.append(empty);
      return;
    }

    const groups = new Map<string, TaskViewItem[]>();
    for (const item of filtered) {
      const label = taskGroupLabel(item);
      const bucket = groups.get(label) ?? [];
      bucket.push(item);
      groups.set(label, bucket);
    }
    for (const [label, items] of groups) {
      if (taskGroup !== 'none') {
        const heading = document.createElement('h3');
        heading.className = 'task-group-heading';
        heading.textContent = label;
        taskList.append(heading);
      }
      for (const item of items) taskList.append(renderTaskCard(item));
    }
  }

  async function addTaskToCurrentNote(): Promise<void> {
    if (!selected || selected.kind !== 'markdown' || selected.deletedAt !== null || !saver) {
      throw new VaultError('UNSUPPORTED', 'Open an active Markdown note before adding a task.');
    }
    await saver.flush();
    const source = editor.getText();
    const separator = source.length === 0 || source.endsWith('\n') ? '' : '\n';
    const next = source + separator + '- [ ] New task';
    editor.setText(next);
    saver.update(next);
    await saver.flush();
    await refreshKnowledgeEntry(selected.id);
    if (editorMode === 'reading') await renderReadingCurrent();
    switchSidebarPanel('tasks');
  }

  function renderCalendar(): void {
    calendarGrid.replaceChildren();
    calendarDayNotes.replaceChildren();
    if (!vault) {
      calendarLabel.textContent = 'Calendar';
      return;
    }
    const month = buildCalendarMonth(calendarCursor.getFullYear(), calendarCursor.getMonth(), entries, knowledge.records(), {
      dailyFolderId,
      dailyFormat,
    });
    calendarLabel.textContent = month.label;
    for (const day of month.days) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'calendar-day';
      if (!day.inMonth) button.classList.add('outside');
      if (day.isToday) button.classList.add('today');
      if (day.dailyEntryId) button.classList.add('has-daily');
      if (day.associatedEntryIds.length) button.classList.add('has-associated');
      if (day.tasks.length) button.classList.add('has-task');
      if (day.key === calendarSelectedKey) button.classList.add('selected');
      button.dataset.calendarDate = day.key;
      button.setAttribute('aria-label', `${day.key}${day.dailyEntryId ? ', daily note exists' : ', create daily note'}${day.associatedEntryIds.length ? `, ${day.associatedEntryIds.length} associated notes` : ''}${day.tasks.length ? `, ${day.tasks.length} open tasks` : ''}`);
      const number = document.createElement('span');
      number.className = 'calendar-day-number';
      number.textContent = String(day.date.getDate());
      const marks = document.createElement('span');
      marks.className = 'calendar-day-marks';
      if (day.dailyEntryId) {
        const daily = document.createElement('i');
        daily.className = 'calendar-daily-mark';
        marks.append(daily);
      }
      if (day.associatedEntryIds.length) {
        const count = document.createElement('small');
        count.textContent = String(day.associatedEntryIds.length);
        marks.append(count);
      }
      if (day.tasks.length) {
        const taskCount = document.createElement('b');
        taskCount.className = 'calendar-task-count';
        taskCount.textContent = String(day.tasks.length);
        marks.append(taskCount);
      }
      button.append(number, marks);
      calendarGrid.append(button);
    }

    const chosen = month.days.find(day => day.key === calendarSelectedKey);
    if (chosen) {
      const title = document.createElement('p');
      title.className = 'calendar-selected-title';
      title.textContent = chosen.key;
      calendarDayNotes.append(title);
      const ids = [...new Set([...(chosen.dailyEntryId ? [chosen.dailyEntryId] : []), ...chosen.associatedEntryIds])];
      for (const entryId of ids) {
        const entry = entries.find(item => item.id === entryId);
        if (!entry) continue;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'calendar-note';
        button.dataset.calendarEntry = entry.id;
        button.textContent = entry.name.replace(/\.md$/iu, '');
        calendarDayNotes.append(button);
      }
      for (const task of chosen.tasks) {
        const entry = entries.find(item => item.id === task.entryId);
        if (!entry) continue;
        const item: TaskViewItem = { entry, path: pathOf(entry.id), task: { ...task, to: task.from + task.raw.length, recurrence: null, completedOn: null } };
        const row = document.createElement('div');
        row.className = 'calendar-task-row';
        assignTaskDataset(row, item);
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = false;
        checkbox.dataset.taskRole = 'completed';
        checkbox.setAttribute('aria-label', `Complete calendar task: ${task.text}`);
        const open = document.createElement('button');
        open.type = 'button';
        open.dataset.taskAction = 'source';
        open.textContent = task.text;
        const meta = document.createElement('span');
        meta.textContent = task.due === chosen.key ? 'Due' : 'Scheduled';
        row.append(checkbox, open, meta);
        calendarDayNotes.append(row);
      }
      if (!ids.length && !chosen.tasks.length) {
        const empty = document.createElement('p');
        empty.className = 'panel-empty';
        empty.textContent = 'No dated notes or tasks yet. Click the day to create its Daily Note.';
        calendarDayNotes.append(empty);
      }
    }
  }

  function switchSidebarPanel(panel: 'files' | 'search' | 'tags' | 'tasks' | 'media' | 'calendar'): void {
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
    if (panel === 'tasks') { renderTasks(); taskFilter.focus(); }
    if (panel === 'media') renderMedia();
    if (panel === 'calendar') renderCalendar();
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
      searchIndexedVersions = new Map(inputs.map(input => [input.entryId, input.localVersion]));
      searchMetadata = new Map(inputs.map(input => [input.entryId, inputMetadataKey(input)]));
      // Catch notes created, saved, renamed, moved, or deleted while the worker was building.
      await reconcileSearchIndex();
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
        searchIndexedVersions.delete(entryId);
        searchMetadata.delete(entryId);
      }
    }

    const tree = new VaultTree(entries);
    const updates = [];
    const contentUpdates: Entry[] = [];
    for (const entry of active) {
      const path = tree.path(entry.id);
      const key = metadataKey(entry, path);
      if (!searchIndexedIds.has(entry.id) || searchIndexedVersions.get(entry.id) !== entry.localVersion) {
        contentUpdates.push(entry);
      } else if (searchMetadata.get(entry.id) !== key) {
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
    for (const entry of contentUpdates) {
      const file = await repository.read(entry.id);
      if (!file.content) continue;
      const input = searchInput(file.entry, file.content.text, tree);
      await searchIndex.upsert(input);
      searchIndexedIds.add(entry.id);
      searchIndexedVersions.set(entry.id, input.localVersion);
      searchMetadata.set(entry.id, inputMetadataKey(input));
    }
    await refreshFacets();
    if (globalSearch.value.trim()) await runGlobalSearch();
  }

  async function refreshSearchEntry(entryId: EntryId): Promise<void> {
    if (!vault || !searchReady || searchVaultId !== vault.id) return;
    const entry = entries.find(item => item.id === entryId && item.kind === 'markdown' && item.deletedAt === null);
    if (!entry) {
      await searchIndex.remove([entryId]);
      searchIndexedIds.delete(entryId);
      searchIndexedVersions.delete(entryId);
      searchMetadata.delete(entryId);
      return;
    }
    const file = await repository.read(entryId);
    if (!file.content) return;
    const tree = new VaultTree(entries);
    const input = searchInput(file.entry, file.content.text, tree);
    await searchIndex.upsert(input);
    searchIndexedIds.add(entryId);
    searchIndexedVersions.set(entryId, input.localVersion);
    searchMetadata.set(entryId, inputMetadataKey(input));
    await refreshFacets();
    if (globalSearch.value.trim()) await runGlobalSearch();
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
    const rawTemplatesFolder = await setting(`templatesFolder:${vault.id}`);
    const rawDefaultTemplate = await setting(`defaultTemplate:${vault.id}`);
    const rawDailyFolder = await setting(`dailyFolder:${vault.id}`);
    const rawDailyTemplate = await setting(`dailyTemplate:${vault.id}`);
    const rawDailyFormat = await setting(`dailyFormat:${vault.id}`);
    const rawFolderTemplates = await setting(`folderTemplates:${vault.id}`);
    const rawAttachmentPolicy = await setting(`attachmentPolicy:${vault.id}`);
    const rawAttachmentFolder = await setting(`attachmentFolder:${vault.id}`);
    sortMode = isFileSort(rawSort) ? rawSort : 'name-asc';
    foldersFirst = typeof rawFoldersFirst === 'boolean' ? rawFoldersFirst : true;
    autoUpdateLinks = typeof rawAutoUpdateLinks === 'boolean' ? rawAutoUpdateLinks : true;
    collapsed = new Set(Array.isArray(rawCollapsed) ? rawCollapsed.filter((id): id is EntryId => typeof id === 'string') : []);
    filterText = typeof rawFilter === 'string' ? rawFilter : '';
    recentEntries = Array.isArray(rawRecent) ? rawRecent.filter((id): id is EntryId => typeof id === 'string').slice(0, 40) : [];
    templatesFolderId = typeof rawTemplatesFolder === 'string' && rawTemplatesFolder ? rawTemplatesFolder as EntryId : null;
    defaultTemplateId = typeof rawDefaultTemplate === 'string' && rawDefaultTemplate ? rawDefaultTemplate as EntryId : null;
    dailyFolderId = typeof rawDailyFolder === 'string' && rawDailyFolder ? rawDailyFolder as EntryId : null;
    dailyTemplateId = typeof rawDailyTemplate === 'string' && rawDailyTemplate ? rawDailyTemplate as EntryId : null;
    dailyFormat = typeof rawDailyFormat === 'string' && rawDailyFormat.trim() ? rawDailyFormat : 'YYYY-MM-DD';
    folderTemplates = rawFolderTemplates && typeof rawFolderTemplates === 'object' && !Array.isArray(rawFolderTemplates)
      ? Object.fromEntries(Object.entries(rawFolderTemplates as Record<string, unknown>).filter((item): item is [string, string] => typeof item[1] === 'string'))
      : {};
    attachmentPolicy = rawAttachmentPolicy === 'note-folder' ? 'note-folder' : 'folder';
    attachmentFolderId = typeof rawAttachmentFolder === 'string' && rawAttachmentFolder ? rawAttachmentFolder as EntryId : null;
    preferencesVaultId = vault.id;
    fileSort.value = sortMode;
    foldersFirstToggle.checked = foldersFirst;
    autoUpdateLinksToggle.checked = autoUpdateLinks;
    fileFilter.value = filterText;
    dailyFormatInput.value = dailyFormat;
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
      invalidateGraphModel();
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
      searchIndexedVersions.clear();
      searchMetadata.clear();
      searchResults = [];
      searchFacets = { tags: [], properties: [] };
      searchStats = { documents: 0, tokens: 0, tags: 0, properties: 0 };
      recentEntries = [];
      searchIndexStatus.textContent = 'Index idle';
      searchStatus.textContent = 'No vault open.';
      fileFilter.value = '';
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-command="file.create"],[data-command="folder.create"],[data-command="vault.export"],[data-command="vault.backup"],[data-action="vault-rename"],[data-action="attachment-upload"],[data-action="graph-open"]')) button.disabled = !vault;
    element<HTMLButtonElement>('[data-action="recovery"]').disabled = !vault;
    renderTree(); renderInfo(); renderKnowledgePanels(); renderFacets(); renderSearchResults(); renderPlanningSettings(); renderTasks(); renderMedia(); renderCalendar(); updateVaultCounts();
    if (graphOpen) renderGraph();
  }
  function updateVaultCounts(): void {
    const active = entries.filter(entry => entry.deletedAt === null);
    element<HTMLElement>('.vault-counts').textContent = vault ? `${active.filter(entry => entry.kind === 'markdown').length} notes · ${active.filter(entry => entry.kind === 'attachment').length} media · ${active.filter(entry => entry.kind === 'directory').length} folders` : '';
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
        row.setAttribute('aria-label', `${entry.kind === 'directory' ? 'Folder' : entry.kind === 'attachment' ? 'Attachment' : 'Note'} ${entry.name}`);
        const icon = document.createElement('span'); icon.className = 'file-icon'; icon.textContent = entry.kind === 'directory' ? '\u25b1' : entry.kind === 'attachment' ? '\u25c7' : '\u00b7';
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
          shell.addEventListener('dragover', event => {
            const carriesEntry = !!draggedEntryId || event.dataTransfer?.types.includes('text/plain') === true;
            if (!carriesEntry || draggedEntryId === entry.id) return;
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
            shell.classList.add('drop-target');
          });
          shell.addEventListener('dragleave', () => shell.classList.remove('drop-target'));
          shell.addEventListener('drop', event => {
            event.preventDefault(); shell.classList.remove('drop-target');
            const sourceId = (draggedEntryId ?? event.dataTransfer?.getData('text/plain')) as EntryId | undefined;
            if (!sourceId || sourceId === entry.id) return;
            draggedEntryId = undefined;
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
    const descendants = entry.kind === 'directory'
      ? new VaultTree(oldEntries).descendants(entry.id)
      : [];
    const affectedIds: EntryId[] = entry.kind === 'markdown'
      ? [entry.id]
      : descendants.filter(item => item.kind === 'markdown' && item.deletedAt === null).map(item => item.id);
    const affectedAttachmentIds: EntryId[] = entry.kind === 'attachment'
      ? [entry.id]
      : descendants.filter(item => item.kind === 'attachment' && item.deletedAt === null).map(item => item.id);

    const moved = await repository.move(entry.id, parentId, name, entry.localVersion);
    const locationChanged = moved.parentId !== entry.parentId || moved.name !== entry.name;
    await refresh();

    if (autoUpdateLinks && locationChanged && (affectedIds.length || affectedAttachmentIds.length)) {
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
      for (const targetEntryId of affectedAttachmentIds) {
        await updateAttachmentLinksAfterMove({
          targetEntryId,
          oldEntries,
          newEntries: entries,
          repository,
          index: knowledge,
        });
        revokeAttachmentUrl(targetEntryId);
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
  function propertySourceText(): string | null {
    return selected?.kind === 'markdown' ? (saver?.draft ?? editor.getText()) : null;
  }

  function schedulePropertiesRender(text: string): void {
    if (propertyRenderTimer !== undefined) window.clearTimeout(propertyRenderTimer);
    propertyRenderTimer = window.setTimeout(() => {
      propertyRenderTimer = undefined;
      if (selected?.kind === 'markdown' && editor.getText() === text) renderPropertiesPanel(text);
    }, 180);
  }

  function renderPropertiesPanel(source: string | null = propertySourceText()): void {
    const list = element<HTMLElement>('.properties-list');
    const status = element<HTMLElement>('.properties-status');
    const add = element<HTMLButtonElement>('[data-property-action="add"]');
    const sourceButton = element<HTMLButtonElement>('[data-property-action="source"]');
    list.replaceChildren();

    if (!selected || selected.kind !== 'markdown' || source === null) {
      status.textContent = 'Open a Markdown note to edit properties.';
      status.classList.remove('properties-warning');
      add.disabled = true;
      sourceButton.disabled = true;
      return;
    }

    sourceButton.disabled = false;
    add.disabled = selected.deletedAt !== null;

    const view = inspectFrontmatter(source);
    if (view.status === 'invalid' || view.status === 'unsupported-root') {
      status.textContent = view.message ?? 'This frontmatter cannot be edited visually.';
      status.classList.add('properties-warning');
      add.disabled = true;
      return;
    }

    status.classList.remove('properties-warning');
    if (selected.deletedAt !== null) {
      status.textContent = 'This note is in Trash. Properties are read only.';
    } else {
      status.textContent = view.properties.length
        ? `${view.properties.length} ${view.properties.length === 1 ? 'property' : 'properties'} · stored in YAML frontmatter`
        : 'No properties yet. Add one without leaving Markdown.';
    }

    for (const property of view.properties) {
      const row = document.createElement('div');
      row.className = 'property-row';
      row.dataset.propertyName = property.name;

      const name = document.createElement('input');
      name.className = 'property-name';
      name.value = property.name;
      name.setAttribute('aria-label', `Property name: ${property.name}`);
      name.dataset.propertyRole = 'name';
      name.disabled = selected.deletedAt !== null;

      const type = document.createElement('select');
      type.className = 'property-type';
      type.dataset.propertyRole = 'type';
      type.setAttribute('aria-label', `Property type: ${property.name}`);
      for (const [value, label] of [
        ['text', 'Text'], ['number', 'Number'], ['checkbox', 'Checkbox'], ['date', 'Date'],
        ['list', 'List'], ['tags', 'Tags'], ['null', 'Null'], ['unsupported', 'Complex YAML'],
      ] as const) {
        const option = new Option(label, value);
        if (value === property.kind) option.selected = true;
        if (value === 'unsupported' && property.kind !== 'unsupported') option.disabled = true;
        type.add(option);
      }
      type.disabled = selected.deletedAt !== null || !property.editable;

      const valueWrap = document.createElement('div');
      valueWrap.className = 'property-value-wrap';
      if (property.kind === 'checkbox') {
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'property-value property-checkbox';
        input.dataset.propertyRole = 'value';
        input.checked = property.value === true;
        input.disabled = selected.deletedAt !== null;
        input.setAttribute('aria-label', `Property value: ${property.name}`);
        valueWrap.append(input);
      } else if (property.kind === 'unsupported') {
        const summary = document.createElement('code');
        summary.className = 'property-complex';
        summary.textContent = property.summary || '[complex YAML]';
        valueWrap.append(summary);
      } else if (property.kind === 'null') {
        const nullValue = document.createElement('span');
        nullValue.className = 'property-null';
        nullValue.textContent = 'null';
        valueWrap.append(nullValue);
      } else {
        const input = document.createElement('input');
        input.className = 'property-value';
        input.dataset.propertyRole = 'value';
        input.type = property.kind === 'number' ? 'number' : property.kind === 'date' ? 'date' : 'text';
        input.value = rawValueForProperty(property);
        input.disabled = selected.deletedAt !== null;
        input.setAttribute('aria-label', `Property value: ${property.name}`);
        if (property.kind === 'list') input.placeholder = 'value 1, value 2';
        if (property.kind === 'tags') input.placeholder = 'tag, nested/tag';
        valueWrap.append(input);
      }

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'property-delete';
      remove.dataset.propertyAction = 'delete';
      remove.textContent = '×';
      remove.title = `Delete ${property.name}`;
      remove.setAttribute('aria-label', `Delete property ${property.name}`);
      remove.disabled = selected.deletedAt !== null;

      row.append(name, type, valueWrap, remove);
      list.append(row);
    }
  }

  async function commitPropertySource(nextText: string, rerenderProperties = true): Promise<void> {
    if (!selected || selected.kind !== 'markdown' || selected.deletedAt !== null || !saver) {
      throw new VaultError('UNSUPPORTED', 'Properties can only be changed on an active Markdown note.');
    }
    if (nextText === editor.getText()) {
      if (rerenderProperties) renderPropertiesPanel(nextText);
      return;
    }
    editor.setText(nextText);
    saver.update(nextText);
    await saver.flush();
    await refreshKnowledgeEntry(selected.id);
    if (rerenderProperties) renderPropertiesPanel(nextText);
    if (editorMode === 'reading') await renderReadingCurrent();
  }

  async function openFrontmatterSource(): Promise<void> {
    if (!selected || selected.kind !== 'markdown') return;
    if (editorMode !== 'source') await setEditorMode('source');
    editor.revealOffset(0);
    workspace.dataset.knowledgeOpen = 'false';
  }

  function renderInfo(): void {
    const info = element<HTMLElement>('.file-info'); info.replaceChildren();
    const data = selected
      ? [['Format', selected.kind === 'markdown' ? 'Markdown (.md)' : selected.kind === 'attachment' ? 'Attachment' : 'Folder'], ['Local version', String(selected.localVersion)], ['Storage', 'This browser only'], ['File ID', selected.id]]
      : [['Notes', String(entries.filter(entry => entry.kind === 'markdown' && !entry.deletedAt).length)], ['Attachments', String(entries.filter(entry => entry.kind === 'attachment' && !entry.deletedAt).length)], ['Folders', String(entries.filter(entry => entry.kind === 'directory' && !entry.deletedAt).length)], ['Cloud sync', 'Not active']];
    element<HTMLButtonElement>('[data-action="graph-local"]').disabled = !selected || selected.deletedAt !== null || selected.kind === 'directory';
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
    invalidateGraphModel();
    renderKnowledgePanels();
    renderTasks();
    renderMedia();
    renderCalendar();
    if (graphOpen) renderGraph();
    editor.refreshPreview();
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
    const rawAttachmentTarget = target.split('#', 1)[0] ?? target;
    const attachment = resolveAttachmentTarget(rawAttachmentTarget, sourceEntryId, entries);
    if (attachment.status === 'ambiguous') {
      throw new VaultError('COLLISION', 'This attachment link is ambiguous. Use its folder-qualified path.');
    }
    if (attachment.status === 'resolved') {
      await openEntry(attachment.entryId);
      return;
    }

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

  async function moveBoardCard(entryId: EntryId, plan: BoardPlan, columnValue: string | null): Promise<void> {
    const entry = entries.find(item => item.id === entryId && item.kind === 'markdown' && item.deletedAt === null);
    if (!entry) throw new VaultError('NOT_FOUND', 'This board card is no longer available.');

    if (selected?.id === entryId && saver) {
      await saver.flush();
      const source = saver.draft;
      const next = columnValue === null
        ? deleteFrontmatterProperty(source, plan.groupProperty)
        : setFrontmatterProperty(source, plan.groupProperty, columnValue);
      if (next === source) return;
      editor.setText(next);
      saver.update(next);
      await saver.flush();
      await refreshKnowledgeEntry(entryId);
    } else {
      const file = await repository.read(entryId);
      if (!file.content || file.entry.kind !== 'markdown' || file.entry.deletedAt !== null) {
        throw new VaultError('NOT_FOUND', 'This board card is no longer available.');
      }
      const next = columnValue === null
        ? deleteFrontmatterProperty(file.content.text, plan.groupProperty)
        : setFrontmatterProperty(file.content.text, plan.groupProperty, columnValue);
      if (next === file.content.text) return;
      const saved = await repository.saveMarkdown(entryId, next, file.entry.localVersion);
      await knowledge.upsert(saved, next);
      const at = entries.findIndex(item => item.id === saved.id);
      if (at >= 0) entries[at] = saved;
      dirtyIds.add(saved.id);
      await refreshSearchEntry(saved.id);
      invalidateGraphModel();
      renderTree();
      renderKnowledgePanels();
      renderTasks();
      renderMedia();
      renderCalendar();
      if (graphOpen) renderGraph();
      editor.refreshPreview();
    }

    if (editorMode === 'reading' && selected?.kind === 'markdown') await renderReadingCurrent();
  }

  function boardCardDetails(card: BoardCard, plan: BoardPlan): string[] {
    const details: string[] = [];
    for (const field of plan.cardFields) {
      if (field === 'file' || field === 'path') continue;
      const value = card.values[field];
      if (value) details.push(`${boardFieldLabel(field)}: ${value}`);
    }
    return details;
  }

  function renderBoardBlock(source: string, sourceEntryId?: string): HTMLElement {
    const plan = parseBoard(source);
    const currentEntryId = sourceEntryId && entries.some(entry => entry.id === sourceEntryId)
      ? sourceEntryId as EntryId
      : selected?.id;
    const result = runBoard(plan, entries, knowledge.records(), {
      ...(currentEntryId ? { currentEntryId } : {}),
      pathOf,
    });

    const section = document.createElement('section');
    section.className = `board-view board-layout-${plan.layout}`;
    section.dataset.boardProperty = plan.groupProperty;

    const header = document.createElement('header');
    header.className = 'board-view-header';
    const heading = document.createElement('strong');
    heading.textContent = plan.title ?? `Board by ${plan.groupProperty}`;
    const meta = document.createElement('span');
    meta.textContent = result.truncated || result.shown !== result.total
      ? `${result.shown} of ${result.total} cards · ${result.columns.length} lane${result.columns.length === 1 ? '' : 's'}`
      : `${result.total} card${result.total === 1 ? '' : 's'} · ${result.columns.length} lane${result.columns.length === 1 ? '' : 's'}`;
    header.append(heading, meta);
    section.append(header);

    if (plan.query) {
      const query = document.createElement('code');
      query.className = 'board-query-expression';
      query.textContent = plan.query;
      section.append(query);
    }

    const lanes = document.createElement('div');
    lanes.className = 'board-columns';
    lanes.setAttribute('role', 'list');

    for (const column of result.columns) {
      const lane = document.createElement('section');
      lane.className = 'board-column';
      lane.dataset.boardColumn = column.value ?? '';
      lane.setAttribute('role', 'listitem');

      const laneHeader = document.createElement('header');
      laneHeader.className = 'board-column-header';
      const laneTitle = document.createElement('strong');
      laneTitle.textContent = column.label;
      const count = document.createElement('span');
      count.textContent = String(column.cards.length);
      laneHeader.append(laneTitle, count);
      lane.append(laneHeader);

      const cards = document.createElement('div');
      cards.className = 'board-card-list';
      cards.dataset.boardDrop = column.value ?? '';
      cards.addEventListener('dragover', event => {
        if (!event.dataTransfer?.types.includes('application/x-vault-board-entry')) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        cards.classList.add('drop-target');
      });
      cards.addEventListener('dragleave', event => {
        if (!cards.contains(event.relatedTarget as Node | null)) cards.classList.remove('drop-target');
      });
      cards.addEventListener('drop', event => {
        const raw = event.dataTransfer?.getData('application/x-vault-board-entry');
        cards.classList.remove('drop-target');
        if (!raw) return;
        event.preventDefault();
        perform(() => moveBoardCard(raw as EntryId, plan, column.value));
      });

      for (const card of column.cards) {
        const article = document.createElement('article');
        article.className = 'board-card';
        article.dataset.boardCard = card.entryId;
        article.draggable = true;
        article.addEventListener('dragstart', event => {
          event.dataTransfer?.setData('application/x-vault-board-entry', card.entryId);
          if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
          article.classList.add('dragging');
        });
        article.addEventListener('dragend', () => article.classList.remove('dragging'));

        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'board-card-title';
        open.dataset.boardEntry = card.entryId;
        open.textContent = card.title;

        const path = document.createElement('span');
        path.className = 'board-card-path';
        path.textContent = card.path;
        article.append(open, path);

        const detailValues = boardCardDetails(card, plan);
        if (detailValues.length) {
          const details = document.createElement('div');
          details.className = 'board-card-details';
          for (const value of detailValues) {
            const item = document.createElement('span');
            item.textContent = value;
            details.append(item);
          }
          article.append(details);
        }

        const moveLabel = document.createElement('label');
        moveLabel.className = 'board-card-move-label';
        const sr = document.createElement('span');
        sr.className = 'sr-only';
        sr.textContent = `Move ${card.title} to lane`;
        const select = document.createElement('select');
        select.className = 'board-card-move';
        select.setAttribute('aria-label', `Move ${card.title} to lane`);
        for (const target of result.columns) {
          const option = new Option(target.label, target.value ?? '');
          if ((card.columnValue ?? '') === (target.value ?? '')) option.selected = true;
          select.add(option);
        }
        select.addEventListener('change', () => {
          const target = result.columns.find(item => (item.value ?? '') === select.value);
          if (target) perform(() => moveBoardCard(card.entryId, plan, target.value));
        });
        moveLabel.append(sr, select);
        article.append(moveLabel);
        cards.append(article);
      }

      if (!column.cards.length) {
        const empty = document.createElement('p');
        empty.className = 'board-column-empty';
        empty.textContent = 'Drop cards here';
        cards.append(empty);
      }
      lane.append(cards);
      lanes.append(lane);
    }

    section.append(lanes);
    return section;
  }

  function renderDynamicQueryBlock(source: string, sourceEntryId?: string): HTMLElement {
    const plan = parseDynamicQuery(source);
    const currentEntryId = sourceEntryId && entries.some(entry => entry.id === sourceEntryId)
      ? sourceEntryId as EntryId
      : selected?.id;
    const result = runDynamicQuery(plan, entries, knowledge.records(), {
      ...(currentEntryId ? { currentEntryId } : {}),
      pathOf,
    });

    const section = document.createElement('section');
    section.className = 'query-view';
    section.dataset.queryView = plan.view;

    const header = document.createElement('header');
    header.className = 'query-view-header';
    const heading = document.createElement('strong');
    heading.textContent = plan.title ?? (plan.view === 'table' ? 'Dynamic table' : plan.view === 'tasks' ? 'Dynamic tasks' : 'Dynamic list');
    const meta = document.createElement('span');
    const shown = plan.view === 'tasks' ? result.tasks.length : result.notes.length;
    meta.textContent = result.truncated ? `${shown} of ${result.total}` : `${result.total} result${result.total === 1 ? '' : 's'}`;
    header.append(heading, meta);
    section.append(header);

    if (plan.query) {
      const query = document.createElement('code');
      query.className = 'query-expression';
      query.textContent = plan.query;
      section.append(query);
    }

    if (result.total === 0) {
      const empty = document.createElement('p');
      empty.className = 'query-empty';
      empty.textContent = plan.view === 'tasks' ? 'No tasks match this view.' : 'No notes match this view.';
      section.append(empty);
      return section;
    }

    if (plan.view === 'list') {
      const list = document.createElement('div');
      list.className = 'query-note-list';
      for (const row of result.notes) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'query-note-row';
        button.dataset.queryEntry = row.entryId;
        const title = document.createElement('span');
        title.className = 'query-note-title';
        title.textContent = row.title;
        const path = document.createElement('span');
        path.className = 'query-note-path';
        path.textContent = row.path;
        button.append(title, path);
        const extras = plan.fields.filter(field => field !== 'file' && field !== 'path')
          .map(field => row.values[field]).filter(Boolean);
        if (extras.length) {
          const detail = document.createElement('span');
          detail.className = 'query-note-detail';
          detail.textContent = extras.join(' · ');
          button.append(detail);
        }
        list.append(button);
      }
      section.append(list);
      return section;
    }

    if (plan.view === 'table') {
      const wrap = document.createElement('div');
      wrap.className = 'query-table-wrap';
      const table = document.createElement('table');
      table.className = 'query-table';
      const thead = document.createElement('thead');
      const headerRow = document.createElement('tr');
      const needsOpenColumn = !plan.fields.includes('file');
      if (needsOpenColumn) {
        const cell = document.createElement('th');
        cell.scope = 'col';
        cell.textContent = 'Open';
        headerRow.append(cell);
      }
      for (const field of plan.fields) {
        const cell = document.createElement('th');
        cell.scope = 'col';
        cell.textContent = dynamicFieldLabel(field);
        headerRow.append(cell);
      }
      thead.append(headerRow);
      const tbody = document.createElement('tbody');
      for (const row of result.notes) {
        const tr = document.createElement('tr');
        if (needsOpenColumn) {
          const cell = document.createElement('td');
          const open = document.createElement('button');
          open.type = 'button';
          open.className = 'query-table-open';
          open.dataset.queryEntry = row.entryId;
          open.textContent = 'Open';
          cell.append(open);
          tr.append(cell);
        }
        for (const field of plan.fields) {
          const cell = document.createElement('td');
          if (field === 'file') {
            const open = document.createElement('button');
            open.type = 'button';
            open.className = 'query-table-file';
            open.dataset.queryEntry = row.entryId;
            open.textContent = row.values[field] || row.title;
            cell.append(open);
          } else {
            cell.textContent = row.values[field] ?? '';
          }
          tr.append(cell);
        }
        tbody.append(tr);
      }
      table.append(thead, tbody);
      wrap.append(table);
      section.append(wrap);
      return section;
    }

    const taskList = document.createElement('div');
    taskList.className = 'query-task-list';
    for (const row of result.tasks) {
      const entry = entries.find(item => item.id === row.entryId);
      if (!entry) continue;
      const holder = document.createElement('article');
      holder.className = 'query-task-row';
      if (row.task.completed) holder.classList.add('completed');
      assignTaskDataset(holder, { entry, path: row.path, task: row.task });

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = row.task.completed;
      checkbox.dataset.taskRole = 'completed';
      checkbox.setAttribute('aria-label', `Complete task: ${row.task.text}`);

      const body = document.createElement('div');
      body.className = 'query-task-body';
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'query-task-title';
      open.dataset.taskAction = 'source';
      open.textContent = row.task.text;
      const detail = document.createElement('span');
      detail.className = 'query-task-detail';
      const details = [row.path];
      if (row.task.scheduled) details.push(`Scheduled ${row.task.scheduled}`);
      if (row.task.due) details.push(`Due ${row.task.due}`);
      if (row.task.priority) details.push(`${row.task.priority} priority`);
      if (row.task.recurrence) details.push(`Repeats ${row.task.recurrence}`);
      detail.textContent = details.join(' · ');
      body.append(open, detail);
      holder.append(checkbox, body);
      taskList.append(holder);
    }
    section.append(taskList);
    return section;
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
      query: {
        async render(source, sourceEntryId) {
          return renderDynamicQueryBlock(source, sourceEntryId);
        },
      },
      board: {
        async render(source, sourceEntryId) {
          return renderBoardBlock(source, sourceEntryId);
        },
      },
      attachment: {
        status(target, sourceEntryId) {
          const source = sourceEntryId && entries.some(entry => entry.id === sourceEntryId) ? sourceEntryId as EntryId : rootEntryId;
          return resolveAttachmentTarget(target, source, entries).status;
        },
        async load(target, sourceEntryId) {
          return await attachmentRenderPayload(target, sourceEntryId);
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
    attachmentView.hidden = selected?.kind !== 'attachment';
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
    if (selected?.kind === 'attachment') await renderAttachmentViewer();
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
    if (selected.kind !== 'markdown') renderPropertiesPanel(null);
    if (selected.kind === 'markdown' && item.content) {
      editor.setText(item.content.text);
      renderPropertiesPanel(item.content.text);
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
    const pendingCursor = pendingCursorOffsets.get(selected.id);
    if (pendingCursor !== undefined && selected.kind === 'markdown' && selected.deletedAt === null) { pendingCursorOffsets.delete(selected.id); editor.revealOffset(pendingCursor); }
    renderTree(); renderInfo(); renderKnowledgePanels(); updateDailyDocumentNav(); renderTasks(); renderMedia(); renderCalendar(); updateCounts();
    if (graphOpen) renderGraph();
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
    selected = undefined; renderGeneration++; editorHost.hidden = true; readingView.hidden = true; readingView.replaceChildren(); attachmentView.hidden = true; attachmentPreview.replaceChildren(); editor.setReadOnly(true); editor.setText(''); renderPropertiesPanel(null);
    element<HTMLElement>('.empty-state').hidden = false;
    element<HTMLElement>('.folder-message').hidden = true;
    element<HTMLElement>('.breadcrumb').textContent = 'No file selected';
    element<HTMLElement>('.save-status').textContent = 'No file open';
    for (const action of ['reopen', 'retry-save']) element<HTMLElement>(`[data-action="${action}"]`).hidden = true;
    errorBox.hidden = true;
    for (const action of ['rename', 'move', 'duplicate', 'delete', 'export-draft', 'checkpoint']) element<HTMLButtonElement>(`[data-action="${action}"]`).disabled = true;
    element<HTMLElement>('[data-action="restore"]').hidden = true;
    await syncEditorSurface();
    updateDailyDocumentNav(); renderTasks(); renderMedia(); renderCalendar(); updateCounts();
    if (graphOpen) renderGraph();
  }

  registry.register({ id: 'vault.create', label: 'Create vault', run: async () => {
    const name = await ask('Create a vault', 'Vault name'); if (name === null) return;
    await clearSelection(); vault = await repository.createVault(name); preferencesVaultId = undefined; showingTrash = false; filterText = ''; await refresh(); await setting('lastVault', vault.id);
  } });
  for (const kind of ['markdown', 'directory'] as const) registry.register({ id: kind === 'markdown' ? 'file.create' : 'folder.create', label: kind === 'markdown' ? 'Create Markdown note' : 'Create folder', enabled: () => !!vault, run: async () => {
    if (!vault) return;
    const name = await ask(kind === 'markdown' ? 'Create a Markdown note' : 'Create a folder', 'Name'); if (name === null) return;
    if (saver) await saver.flush();
    const parentId = parentForNew();
    const entry = kind === 'markdown'
      ? await createMarkdownNote(parentId, name)
      : await repository.createEntry(vault.id, parentId, name, kind);
    showingTrash = false; await refresh(); await openEntry(entry.id);
    if (kind === 'markdown') editor.focus();
  } });
  registry.register({ id: 'vault.export', label: 'Export active vault ZIP', enabled: () => !!vault, run: async () => {
    if (!vault) return; if (saver) await saver.flush();
    const bytes = zipStore(vaultFiles(await repository.snapshot(vault.id)));
    download(`${vault.name}.zip`, new Uint8Array(bytes).buffer, 'application/zip');
  } });
  registry.register({ id: 'vault.backup', label: 'Export recovery backup', enabled: () => !!vault, run: async () => {
    if (!vault) return;
    // A failed writer must not prevent exporting previously durable notes and recovery drafts.
    if (saver?.hasUnsavedChanges) downloadDraft();
    download(`${vault.name}-recovery.json`, JSON.stringify(await repository.snapshot(vault.id), null, 2), 'application/json');
  } });

  root.addEventListener('click', event => {
    const taskAction = (event.target as Element).closest<HTMLButtonElement>('[data-task-action]');
    if (taskAction?.dataset.taskAction) {
      const action = taskAction.dataset.taskAction;
      if (action === 'add') { perform(addTaskToCurrentNote); return; }
      if (action === 'source') {
        const holder = taskAction.closest<HTMLElement>('[data-task-entry]');
        const item = holder ? taskItemFromDataset(holder) : null;
        if (item) perform(() => openTaskSource(item.entryId, item.task.from));
        return;
      }
    }

    const propertyAction = (event.target as Element).closest<HTMLButtonElement>('[data-property-action]');
    if (propertyAction?.dataset.propertyAction) {
      const action = propertyAction.dataset.propertyAction;
      if (action === 'source') { perform(openFrontmatterSource); return; }
      if (action === 'add') {
        perform(async () => {
          const source = propertySourceText();
          if (source === null) return;
          const name = await ask('Add property', 'Property name');
          if (name === null) return;
          const normalizedName = name.trim();
          const current = inspectFrontmatter(source);
          if (current.properties.some(property => property.name === normalizedName)) throw new VaultError('COLLISION', `A property named "${normalizedName}" already exists.`);
          const next = setFrontmatterProperty(source, normalizedName, '');
          await commitPropertySource(next);
          const row = [...root.querySelectorAll<HTMLElement>('.property-row')].find(item => item.dataset.propertyName === normalizedName);
          row?.querySelector<HTMLInputElement>('.property-value')?.focus();
        });
        return;
      }
      if (action === 'delete') {
        const row = propertyAction.closest<HTMLElement>('.property-row');
        const name = row?.dataset.propertyName;
        if (!name) return;
        perform(async () => {
          const source = propertySourceText();
          if (source === null) return;
          await commitPropertySource(deleteFrontmatterProperty(source, name));
        });
        return;
      }
    }

    const panelButton = (event.target as Element).closest<HTMLButtonElement>('[data-sidebar-panel]');
    if (panelButton?.dataset.sidebarPanel) {
      const panel = panelButton.dataset.sidebarPanel;
      if (panel === 'files' || panel === 'search' || panel === 'tags' || panel === 'tasks' || panel === 'media' || panel === 'calendar') switchSidebarPanel(panel);
      return;
    }

    const mediaEntryButton = (event.target as Element).closest<HTMLButtonElement>('[data-media-entry]');
    if (mediaEntryButton?.dataset.mediaEntry) {
      perform(() => openEntry(mediaEntryButton.dataset.mediaEntry as EntryId));
      return;
    }

    const graphEntryButton = (event.target as Element).closest<HTMLButtonElement>('[data-graph-entry]');
    if (graphEntryButton?.dataset.graphEntry) {
      perform(async () => {
        closeGraph();
        await openEntry(graphEntryButton.dataset.graphEntry as EntryId);
      });
      return;
    }

    const graphActionButton = (event.target as Element).closest<HTMLButtonElement>('[data-graph-action]');
    if (graphActionButton?.dataset.graphAction) {
      if (graphActionButton.dataset.graphAction === 'zoom-in') graphCanvasView.zoomBy(1.18);
      else if (graphActionButton.dataset.graphAction === 'zoom-out') graphCanvasView.zoomBy(0.84);
      else if (graphActionButton.dataset.graphAction === 'fit') graphCanvasView.fit();
      return;
    }

    const calendarDateButton = (event.target as Element).closest<HTMLButtonElement>('[data-calendar-date]');
    if (calendarDateButton?.dataset.calendarDate) {
      const parts = calendarDateButton.dataset.calendarDate.split('-').map(Number);
      const date = new Date(parts[0]!, parts[1]! - 1, parts[2]!, 12, 0, 0, 0);
      calendarSelectedKey = calendarDateButton.dataset.calendarDate;
      perform(() => openOrCreateDaily(date));
      return;
    }

    const calendarEntryButton = (event.target as Element).closest<HTMLButtonElement>('[data-calendar-entry]');
    if (calendarEntryButton?.dataset.calendarEntry) {
      perform(() => openEntry(calendarEntryButton.dataset.calendarEntry as EntryId));
      return;
    }

    const dailyNavButton = (event.target as Element).closest<HTMLButtonElement>('[data-daily-nav]');
    if (dailyNavButton?.dataset.dailyNav !== undefined) {
      const delta = Number(dailyNavButton.dataset.dailyNav);
      if (Number.isInteger(delta)) perform(() => navigateDaily(delta));
      return;
    }

    const calendarActionButton = (event.target as Element).closest<HTMLButtonElement>('[data-calendar-action]');
    if (calendarActionButton?.dataset.calendarAction) {
      if (calendarActionButton.dataset.calendarAction === 'prev-month') calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() - 1, 1, 12, 0, 0, 0);
      else if (calendarActionButton.dataset.calendarAction === 'next-month') calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + 1, 1, 12, 0, 0, 0);
      renderCalendar();
      return;
    }

    const queryEntryButton = (event.target as Element).closest<HTMLButtonElement>('[data-query-entry]');
    if (queryEntryButton?.dataset.queryEntry) {
      perform(() => openEntry(queryEntryButton.dataset.queryEntry as EntryId));
      return;
    }

    const boardEntryButton = (event.target as Element).closest<HTMLButtonElement>('[data-board-entry]');
    if (boardEntryButton?.dataset.boardEntry) {
      perform(() => openEntry(boardEntryButton.dataset.boardEntry as EntryId));
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
      if (graphOpen) closeGraph();
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
    if (action === 'files') {
      const open = workspace.dataset.sidebarOpen !== 'true';
      workspace.dataset.sidebarOpen = String(open);
      button.setAttribute('aria-expanded', String(open));
      if (open) switchSidebarPanel('files');
      return;
    }
    if (action === 'quick-switcher') { void openQuickSwitcher().catch(showError); return; }
    if (action === 'graph-open') { perform(() => openGraph('full')); return; }
    if (action === 'graph-local') { perform(() => openGraph('local')); return; }
    if (action === 'graph-close') { closeGraph(); return; }
    if (action === 'attachment-upload') { attachmentFileInput.click(); return; }
    if (action === 'attachment-download') {
      if (selected?.kind !== 'attachment') return;
      perform(async () => {
        const attachment = await repository.readAttachment(selected!.id);
        download(selected!.name, attachment.bytes, attachment.mimeType);
      });
      return;
    }
    if (action === 'insert-template') {
      perform(async () => {
        if (!selected || selected.kind !== 'markdown' || selected.deletedAt !== null) return;
        const templateId = await chooseTemplate('Insert template');
        if (!templateId) return;
        if (editorMode === 'reading') await setEditorMode('live');
        const rendered = await renderTemplateEntry(templateId, selected.name.replace(/\.md$/iu, ''), new Date());
        editor.insertText(rendered.text, rendered.cursorOffset);
      });
      return;
    }
    if (action === 'insert-query') {
      perform(async () => {
        if (!selected || selected.kind !== 'markdown' || selected.deletedAt !== null) return;
        if (editorMode === 'reading') await setEditorMode('live');
        editor.insertText([
          '```vault-query',
          'view: table',
          'query: tag:#project',
          'fields: file, path, tags, property:status',
          'sort: updated desc',
          'limit: 25',
          'exclude-self: true',
          '```',
          '',
        ].join('\n'));
      });
      return;
    }
    if (action === 'insert-board') {
      perform(async () => {
        if (!selected || selected.kind !== 'markdown' || selected.deletedAt !== null) return;
        if (editorMode === 'reading') await setEditorMode('live');
        editor.insertText([
          '```vault-board',
          'title: Project board',
          'query: tag:#project',
          'group-by: property:status',
          'columns: backlog=Backlog, todo=To do, doing=Doing, done=Done',
          'card-fields: tags, property:priority, updated',
          'sort: updated desc',
          'limit: 200',
          'exclude-self: true',
          '```',
          '',
        ].join('\n'));
      });
      return;
    }
    if (action === 'create-from-template') {
      perform(async () => {
        if (!vault) return;
        const templateId = await chooseTemplate('Create note from template');
        if (!templateId) return;
        const name = await ask('Create from template', 'Name');
        if (name === null) return;
        if (saver) await saver.flush();
        const entry = await createMarkdownNote(parentForNew(), name, templateId);
        showingTrash = false;
        await refresh();
        await openEntry(entry.id);
        editor.focus();
      });
      return;
    }
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
      if (action === 'delete') {
        const deletedId = selected.id;
        await repository.trash(selected.id, selected.localVersion);
        revokeAttachmentUrl(deletedId);
        if (saver) await saver.close();
        saver = undefined;
        await clearSelection();
        await refresh();
      }
      if (action === 'restore') { await repository.restore(selected.id); const id = selected.id; showingTrash = false; await refresh(); await openEntry(id); }
    });
  }, { signal: abort.signal });
  graphModeSelect.addEventListener('change', () => {
    graphMode = graphModeSelect.value === 'local' ? 'local' : 'full';
    renderGraph();
  }, { signal: abort.signal });
  graphDepthSelect.addEventListener('change', () => {
    const value = Number(graphDepthSelect.value);
    graphDepth = Number.isInteger(value) ? Math.max(1, Math.min(4, value)) : 2;
    renderGraph();
  }, { signal: abort.signal });
  graphGroupSelect.addEventListener('change', () => {
    const value = graphGroupSelect.value;
    graphGroupMode = value === 'folder' || value === 'tag' || value === 'kind' || value === 'property' ? value : 'none';
    renderGraph();
  }, { signal: abort.signal });
  graphGroupPropertyInput.addEventListener('input', () => {
    graphGroupProperty = graphGroupPropertyInput.value;
    renderGraph();
  }, { signal: abort.signal });
  graphSearchInput.addEventListener('input', () => {
    graphSearchText = graphSearchInput.value;
    renderGraph(true);
  }, { signal: abort.signal });
  graphTagInput.addEventListener('input', () => {
    graphTagText = graphTagInput.value;
    renderGraph();
  }, { signal: abort.signal });
  graphPropertyInput.addEventListener('input', () => {
    graphPropertyText = graphPropertyInput.value;
    renderGraph();
  }, { signal: abort.signal });
  graphAttachmentsToggle.addEventListener('change', () => {
    graphIncludeAttachments = graphAttachmentsToggle.checked;
    renderGraph();
  }, { signal: abort.signal });
  graphOrphansToggle.addEventListener('change', () => {
    graphOrphanOnly = graphOrphansToggle.checked;
    renderGraph();
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
      if (graphOpen) closeGraph();
      perform(() => openEntry(result.entryId));
    }
  }, { signal: abort.signal });
  for (const control of [templatesFolderSelect, defaultTemplateSelect, dailyFolderSelect, dailyTemplateSelect, dailyFormatInput, folderTemplateFolder, folderTemplateTemplate]) {
    control.addEventListener('change', () => {
      const chosenValue = control.value;
      const chosenFolderId = folderTemplateFolder.value;
      perform(async () => {
        if (!vault) return;
        if (control === templatesFolderSelect) {
          templatesFolderId = chosenValue ? chosenValue as EntryId : null;
          await setting(`templatesFolder:${vault.id}`, templatesFolderId ?? '');
          if (defaultTemplateId && !templateEntries().some(entry => entry.id === defaultTemplateId)) defaultTemplateId = null;
          if (dailyTemplateId && !templateEntries().some(entry => entry.id === dailyTemplateId)) dailyTemplateId = null;
          await setting(`defaultTemplate:${vault.id}`, defaultTemplateId ?? '');
          await setting(`dailyTemplate:${vault.id}`, dailyTemplateId ?? '');
        } else if (control === defaultTemplateSelect) {
          defaultTemplateId = chosenValue ? chosenValue as EntryId : null;
          await setting(`defaultTemplate:${vault.id}`, defaultTemplateId ?? '');
        } else if (control === dailyFolderSelect) {
          dailyFolderId = chosenValue ? chosenValue as EntryId : null;
          await setting(`dailyFolder:${vault.id}`, dailyFolderId ?? '');
        } else if (control === dailyTemplateSelect) {
          dailyTemplateId = chosenValue ? chosenValue as EntryId : null;
          await setting(`dailyTemplate:${vault.id}`, dailyTemplateId ?? '');
        } else if (control === dailyFormatInput) {
          try {
            safeDailyFilename(new Date(), chosenValue);
            dailyFormat = chosenValue.trim() || 'YYYY-MM-DD';
            await setting(`dailyFormat:${vault.id}`, dailyFormat);
          } catch (error) {
            dailyFormatInput.value = dailyFormat;
            throw error;
          }
        } else if (control === folderTemplateFolder) {
          const template = folderTemplates[chosenValue] as EntryId | undefined;
          fillTemplateSelect(folderTemplateTemplate, template ?? null);
          return;
        } else if (control === folderTemplateTemplate) {
          if (!chosenFolderId) return;
          if (chosenValue) folderTemplates[chosenFolderId] = chosenValue;
          else delete folderTemplates[chosenFolderId];
          await setting(`folderTemplates:${vault.id}`, folderTemplates);
        }
        renderPlanningSettings();
        renderCalendar();
        updateDailyDocumentNav();
      });
    }, { signal: abort.signal });
  }

  root.addEventListener('change', event => {
    const control = (event.target as Element).closest<HTMLInputElement | HTMLSelectElement>('[data-task-role]');
    if (!control) return;
    const holder = control.closest<HTMLElement>('[data-task-entry]');
    const item = holder ? taskItemFromDataset(holder) : null;
    if (!item) return;
    const role = control.dataset.taskRole;
    const value = control instanceof HTMLInputElement && control.type === 'checkbox' ? '' : control.value;
    const checked = control instanceof HTMLInputElement && control.type === 'checkbox' ? control.checked : false;
    const patch: TaskPatch = {};
    if (role === 'completed') patch.completed = checked;
    else if (role === 'text') patch.text = value;
    else if (role === 'due') patch.due = value || null;
    else if (role === 'scheduled') patch.scheduled = value || null;
    else if (role === 'priority') patch.priority = (value || null) as TaskPriority | null;
    else if (role === 'recurrence') patch.recurrence = value || null;
    else return;
    perform(() => mutateTask(item.entryId, item.task, patch));
  }, { signal: abort.signal });

  root.addEventListener('change', event => {
    const control = (event.target as Element).closest<HTMLInputElement | HTMLSelectElement>('[data-property-role]');
    if (!control) return;
    const row = control.closest<HTMLElement>('.property-row');
    const oldName = row?.dataset.propertyName;
    const role = control.dataset.propertyRole;
    if (!row || !oldName || !role) return;

    const capturedValue = control instanceof HTMLInputElement && control.type === 'checkbox' ? '' : control.value;
    const capturedChecked = control instanceof HTMLInputElement && control.type === 'checkbox' ? control.checked : false;
    const capturedType = row.querySelector<HTMLSelectElement>('.property-type')?.value;
    perform(async () => {
      let success = false;
      try {
        const source = propertySourceText();
        if (source === null) return;
        if (role === 'name') {
          await commitPropertySource(renameFrontmatterProperty(source, oldName, capturedValue));
          success = true;
          return;
        }

        const view = inspectFrontmatter(source);
        const property = view.properties.find(item => item.name === oldName);
        if (!property || !property.editable) return;
        const kind = (role === 'type' ? capturedValue : capturedType) as PropertyKind | undefined;
        if (!kind || kind === 'unsupported') return;

        const raw = role === 'type' ? rawValueForProperty(property) : capturedValue;
        const checked = role === 'type' ? property.value === true : capturedChecked;
        const value = valueForKind(kind, raw, checked);
        await commitPropertySource(setFrontmatterProperty(source, oldName, value), role !== 'value');
        success = true;
      } finally {
        if (!success || role !== 'value') renderPropertiesPanel();
      }
    });
  }, { signal: abort.signal });

  attachmentFileInput.addEventListener('change', () => {
    const files = [...(attachmentFileInput.files ?? [])];
    attachmentFileInput.value = '';
    if (files.length) perform(() => uploadAttachmentFiles(files));
  }, { signal: abort.signal });

  attachmentPolicySelect.addEventListener('change', () => {
    if (attachmentPolicySelect.value !== 'folder' && attachmentPolicySelect.value !== 'note-folder') return;
    attachmentPolicy = attachmentPolicySelect.value;
    perform(async () => {
      if (vault) await setting(`attachmentPolicy:${vault.id}`, attachmentPolicy);
      renderMediaSettings();
    });
  }, { signal: abort.signal });

  attachmentFolderSelect.addEventListener('change', () => {
    attachmentFolderId = attachmentFolderSelect.value ? attachmentFolderSelect.value as EntryId : null;
    perform(async () => {
      if (vault) await setting(`attachmentFolder:${vault.id}`, attachmentFolderId ?? '');
      renderMediaSettings();
    });
  }, { signal: abort.signal });

  editorHost.addEventListener('paste', event => {
    const files = [...(event.clipboardData?.files ?? [])];
    if (!files.length) return;
    event.preventDefault();
    perform(() => uploadAttachmentFiles(files));
  }, { signal: abort.signal, capture: true });

  editorHost.addEventListener('dragover', event => {
    if (!(event.dataTransfer?.files.length)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  }, { signal: abort.signal, capture: true });

  editorHost.addEventListener('drop', event => {
    const files = [...(event.dataTransfer?.files ?? [])];
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();
    perform(() => uploadAttachmentFiles(files));
  }, { signal: abort.signal, capture: true });

  taskFilter.addEventListener('input', () => {
    taskFilterText = taskFilter.value;
    renderTasks();
  }, { signal: abort.signal });
  taskStatusSelect.addEventListener('change', () => {
    if (taskStatusSelect.value === 'open' || taskStatusSelect.value === 'done' || taskStatusSelect.value === 'all') taskStatusFilter = taskStatusSelect.value;
    renderTasks();
  }, { signal: abort.signal });
  taskDateSelect.addEventListener('change', () => {
    if (taskDateSelect.value === 'all' || taskDateSelect.value === 'overdue' || taskDateSelect.value === 'today' || taskDateSelect.value === 'upcoming' || taskDateSelect.value === 'undated') taskDateFilter = taskDateSelect.value;
    renderTasks();
  }, { signal: abort.signal });
  taskPrioritySelect.addEventListener('change', () => {
    if (taskPrioritySelect.value === 'all' || taskPrioritySelect.value === 'high' || taskPrioritySelect.value === 'medium' || taskPrioritySelect.value === 'low' || taskPrioritySelect.value === 'none') taskPriorityFilter = taskPrioritySelect.value;
    renderTasks();
  }, { signal: abort.signal });
  taskGroupSelect.addEventListener('change', () => {
    if (taskGroupSelect.value === 'date' || taskGroupSelect.value === 'note' || taskGroupSelect.value === 'priority' || taskGroupSelect.value === 'none') taskGroup = taskGroupSelect.value;
    renderTasks();
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
    const carriesEntry = !!draggedEntryId || event.dataTransfer?.types.includes('text/plain') === true;
    if (!carriesEntry || showingTrash || (event.target as Element).closest('.file-row-shell')) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    fileTree.classList.add('drop-root');
  }, { signal: abort.signal });
  fileTree.addEventListener('dragleave', event => {
    if (!fileTree.contains(event.relatedTarget as Node | null)) fileTree.classList.remove('drop-root');
  }, { signal: abort.signal });
  fileTree.addEventListener('drop', event => {
    if ((event.target as Element).closest('.file-row-shell')) return;
    event.preventDefault(); fileTree.classList.remove('drop-root');
    const sourceId = (draggedEntryId ?? event.dataTransfer?.getData('text/plain')) as EntryId | undefined;
    if (sourceId) {
      draggedEntryId = undefined;
      perform(() => moveByDrop(sourceId, null));
    }
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
    if (graphOpen && event.key === 'Escape') {
      event.preventDefault();
      closeGraph();
      return;
    }
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
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      perform(() => navigateDaily(0));
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); perform(async () => registry.execute('file.create')); return; }
    if (graphOpen) return;
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
    if (templateDialog.open) templateDialog.close('cancel');
    searchIndex.close();
    if (propertyRenderTimer !== undefined) window.clearTimeout(propertyRenderTimer);
    editor.destroy();
    graphCanvasView.destroy();
    for (const url of attachmentObjectUrls.values()) URL.revokeObjectURL(url);
    attachmentObjectUrls.clear();
    void (saver?.flush() ?? Promise.resolve()).catch(() => undefined).finally(() => db.close());
  };
}
