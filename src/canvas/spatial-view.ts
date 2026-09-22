import type { EntryId } from '../domain/model.js';
import {
  canvasBounds,
  canvasObjectId,
  cloneCanvasDocument,
  deleteCanvasNode,
  type CanvasDocument,
  type CanvasEdge,
  type CanvasGroup,
  type CanvasNode,
} from './model.js';

export interface CanvasNoteResolution {
  status: 'resolved' | 'ambiguous' | 'unresolved';
  entryId?: EntryId;
  title?: string;
  path?: string;
}

export interface CanvasMediaPayload {
  entryId: EntryId;
  name: string;
  mimeType: string;
  url: string;
}

export interface SpatialCanvasOptions {
  readOnly?: boolean;
  persist(document: CanvasDocument): Promise<void>;
  resolveNote(target: string): CanvasNoteResolution;
  loadMedia(target: string): Promise<CanvasMediaPayload | null>;
  openEntry(entryId: EntryId): void;
  requestValue(title: string, label: string, current?: string): Promise<string | null>;
  onError(error: unknown): void;
}

type Selection =
  | { kind: 'node'; id: string }
  | { kind: 'group'; id: string }
  | null;

interface Point { x: number; y: number }

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function snap(value: number, enabled: boolean): number {
  return enabled ? Math.round(value / 10) * 10 : Math.round(value * 100) / 100;
}

export class SpatialCanvasView {
  readonly root: HTMLElement;
  private readonly abort = new AbortController();
  private readonly stage: HTMLElement;
  private readonly world: HTMLElement;
  private readonly groupLayer: HTMLElement;
  private readonly nodeLayer: HTMLElement;
  private readonly edgeLayer: SVGSVGElement;
  private readonly inspector: HTMLElement;
  private readonly status: HTMLElement;
  private readonly connectButton: HTMLButtonElement;
  private readonly expandButton: HTMLButtonElement;
  private document: CanvasDocument;
  private selection: Selection = null;
  private connectSourceId: string | null = null;
  private connectAwaitingFirst = false;
  private activeGesture = false;
  private destroyed = false;
  private detachObserver: MutationObserver | null = null;
  private persistChain: Promise<void> = Promise.resolve();
  private viewportTimer: number | undefined;
  private expanded = false;

  constructor(document: CanvasDocument, private readonly options: SpatialCanvasOptions) {
    this.document = cloneCanvasDocument(document);
    this.root = documentElement('section', 'canvas-workspace');
    this.root.dataset.canvasId = document.id;
    this.root.dataset.readonly = String(!!options.readOnly);

    const toolbar = documentElement('div', 'canvas-toolbar');
    const addNote = button('Note', 'Add note card');
    const addText = button('Text', 'Add text card');
    const addMedia = button('Media', 'Add media card');
    const addGroup = button('Group', 'Add group');
    this.connectButton = button('Connect', 'Connect two nodes');
    const fit = button('Fit', 'Fit canvas content');
    const zoomOut = button('−', 'Zoom out');
    const zoomIn = button('+', 'Zoom in');
    const edit = button('Edit', 'Edit selected item');
    const remove = button('Delete', 'Delete selected item');
    this.expandButton = button('Expand', 'Expand canvas workspace');
    this.status = documentElement('span', 'canvas-status');
    this.status.setAttribute('role', 'status');
    const mutationButtons=[addNote,addText,addMedia,addGroup,this.connectButton,edit,remove];
    for(const control of mutationButtons) control.disabled=!!options.readOnly;
    toolbar.append(addNote, addText, addMedia, addGroup, this.connectButton, fit, zoomOut, zoomIn, edit, remove, this.expandButton, this.status);

    const body = documentElement('div', 'canvas-body');
    this.stage = documentElement('div', 'canvas-stage');
    this.stage.tabIndex = 0;
    this.stage.setAttribute('aria-label', options.readOnly
      ? 'Spatial canvas, read only. Drag empty space to pan; wheel to zoom.'
      : 'Spatial canvas. Drag empty space to pan; wheel to zoom; drag card headers to move.');
    this.world = documentElement('div', 'canvas-world');
    this.groupLayer = documentElement('div', 'canvas-group-layer');
    this.edgeLayer = globalThis.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.edgeLayer.classList.add('canvas-edge-layer');
    this.edgeLayer.setAttribute('aria-hidden', 'true');
    this.nodeLayer = documentElement('div', 'canvas-node-layer');
    this.world.append(this.groupLayer, this.edgeLayer, this.nodeLayer);
    this.stage.append(this.world);
    this.inspector = documentElement('aside', 'canvas-inspector');
    body.append(this.stage, this.inspector);
    this.root.append(toolbar, body);

    addNote.addEventListener('click', () => void this.addNote(), { signal: this.abort.signal });
    addText.addEventListener('click', () => void this.addText(), { signal: this.abort.signal });
    addMedia.addEventListener('click', () => void this.addMedia(), { signal: this.abort.signal });
    addGroup.addEventListener('click', () => void this.addGroup(), { signal: this.abort.signal });
    this.connectButton.addEventListener('click', () => this.toggleConnectMode(), { signal: this.abort.signal });
    fit.addEventListener('click', () => { this.fit(); void this.persistViewport(); }, { signal: this.abort.signal });
    zoomOut.addEventListener('click', () => this.zoomAtCenter(0.82), { signal: this.abort.signal });
    zoomIn.addEventListener('click', () => this.zoomAtCenter(1.22), { signal: this.abort.signal });
    edit.addEventListener('click', () => void this.editSelection(), { signal: this.abort.signal });
    remove.addEventListener('click', () => void this.deleteSelection(), { signal: this.abort.signal });
    this.expandButton.addEventListener('click', () => this.toggleExpanded(), { signal: this.abort.signal });

    this.stage.addEventListener('wheel', event => this.onWheel(event), { passive: false, signal: this.abort.signal });
    window.addEventListener('pointerdown', this.onGlobalPointerDown, { capture: true, signal: this.abort.signal });
    window.addEventListener('mousedown', this.onGlobalMouseDown, { capture: true, signal: this.abort.signal });
    this.stage.addEventListener('keydown', event => this.onKeyDown(event), { signal: this.abort.signal });

    this.render();
    queueMicrotask(() => {
      if (this.destroyed || !this.root.isConnected) return;
      this.detachObserver = new MutationObserver(() => {
        if (!this.root.isConnected) this.destroy();
      });
      this.detachObserver.observe(globalThis.document.documentElement, { childList: true, subtree: true });
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.abort.abort();
    this.detachObserver?.disconnect();
    this.detachObserver = null;
    if (this.viewportTimer !== undefined) window.clearTimeout(this.viewportTimer);
    this.root.classList.remove('expanded');
    document.body.classList.remove('vault-canvas-expanded');
  }

  private render(): void {
    this.applyViewport();
    this.renderGroups();
    this.renderNodes();
    this.renderEdges();
    this.renderInspector();
    this.updateStatus();
  }

  private applyViewport(): void {
    const viewport = this.document.viewport;
    this.root.dataset.zoom = String(viewport.zoom);
    this.world.style.transform = `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`;
  }

  private renderGroups(): void {
    this.groupLayer.replaceChildren();
    for (const group of this.document.groups) {
      const element = documentElement('section', 'canvas-group');
      element.dataset.canvasGroup = group.id;
      if (this.selection?.kind === 'group' && this.selection.id === group.id) element.classList.add('selected');
      setRect(element, group);

      const header = documentElement('button', 'canvas-group-title');
      header.type = 'button';
      header.textContent = group.title;
      header.addEventListener('click', event => {
        event.stopPropagation();
        this.selection = { kind: 'group', id: group.id };
        this.renderGroups();
        this.renderNodes();
        this.renderInspector();
      }, { signal: this.abort.signal });

      const resize = documentElement('span', 'canvas-resize-handle');
      resize.setAttribute('aria-hidden', 'true');
      element.append(header, resize);
      this.groupLayer.append(element);
    }
  }

  private renderNodes(): void {
    this.nodeLayer.replaceChildren();
    for (const node of this.document.nodes) {
      const element = documentElement('article', `canvas-node canvas-node-${node.type}`);
      element.dataset.canvasNode = node.id;
      if (this.selection?.kind === 'node' && this.selection.id === node.id) element.classList.add('selected');
      if (this.connectSourceId === node.id) element.classList.add('connect-source');
      setRect(element, node);

      const header = documentElement('div', 'canvas-node-header');
      const badge = documentElement('span', 'canvas-node-badge');
      badge.textContent = node.type === 'note' ? 'NOTE' : node.type === 'media' ? 'MEDIA' : 'TEXT';
      const dragHint = documentElement('span', 'canvas-node-drag');
      dragHint.textContent = '⋮⋮';
      header.append(badge, dragHint);

      const content = documentElement('div', 'canvas-node-content');
      if (node.type === 'note') this.renderNoteContent(content, node);
      else if (node.type === 'text') this.renderTextContent(content, node);
      else void this.renderMediaContent(content, node);

      const resize = documentElement('span', 'canvas-resize-handle');
      resize.setAttribute('aria-hidden', 'true');

      element.addEventListener('click', event => {
        event.stopPropagation();
        if (this.connectAwaitingFirst) {
          this.connectAwaitingFirst = false;
          this.connectSourceId = node.id;
          this.renderNodes();
          this.renderInspector();
          this.updateStatus();
          return;
        }
        if (this.connectSourceId !== null) {
          void this.handleConnectClick(node.id);
          return;
        }
        this.selection = { kind: 'node', id: node.id };
        this.renderGroups();
        this.renderNodes();
        this.renderInspector();
      }, { signal: this.abort.signal });

      element.append(header, content, resize);
      this.nodeLayer.append(element);
    }
  }

  private renderNoteContent(content: HTMLElement, node: Extract<CanvasNode, { type: 'note' }>): void {
    const resolution = this.options.resolveNote(node.target);
    const title = documentElement('strong', 'canvas-note-title');
    title.textContent = resolution.title ?? node.target;
    const path = documentElement('span', 'canvas-note-path');
    path.textContent = resolution.path ?? (resolution.status === 'ambiguous' ? 'Ambiguous note target' : 'Unresolved note target');
    content.append(title, path);
    if (resolution.status === 'resolved' && resolution.entryId) {
      const open = button('Open', 'Open note');
      open.classList.add('canvas-open-button');
      open.addEventListener('click', event => {
        event.stopPropagation();
        this.options.openEntry(resolution.entryId!);
      }, { signal: this.abort.signal });
      content.append(open);
    } else {
      content.classList.add('canvas-unresolved');
    }
  }

  private renderTextContent(content: HTMLElement, node: Extract<CanvasNode, { type: 'text' }>): void {
    const text = documentElement('div', 'canvas-text-content');
    text.textContent = node.text || 'Empty text card';
    content.append(text);
  }

  private async renderMediaContent(content: HTMLElement, node: Extract<CanvasNode, { type: 'media' }>): Promise<void> {
    const generationId = node.id;
    const loading = documentElement('span', 'canvas-media-loading');
    loading.textContent = node.target;
    content.append(loading);
    try {
      const media = await this.options.loadMedia(node.target);
      if (this.destroyed || !content.isConnected || content.closest<HTMLElement>('[data-canvas-node]')?.dataset.canvasNode !== generationId) return;
      content.replaceChildren();
      if (!media) {
        const missing = documentElement('span', 'canvas-media-missing');
        missing.textContent = `Unavailable: ${node.target}`;
        content.append(missing);
        return;
      }
      if (media.mimeType.startsWith('image/')) {
        const image = document.createElement('img');
        image.className = 'canvas-media-image';
        image.src = media.url;
        image.alt = node.alt ?? media.name;
        image.draggable = false;
        content.append(image);
      } else {
        const file = documentElement('div', 'canvas-media-file');
        const name = documentElement('strong');
        name.textContent = node.alt ?? media.name;
        const type = documentElement('span');
        type.textContent = media.mimeType;
        file.append(name, type);
        content.append(file);
      }
      const open = button('Open', 'Open attachment');
      open.classList.add('canvas-open-button');
      open.addEventListener('click', event => {
        event.stopPropagation();
        this.options.openEntry(media.entryId);
      }, { signal: this.abort.signal });
      content.append(open);
    } catch (error) {
      this.options.onError(error);
    }
  }

  private renderEdges(): void {
    this.edgeLayer.replaceChildren();
    const nodes = new Map(this.document.nodes.map(node => [node.id, node]));
    for (const edge of this.document.edges) {
      const source = nodes.get(edge.from);
      const target = nodes.get(edge.to);
      if (!source || !target) continue;
      const a = center(source);
      const b = center(target);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', String(a.x));
      line.setAttribute('y1', String(a.y));
      line.setAttribute('x2', String(b.x));
      line.setAttribute('y2', String(b.y));
      line.classList.add('canvas-edge-line');
      this.edgeLayer.append(line);
      if (edge.label) {
        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        label.setAttribute('x', String((a.x + b.x) / 2));
        label.setAttribute('y', String((a.y + b.y) / 2 - 5));
        label.classList.add('canvas-edge-label');
        label.textContent = edge.label;
        this.edgeLayer.append(label);
      }
    }
  }

  private renderInspector(): void {
    this.inspector.replaceChildren();
    const heading = documentElement('strong', 'canvas-inspector-heading');
    heading.textContent = 'Canvas';
    this.inspector.append(heading);

    if (!this.selection) {
      const help = documentElement('p', 'canvas-inspector-help');
      help.textContent = this.connectSourceId
        ? 'Choose the second card to create a connection.'
        : 'Select a card or group to inspect it. Use Connect, then choose two cards.';
      this.inspector.append(help);
    } else if (this.selection.kind === 'node') {
      const node = this.document.nodes.find(item => item.id === this.selection!.id);
      if (node) {
        const title = documentElement('p', 'canvas-inspector-selection');
        title.textContent = node.type === 'text' ? 'Text card' : node.type === 'note' ? node.target : node.target;
        this.inspector.append(title);
        this.renderConnectionList(node.id);
      }
    } else {
      const group = this.document.groups.find(item => item.id === this.selection!.id);
      if (group) {
        const title = documentElement('p', 'canvas-inspector-selection');
        title.textContent = group.title;
        this.inspector.append(title);
      }
    }

    const stats = documentElement('p', 'canvas-inspector-stats');
    stats.textContent = `${this.document.nodes.length} cards · ${this.document.edges.length} connections · ${this.document.groups.length} groups`;
    this.inspector.append(stats);
  }

  private renderConnectionList(nodeId: string): void {
    const edges = this.document.edges.filter(edge => edge.from === nodeId || edge.to === nodeId);
    if (!edges.length) return;
    const title = documentElement('div', 'canvas-connection-heading');
    title.textContent = 'Connections';
    this.inspector.append(title);
    for (const edge of edges) {
      const otherId = edge.from === nodeId ? edge.to : edge.from;
      const other = this.document.nodes.find(node => node.id === otherId);
      const row = documentElement('div', 'canvas-connection-row');
      const label = documentElement('span');
      label.textContent = `${edge.from === nodeId ? '→' : '←'} ${nodeTitle(other)}${edge.label ? ` · ${edge.label}` : ''}`;
      const edit = button('Edit', 'Edit connection label');
      edit.disabled=!!this.options.readOnly;
      edit.addEventListener('click', () => void this.editEdge(edge), { signal: this.abort.signal });
      const remove = button('×', 'Delete connection');
      remove.disabled=!!this.options.readOnly;
      remove.addEventListener('click', () => void this.deleteEdge(edge.id), { signal: this.abort.signal });
      row.append(label, edit, remove);
      this.inspector.append(row);
    }
  }

  private updateStatus(message?: string): void {
    this.status.textContent = message ?? (
      this.connectAwaitingFirst ? 'Connect: choose first card' :
      this.connectSourceId ? 'Connect: choose second card' :
      `${Math.round(this.document.viewport.zoom * 100)}%`
    );
    const connecting = this.connectAwaitingFirst || this.connectSourceId !== null;
    this.connectButton.classList.toggle('active', connecting);
    this.connectButton.setAttribute('aria-pressed', String(connecting));
  }

  private worldCenter(): Point {
    const rect = this.stage.getBoundingClientRect();
    return this.screenToWorld(rect.width / 2, rect.height / 2);
  }

  private screenToWorld(x: number, y: number): Point {
    const viewport = this.document.viewport;
    return { x: (x - viewport.x) / viewport.zoom, y: (y - viewport.y) / viewport.zoom };
  }

  private async addNote(): Promise<void> {
    const target = await this.options.requestValue('Add note card', 'Note path or title');
    if (target === null || !target.trim()) return;
    const point = this.worldCenter();
    const next = cloneCanvasDocument(this.document);
    next.nodes.push({
      id: canvasObjectId('node'), type: 'note', target: target.trim(),
      x: point.x - 130, y: point.y - 80, width: 260, height: 160,
    });
    await this.commit(next, 'Note card added');
  }

  private async addText(): Promise<void> {
    const text = await this.options.requestValue('Add text card', 'Text');
    if (text === null) return;
    const point = this.worldCenter();
    const next = cloneCanvasDocument(this.document);
    next.nodes.push({
      id: canvasObjectId('node'), type: 'text', text,
      x: point.x - 130, y: point.y - 80, width: 260, height: 160,
    });
    await this.commit(next, 'Text card added');
  }

  private async addMedia(): Promise<void> {
    const target = await this.options.requestValue('Add media card', 'Attachment path');
    if (target === null || !target.trim()) return;
    const point = this.worldCenter();
    const next = cloneCanvasDocument(this.document);
    next.nodes.push({
      id: canvasObjectId('node'), type: 'media', target: target.trim(), alt: null,
      x: point.x - 150, y: point.y - 100, width: 300, height: 200,
    });
    await this.commit(next, 'Media card added');
  }

  private async addGroup(): Promise<void> {
    const title = await this.options.requestValue('Add canvas group', 'Group title', 'Group');
    if (title === null || !title.trim()) return;
    const point = this.worldCenter();
    const next = cloneCanvasDocument(this.document);
    next.groups.push({
      id: canvasObjectId('group'), title: title.trim(),
      x: point.x - 220, y: point.y - 160, width: 440, height: 320,
    });
    await this.commit(next, 'Group added');
  }

  private toggleConnectMode(): void {
    if (this.connectAwaitingFirst || this.connectSourceId !== null) {
      this.connectAwaitingFirst = false;
      this.connectSourceId = null;
      this.renderNodes();
      this.renderInspector();
      this.updateStatus('Connect cancelled');
      return;
    }
    this.connectAwaitingFirst = true;
    this.connectSourceId = null;
    this.renderNodes();
    this.renderInspector();
    this.updateStatus();
  }

  private async handleConnectClick(nodeId: string): Promise<void> {
    const sourceId = this.connectSourceId;
    if (!sourceId) return;
    if (sourceId === nodeId) {
      this.updateStatus('Choose a different card');
      return;
    }
    if (this.document.edges.some(edge => edge.from === sourceId && edge.to === nodeId)) {
      this.connectSourceId = null;
      this.renderNodes();
      this.updateStatus('Connection already exists');
      return;
    }
    const next = cloneCanvasDocument(this.document);
    next.edges.push({ id: canvasObjectId('edge'), from: sourceId, to: nodeId, label: null });
    this.connectAwaitingFirst = false;
    this.connectSourceId = null;
    await this.commit(next, 'Connection added');
  }

  private async editSelection(): Promise<void> {
    if (!this.selection) return;
    if (this.selection.kind === 'group') {
      const group = this.document.groups.find(item => item.id === this.selection!.id);
      if (!group) return;
      const title = await this.options.requestValue('Edit group', 'Group title', group.title);
      if (title === null || !title.trim()) return;
      const next = cloneCanvasDocument(this.document);
      const target = next.groups.find(item => item.id === group.id);
      if (target) target.title = title.trim();
      await this.commit(next, 'Group updated');
      return;
    }
    const node = this.document.nodes.find(item => item.id === this.selection!.id);
    if (!node) return;
    const current = node.type === 'text' ? node.text : node.target;
    const label = node.type === 'text' ? 'Text' : node.type === 'note' ? 'Note path or title' : 'Attachment path';
    const value = await this.options.requestValue('Edit canvas card', label, current);
    if (value === null) return;
    const next = cloneCanvasDocument(this.document);
    const target = next.nodes.find(item => item.id === node.id);
    if (!target) return;
    if (target.type === 'text') target.text = value;
    else target.target = value.trim();
    await this.commit(next, 'Card updated');
  }

  private async deleteSelection(): Promise<void> {
    if (!this.selection) return;
    let next = cloneCanvasDocument(this.document);
    if (this.selection.kind === 'node') next = deleteCanvasNode(next, this.selection.id);
    else next.groups = next.groups.filter(group => group.id !== this.selection!.id);
    this.selection = null;
    await this.commit(next, 'Item deleted');
  }

  private async editEdge(edge: CanvasEdge): Promise<void> {
    const label = await this.options.requestValue('Edit connection', 'Label', edge.label ?? '');
    if (label === null) return;
    const next = cloneCanvasDocument(this.document);
    const target = next.edges.find(item => item.id === edge.id);
    if (target) target.label = label.trim() || null;
    await this.commit(next, 'Connection updated');
  }

  private async deleteEdge(edgeId: string): Promise<void> {
    const next = cloneCanvasDocument(this.document);
    next.edges = next.edges.filter(edge => edge.id !== edgeId);
    await this.commit(next, 'Connection deleted');
  }

  private updateMovedItem(
    item: CanvasNode | CanvasGroup,
    kind: 'node' | 'group',
    origin: Point,
    start: Point,
    clientX: number,
    clientY: number,
    altKey: boolean,
  ): void {
    const rect = this.stage.getBoundingClientRect();
    const point = this.screenToWorld(clientX - rect.left, clientY - rect.top);
    item.x = snap(origin.x + point.x - start.x, !altKey);
    item.y = snap(origin.y + point.y - start.y, !altKey);
    const element = kind === 'node'
      ? this.nodeLayer.querySelector<HTMLElement>(`[data-canvas-node="${item.id}"]`)
      : this.groupLayer.querySelector<HTMLElement>(`[data-canvas-group="${item.id}"]`);
    if (element) setRect(element, item);
    this.renderEdges();
  }

  private updateResizedItem(
    item: CanvasNode | CanvasGroup,
    kind: 'node' | 'group',
    start: { x: number; y: number; width: number; height: number },
    clientX: number,
    clientY: number,
  ): void {
    const scale = this.document.viewport.zoom;
    const minWidth = kind === 'group' ? 180 : 120;
    const minHeight = kind === 'group' ? 120 : 80;
    item.width = clamp(start.width + (clientX - start.x) / scale, minWidth, 4000);
    item.height = clamp(start.height + (clientY - start.y) / scale, minHeight, 4000);
    const element = kind === 'node'
      ? this.nodeLayer.querySelector<HTMLElement>(`[data-canvas-node="${item.id}"]`)
      : this.groupLayer.querySelector<HTMLElement>(`[data-canvas-group="${item.id}"]`);
    if (element) setRect(element, item);
    this.renderEdges();
  }

  private beginCapturedMove(event: PointerEvent, item: CanvasNode | CanvasGroup, kind: 'node' | 'group'): void {
    this.activeGesture = true;
    event.preventDefault();
    event.stopPropagation();
    const pointerId = event.pointerId;
    const rect = this.stage.getBoundingClientRect();
    const start = this.screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    const origin = { x: item.x, y: item.y };
    let finished = false;

    const apply = (clientX: number, clientY: number, altKey: boolean): void => {
      this.updateMovedItem(item, kind, origin, start, clientX, clientY, altKey);
    };
    const movePointer = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== pointerId || finished) return;
      moveEvent.preventDefault();
      apply(moveEvent.clientX, moveEvent.clientY, moveEvent.altKey);
    };
    const moveMouse = (moveEvent: MouseEvent): void => {
      if (finished || moveEvent.buttons !== 1) return;
      moveEvent.preventDefault();
      apply(moveEvent.clientX, moveEvent.clientY, moveEvent.altKey);
    };
    const cleanup = (): void => {
      window.removeEventListener('pointermove', movePointer, true);
      window.removeEventListener('pointerup', finishPointer, true);
      window.removeEventListener('pointercancel', finishPointer, true);
      window.removeEventListener('mousemove', moveMouse, true);
      window.removeEventListener('mouseup', finishMouse, true);
    };
    const finishNow = (): void => {
      if (finished) return;
      finished = true;
      this.activeGesture = false;
      cleanup();
      void this.commit(cloneCanvasDocument(this.document), 'Position saved', false);
    };
    const finishPointer = (upEvent: PointerEvent): void => {
      if (upEvent.pointerId !== pointerId) return;
      finishNow();
    };
    const finishMouse = (): void => finishNow();

    window.addEventListener('pointermove', movePointer, { capture: true, signal: this.abort.signal });
    window.addEventListener('pointerup', finishPointer, { capture: true, signal: this.abort.signal });
    window.addEventListener('pointercancel', finishPointer, { capture: true, signal: this.abort.signal });
    window.addEventListener('mousemove', moveMouse, { capture: true, signal: this.abort.signal });
    window.addEventListener('mouseup', finishMouse, { capture: true, signal: this.abort.signal });
  }

  private beginCapturedResize(event: PointerEvent, item: CanvasNode | CanvasGroup, kind: 'node' | 'group'): void {
    this.activeGesture = true;
    event.preventDefault();
    event.stopPropagation();
    const pointerId = event.pointerId;
    const start = { x: event.clientX, y: event.clientY, width: item.width, height: item.height };
    let finished = false;

    const apply = (clientX: number, clientY: number): void => {
      this.updateResizedItem(item, kind, start, clientX, clientY);
    };
    const movePointer = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== pointerId || finished) return;
      moveEvent.preventDefault();
      apply(moveEvent.clientX, moveEvent.clientY);
    };
    const moveMouse = (moveEvent: MouseEvent): void => {
      if (finished || moveEvent.buttons !== 1) return;
      moveEvent.preventDefault();
      apply(moveEvent.clientX, moveEvent.clientY);
    };
    const cleanup = (): void => {
      window.removeEventListener('pointermove', movePointer, true);
      window.removeEventListener('pointerup', finishPointer, true);
      window.removeEventListener('pointercancel', finishPointer, true);
      window.removeEventListener('mousemove', moveMouse, true);
      window.removeEventListener('mouseup', finishMouse, true);
    };
    const finishNow = (): void => {
      if (finished) return;
      finished = true;
      this.activeGesture = false;
      cleanup();
      void this.commit(cloneCanvasDocument(this.document), 'Size saved', false);
    };
    const finishPointer = (upEvent: PointerEvent): void => {
      if (upEvent.pointerId !== pointerId) return;
      finishNow();
    };
    const finishMouse = (): void => finishNow();

    window.addEventListener('pointermove', movePointer, { capture: true, signal: this.abort.signal });
    window.addEventListener('pointerup', finishPointer, { capture: true, signal: this.abort.signal });
    window.addEventListener('pointercancel', finishPointer, { capture: true, signal: this.abort.signal });
    window.addEventListener('mousemove', moveMouse, { capture: true, signal: this.abort.signal });
    window.addEventListener('mouseup', finishMouse, { capture: true, signal: this.abort.signal });
  }

  private beginCapturedPan(event: PointerEvent): void {
    this.activeGesture = true;
    event.preventDefault();
    event.stopPropagation();
    const pointerId = event.pointerId;
    const start = { x: event.clientX, y: event.clientY, panX: this.document.viewport.x, panY: this.document.viewport.y };
    let finished = false;

    const apply = (clientX: number, clientY: number): void => {
      this.document.viewport.x = start.panX + clientX - start.x;
      this.document.viewport.y = start.panY + clientY - start.y;
      this.applyViewport();
    };
    const movePointer = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== pointerId || finished) return;
      moveEvent.preventDefault();
      apply(moveEvent.clientX, moveEvent.clientY);
    };
    const moveMouse = (moveEvent: MouseEvent): void => {
      if (finished || moveEvent.buttons !== 1) return;
      moveEvent.preventDefault();
      apply(moveEvent.clientX, moveEvent.clientY);
    };
    const cleanup = (): void => {
      window.removeEventListener('pointermove', movePointer, true);
      window.removeEventListener('pointerup', finishPointer, true);
      window.removeEventListener('pointercancel', finishPointer, true);
      window.removeEventListener('mousemove', moveMouse, true);
      window.removeEventListener('mouseup', finishMouse, true);
    };
    const finishNow = (): void => {
      if (finished) return;
      finished = true;
      this.activeGesture = false;
      cleanup();
      void this.persistViewport();
    };
    const finishPointer = (upEvent: PointerEvent): void => {
      if (upEvent.pointerId !== pointerId) return;
      finishNow();
    };
    const finishMouse = (): void => finishNow();

    window.addEventListener('pointermove', movePointer, { capture: true, signal: this.abort.signal });
    window.addEventListener('pointerup', finishPointer, { capture: true, signal: this.abort.signal });
    window.addEventListener('pointercancel', finishPointer, { capture: true, signal: this.abort.signal });
    window.addEventListener('mousemove', moveMouse, { capture: true, signal: this.abort.signal });
    window.addEventListener('mouseup', finishMouse, { capture: true, signal: this.abort.signal });
  }

  private beginMouseMove(event: MouseEvent, item: CanvasNode | CanvasGroup, kind: 'node' | 'group'): void {
    this.activeGesture = true;
    event.preventDefault();
    event.stopPropagation();
    const rect = this.stage.getBoundingClientRect();
    const start = this.screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    const origin = { x: item.x, y: item.y };
    let finished = false;

    const move = (moveEvent: MouseEvent): void => {
      if (finished || moveEvent.buttons !== 1) return;
      moveEvent.preventDefault();
      this.updateMovedItem(item, kind, origin, start, moveEvent.clientX, moveEvent.clientY, moveEvent.altKey);
    };
    const finish = (): void => {
      if (finished) return;
      finished = true;
      this.activeGesture = false;
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('mouseup', finish, true);
      void this.commit(cloneCanvasDocument(this.document), 'Position saved', false);
    };
    window.addEventListener('mousemove', move, { capture: true, signal: this.abort.signal });
    window.addEventListener('mouseup', finish, { capture: true, signal: this.abort.signal });
  }

  private beginMouseResize(event: MouseEvent, item: CanvasNode | CanvasGroup, kind: 'node' | 'group'): void {
    this.activeGesture = true;
    event.preventDefault();
    event.stopPropagation();
    const start = { x: event.clientX, y: event.clientY, width: item.width, height: item.height };
    let finished = false;

    const move = (moveEvent: MouseEvent): void => {
      if (finished || moveEvent.buttons !== 1) return;
      moveEvent.preventDefault();
      this.updateResizedItem(item, kind, start, moveEvent.clientX, moveEvent.clientY);
    };
    const finish = (): void => {
      if (finished) return;
      finished = true;
      this.activeGesture = false;
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('mouseup', finish, true);
      void this.commit(cloneCanvasDocument(this.document), 'Size saved', false);
    };
    window.addEventListener('mousemove', move, { capture: true, signal: this.abort.signal });
    window.addEventListener('mouseup', finish, { capture: true, signal: this.abort.signal });
  }

  private beginMousePan(event: MouseEvent): void {
    this.activeGesture = true;
    event.preventDefault();
    event.stopPropagation();
    const start = { x: event.clientX, y: event.clientY, panX: this.document.viewport.x, panY: this.document.viewport.y };
    let finished = false;

    const move = (moveEvent: MouseEvent): void => {
      if (finished || moveEvent.buttons !== 1) return;
      moveEvent.preventDefault();
      this.document.viewport.x = start.panX + moveEvent.clientX - start.x;
      this.document.viewport.y = start.panY + moveEvent.clientY - start.y;
      this.applyViewport();
    };
    const finish = (): void => {
      if (finished) return;
      finished = true;
      this.activeGesture = false;
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('mouseup', finish, true);
      void this.persistViewport();
    };
    window.addEventListener('mousemove', move, { capture: true, signal: this.abort.signal });
    window.addEventListener('mouseup', finish, { capture: true, signal: this.abort.signal });
  }

  private readonly onGlobalMouseDown = (event: MouseEvent): void => {
    if (this.destroyed || this.activeGesture || event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element) || !this.root.contains(target)) return;
    if (this.options.readOnly && target.closest('.canvas-node,.canvas-group,.canvas-inspector,.canvas-toolbar')) return;

    const resizeHandle = target.closest<HTMLElement>('.canvas-resize-handle');
    if (resizeHandle) {
      const nodeElement = resizeHandle.closest<HTMLElement>('[data-canvas-node]');
      if (nodeElement?.dataset.canvasNode) {
        const node = this.document.nodes.find(item => item.id === nodeElement.dataset.canvasNode);
        if (node) this.beginMouseResize(event, node, 'node');
        return;
      }
      const groupElement = resizeHandle.closest<HTMLElement>('[data-canvas-group]');
      if (groupElement?.dataset.canvasGroup) {
        const group = this.document.groups.find(item => item.id === groupElement.dataset.canvasGroup);
        if (group) this.beginMouseResize(event, group, 'group');
        return;
      }
    }

    const nodeHeader = target.closest<HTMLElement>('.canvas-node-header');
    const nodeElement = nodeHeader?.closest<HTMLElement>('[data-canvas-node]');
    if (nodeHeader && nodeElement?.dataset.canvasNode) {
      const node = this.document.nodes.find(item => item.id === nodeElement.dataset.canvasNode);
      if (node) {
        this.selection = { kind: 'node', id: node.id };
        this.renderInspector();
        this.beginMouseMove(event, node, 'node');
      }
      return;
    }

    const groupHeader = target.closest<HTMLElement>('.canvas-group-title');
    const groupElement = groupHeader?.closest<HTMLElement>('[data-canvas-group]');
    if (groupHeader && groupElement?.dataset.canvasGroup) {
      const group = this.document.groups.find(item => item.id === groupElement.dataset.canvasGroup);
      if (group) {
        this.selection = { kind: 'group', id: group.id };
        this.renderInspector();
        this.beginMouseMove(event, group, 'group');
      }
      return;
    }

    if (this.stage.contains(target) && !target.closest('.canvas-node,.canvas-group,.canvas-inspector,.canvas-toolbar')) {
      this.beginMousePan(event);
    }
  };

  private readonly onGlobalPointerDown = (event: PointerEvent): void => {
    if (this.destroyed || this.activeGesture || event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element) || !this.root.contains(target)) return;
    if (this.options.readOnly && target.closest('.canvas-node,.canvas-group,.canvas-inspector,.canvas-toolbar')) return;

    const resizeHandle = target.closest<HTMLElement>('.canvas-resize-handle');
    if (resizeHandle) {
      const nodeElement = resizeHandle.closest<HTMLElement>('[data-canvas-node]');
      if (nodeElement?.dataset.canvasNode) {
        const node = this.document.nodes.find(item => item.id === nodeElement.dataset.canvasNode);
        if (node) this.beginCapturedResize(event, node, 'node');
        return;
      }
      const groupElement = resizeHandle.closest<HTMLElement>('[data-canvas-group]');
      if (groupElement?.dataset.canvasGroup) {
        const group = this.document.groups.find(item => item.id === groupElement.dataset.canvasGroup);
        if (group) this.beginCapturedResize(event, group, 'group');
        return;
      }
    }

    const nodeHeader = target.closest<HTMLElement>('.canvas-node-header');
    const nodeElement = nodeHeader?.closest<HTMLElement>('[data-canvas-node]');
    if (nodeHeader && nodeElement?.dataset.canvasNode) {
      const node = this.document.nodes.find(item => item.id === nodeElement.dataset.canvasNode);
      if (node) {
        this.selection = { kind: 'node', id: node.id };
        this.renderInspector();
        this.beginCapturedMove(event, node, 'node');
      }
      return;
    }

    const groupHeader = target.closest<HTMLElement>('.canvas-group-title');
    const groupElement = groupHeader?.closest<HTMLElement>('[data-canvas-group]');
    if (groupHeader && groupElement?.dataset.canvasGroup) {
      const group = this.document.groups.find(item => item.id === groupElement.dataset.canvasGroup);
      if (group) {
        this.selection = { kind: 'group', id: group.id };
        this.renderInspector();
        this.beginCapturedMove(event, group, 'group');
      }
      return;
    }

    if (this.stage.contains(target) && !target.closest('.canvas-node,.canvas-group,.canvas-inspector,.canvas-toolbar')) {
      this.beginCapturedPan(event);
    }
  };

  private onWheel(event: WheelEvent): void {
    event.preventDefault();
    const rect = this.stage.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const world = this.screenToWorld(x, y);
    const nextZoom = clamp(this.document.viewport.zoom * (event.deltaY < 0 ? 1.12 : 0.89), MIN_ZOOM, MAX_ZOOM);
    this.document.viewport.zoom = nextZoom;
    this.document.viewport.x = x - world.x * nextZoom;
    this.document.viewport.y = y - world.y * nextZoom;
    this.applyViewport();
    this.updateStatus();
    if (this.viewportTimer !== undefined) window.clearTimeout(this.viewportTimer);
    this.viewportTimer = window.setTimeout(() => void this.persistViewport(), 250);
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Home') {
      event.preventDefault();
      this.fit();
      void this.persistViewport();
      return;
    }
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      this.zoomAtCenter(1.15);
      return;
    }
    if (event.key === '-') {
      event.preventDefault();
      this.zoomAtCenter(0.87);
      return;
    }
    const amount = event.shiftKey ? 80 : 32;
    if (event.key === 'ArrowLeft') this.document.viewport.x += amount;
    else if (event.key === 'ArrowRight') this.document.viewport.x -= amount;
    else if (event.key === 'ArrowUp') this.document.viewport.y += amount;
    else if (event.key === 'ArrowDown') this.document.viewport.y -= amount;
    else return;
    event.preventDefault();
    this.applyViewport();
    void this.persistViewport();
  }

  private zoomAtCenter(factor: number): void {
    const rect = this.stage.getBoundingClientRect();
    const x = rect.width / 2;
    const y = rect.height / 2;
    const world = this.screenToWorld(x, y);
    const nextZoom = clamp(this.document.viewport.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    this.document.viewport.zoom = nextZoom;
    this.document.viewport.x = x - world.x * nextZoom;
    this.document.viewport.y = y - world.y * nextZoom;
    this.applyViewport();
    this.updateStatus();
    void this.persistViewport();
  }

  private fit(): void {
    const bounds = canvasBounds(this.document);
    const rect = this.stage.getBoundingClientRect();
    if (!bounds || rect.width < 10 || rect.height < 10) {
      this.document.viewport = { x: rect.width / 2, y: rect.height / 2, zoom: 1 };
      this.applyViewport();
      this.updateStatus();
      return;
    }
    const margin = 70;
    const zoom = clamp(Math.min((rect.width - margin * 2) / Math.max(1, bounds.width), (rect.height - margin * 2) / Math.max(1, bounds.height)), MIN_ZOOM, MAX_ZOOM);
    this.document.viewport.zoom = zoom;
    this.document.viewport.x = rect.width / 2 - (bounds.x + bounds.width / 2) * zoom;
    this.document.viewport.y = rect.height / 2 - (bounds.y + bounds.height / 2) * zoom;
    this.applyViewport();
    this.updateStatus();
  }

  private async persistViewport(): Promise<void> {
    if(this.options.readOnly) return;
    await this.commit(cloneCanvasDocument(this.document), 'Viewport saved', false);
  }

  private async commit(next: CanvasDocument, message: string, rerender = true): Promise<void> {
    if (this.destroyed) return;
    if(this.options.readOnly){ this.updateStatus('Read only'); return; }
    this.document = next;
    if (rerender) this.render();
    else {
      this.renderEdges();
      this.renderInspector();
    }
    this.updateStatus('Saving…');

    // Invoke persistence immediately so the owning workspace can enqueue
    // this exact gesture before a subsequent mode switch/navigation action.
    // Delaying invocation behind the previous local promise can reorder a
    // completed drag after "Source" mode and then lose it when this view detaches.
    const pending = this.options.persist(cloneCanvasDocument(next));
    this.persistChain = pending.catch(error => this.options.onError(error));
    await this.persistChain;
    if (!this.destroyed) this.updateStatus(message);
  }

  private toggleExpanded(): void {
    this.expanded = !this.expanded;
    this.root.classList.toggle('expanded', this.expanded);
    document.body.classList.toggle('vault-canvas-expanded', this.expanded);
    this.expandButton.textContent = this.expanded ? 'Collapse' : 'Expand';
    this.expandButton.setAttribute('aria-label', this.expanded ? 'Collapse canvas workspace' : 'Expand canvas workspace');
  }
}

function documentElement<K extends keyof HTMLElementTagNameMap>(tag: K, className = ''): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

function button(label: string, ariaLabel: string): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.setAttribute('aria-label', ariaLabel);
  return element;
}

function setRect(element: HTMLElement, rect: { x: number; y: number; width: number; height: number }): void {
  element.style.left = `${rect.x}px`;
  element.style.top = `${rect.y}px`;
  element.style.width = `${rect.width}px`;
  element.style.height = `${rect.height}px`;
}

function center(node: CanvasNode): Point {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

function nodeTitle(node: CanvasNode | undefined): string {
  if (!node) return 'Missing card';
  if (node.type === 'text') return node.text.trim().slice(0, 30) || 'Text card';
  return node.target;
}
