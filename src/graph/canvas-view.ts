import type { EntryId } from '../domain/model.js';
import { graphGroupKey, type GraphEdge, type GraphGroupMode, type GraphNode, type KnowledgeGraph } from './model.js';

interface LayoutNode {
  node: GraphNode;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  group: string;
}

export interface GraphCanvasOptions {
  onOpen(entryId: EntryId): void;
  onHover?(node: GraphNode | null): void;
  reducedMotion?: boolean;
}

export interface GraphCanvasRenderOptions {
  groupMode: GraphGroupMode;
  groupProperty?: string;
  highlightedIds?: ReadonlySet<EntryId>;
  centerId?: EntryId | null;
}

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function nodeRadius(node: GraphNode): number {
  return 4 + Math.min(7, Math.log2(node.degree + 1) * 1.7);
}

const palette = ['#2f6d5f', '#557a88', '#75658a', '#8a6f4d', '#49725a', '#7a5c5c', '#55705f', '#6a7182'];

function groupColor(group: string): string {
  return palette[hash(group) % palette.length]!;
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export class GraphCanvasView {
  private readonly context: CanvasRenderingContext2D;
  private readonly resizeObserver: ResizeObserver;
  private graph: KnowledgeGraph = { nodes: [], edges: [], unresolvedReferences: 0, ambiguousReferences: 0 };
  private layout = new Map<EntryId, LayoutNode>();
  private groups = new Map<string, { x: number; y: number; color: string }>();
  private groupMode: GraphGroupMode = 'none';
  private groupProperty = '';
  private highlightedIds: ReadonlySet<EntryId> = new Set();
  private centerId: EntryId | null = null;
  private animationFrame = 0;
  private simulationStep = 0;
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private pointerId: number | null = null;
  private pointerStart = { x: 0, y: 0 };
  private pointerLast = { x: 0, y: 0 };
  private pointerMoved = false;
  private hoverId: EntryId | null = null;
  private readonly reducedMotion: boolean;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly options: GraphCanvasOptions) {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D is unavailable.');
    this.context = context;
    this.reducedMotion = options.reducedMotion ?? window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.canvas.style.touchAction = 'none';
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Interactive knowledge graph. Use the node list beside the graph for keyboard navigation.');

    this.resizeObserver = new ResizeObserver(() => {
      this.resize();
      this.draw();
    });
    this.resizeObserver.observe(canvas);

    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('keydown', this.onKeyDown);
    this.resize();
  }

  destroy(): void {
    cancelAnimationFrame(this.animationFrame);
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('keydown', this.onKeyDown);
  }

  setGraph(graph: KnowledgeGraph, options: GraphCanvasRenderOptions): void {
    this.graph = graph;
    this.groupMode = options.groupMode;
    this.groupProperty = options.groupProperty ?? '';
    this.highlightedIds = options.highlightedIds ?? new Set<EntryId>();
    this.centerId = options.centerId ?? null;
    this.createLayout();
    this.fit();
    this.startSimulation();
  }

  zoomBy(factor: number): void {
    const width = this.cssWidth();
    const height = this.cssHeight();
    this.zoomAt(width / 2, height / 2, factor);
  }

  fit(): void {
    if (!this.layout.size) {
      this.scale = 1;
      this.offsetX = this.cssWidth() / 2;
      this.offsetY = this.cssHeight() / 2;
      this.draw();
      return;
    }
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
    for (const item of this.layout.values()) {
      minX = Math.min(minX, item.x - item.radius);
      maxX = Math.max(maxX, item.x + item.radius);
      minY = Math.min(minY, item.y - item.radius);
      maxY = Math.max(maxY, item.y + item.radius);
    }
    const graphWidth = Math.max(1, maxX - minX);
    const graphHeight = Math.max(1, maxY - minY);
    const width = this.cssWidth();
    const height = this.cssHeight();
    const margin = Math.min(70, Math.max(24, Math.min(width, height) * 0.08));
    this.scale = Math.max(0.08, Math.min(2.5, Math.min((width - margin * 2) / graphWidth, (height - margin * 2) / graphHeight)));
    this.offsetX = width / 2 - ((minX + maxX) / 2) * this.scale;
    this.offsetY = height / 2 - ((minY + maxY) / 2) * this.scale;
    this.draw();
  }

  private cssWidth(): number {
    return Math.max(1, this.canvas.clientWidth || 1);
  }

  private cssHeight(): number {
    return Math.max(1, this.canvas.clientHeight || 1);
  }

  private resize(): void {
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.floor(this.cssWidth() * ratio));
    const height = Math.max(1, Math.floor(this.cssHeight() * ratio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  private createLayout(): void {
    cancelAnimationFrame(this.animationFrame);
    this.simulationStep = 0;
    const previous = this.layout;
    this.layout = new Map();
    this.groups = new Map();

    const grouped = new Map<string, GraphNode[]>();
    for (const node of this.graph.nodes) {
      const group = graphGroupKey(node, this.groupMode, this.groupProperty);
      const values = grouped.get(group) ?? [];
      values.push(node);
      grouped.set(group, values);
    }

    const groupKeys = [...grouped.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    const groupCount = groupKeys.length;
    const clusterRadius = groupCount <= 1 ? 0 : Math.max(240, 130 * Math.sqrt(groupCount));

    groupKeys.forEach((group, groupIndex) => {
      const angle = groupCount <= 1 ? 0 : (groupIndex / groupCount) * Math.PI * 2 - Math.PI / 2;
      const center = {
        x: Math.cos(angle) * clusterRadius,
        y: Math.sin(angle) * clusterRadius,
        color: groupColor(group),
      };
      this.groups.set(group, center);
      const members = grouped.get(group)!.slice().sort((a, b) => b.degree - a.degree || a.path.localeCompare(b.path));
      members.forEach((node, memberIndex) => {
        const preserved = previous.get(node.id);
        if (preserved && preserved.group === group) {
          this.layout.set(node.id, { ...preserved, node, radius: nodeRadius(node) });
          return;
        }
        const seed = hash(node.id);
        const golden = 2.399963229728653;
        const localAngle = memberIndex * golden + (seed % 360) * Math.PI / 180;
        const localRadius = memberIndex === 0 ? 0 : 24 * Math.sqrt(memberIndex) + (seed % 17);
        this.layout.set(node.id, {
          node,
          x: center.x + Math.cos(localAngle) * localRadius,
          y: center.y + Math.sin(localAngle) * localRadius,
          vx: 0,
          vy: 0,
          radius: nodeRadius(node),
          group,
        });
      });
    });
  }

  private startSimulation(): void {
    cancelAnimationFrame(this.animationFrame);
    if (this.reducedMotion || this.graph.nodes.length > 1500 || this.graph.edges.length > 12000) {
      this.draw();
      return;
    }
    const step = (): void => {
      this.relax();
      this.draw();
      this.simulationStep++;
      if (this.simulationStep < 90) this.animationFrame = requestAnimationFrame(step);
    };
    this.animationFrame = requestAnimationFrame(step);
  }

  private relax(): void {
    for (const item of this.layout.values()) {
      item.vx *= 0.82;
      item.vy *= 0.82;
      const center = this.groups.get(item.group);
      if (center) {
        item.vx += (center.x - item.x) * 0.0018;
        item.vy += (center.y - item.y) * 0.0018;
      }
    }

    for (const edge of this.graph.edges) {
      const source = this.layout.get(edge.source);
      const target = this.layout.get(edge.target);
      if (!source || !target || source === target) continue;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const current = Math.max(0.01, Math.hypot(dx, dy));
      const desired = 72 + source.radius + target.radius;
      const strength = Math.min(0.012, 0.004 + Math.log2(edge.weight + 1) * 0.002);
      const force = (current - desired) * strength;
      const fx = dx / current * force;
      const fy = dy / current * force;
      source.vx += fx;
      source.vy += fy;
      target.vx -= fx;
      target.vy -= fy;
    }

    const cellSize = 32;
    const cells = new Map<string, LayoutNode[]>();
    for (const item of this.layout.values()) {
      const cx = Math.floor(item.x / cellSize);
      const cy = Math.floor(item.y / cellSize);
      const key = `${cx},${cy}`;
      const bucket = cells.get(key) ?? [];
      bucket.push(item);
      cells.set(key, bucket);
    }

    for (const item of this.layout.values()) {
      const cx = Math.floor(item.x / cellSize);
      const cy = Math.floor(item.y / cellSize);
      for (let x = cx - 1; x <= cx + 1; x++) {
        for (let y = cy - 1; y <= cy + 1; y++) {
          for (const other of cells.get(`${x},${y}`) ?? []) {
            if (item.node.id >= other.node.id) continue;
            const dx = other.x - item.x;
            const dy = other.y - item.y;
            const current = Math.max(0.1, Math.hypot(dx, dy));
            const minimum = item.radius + other.radius + 7;
            if (current >= minimum) continue;
            const push = (minimum - current) * 0.025;
            const px = dx / current * push;
            const py = dy / current * push;
            item.vx -= px; item.vy -= py;
            other.vx += px; other.vy += py;
          }
        }
      }
    }

    for (const item of this.layout.values()) {
      item.x += Math.max(-8, Math.min(8, item.vx));
      item.y += Math.max(-8, Math.min(8, item.vy));
    }
  }

  private draw(): void {
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const ctx = this.context;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const width = this.cssWidth();
    const height = this.cssHeight();
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#fbfcfa';
    ctx.fillRect(0, 0, width, height);

    if (!this.layout.size) {
      ctx.fillStyle = '#667671';
      ctx.font = '13px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No graph nodes match the current filters.', width / 2, height / 2);
      return;
    }

    ctx.save();
    ctx.translate(this.offsetX, this.offsetY);
    ctx.scale(this.scale, this.scale);

    if (this.groupMode !== 'none' && this.groups.size <= 30) {
      ctx.font = `${11 / this.scale}px Inter, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const [group, center] of this.groups) {
        ctx.fillStyle = '#6d7d77';
        ctx.fillText(group, center.x, center.y - 28 / this.scale);
      }
    }

    ctx.lineCap = 'round';
    for (const edge of this.graph.edges) {
      const source = this.layout.get(edge.source);
      const target = this.layout.get(edge.target);
      if (!source || !target) continue;
      const emphasized = this.highlightedIds.has(edge.source) || this.highlightedIds.has(edge.target) || this.centerId === edge.source || this.centerId === edge.target;
      ctx.globalAlpha = emphasized ? 0.7 : Math.max(0.08, Math.min(0.28, 0.11 + Math.log2(edge.weight + 1) * 0.035));
      ctx.strokeStyle = edge.kind.startsWith('attachment') ? '#7c8c91' : '#879b92';
      ctx.lineWidth = (emphasized ? 1.7 : 0.8 + Math.min(1.8, Math.log2(edge.weight + 1) * 0.35)) / this.scale;
      ctx.beginPath();
      ctx.moveTo(source.x, source.y);
      ctx.lineTo(target.x, target.y);
      ctx.stroke();

      if ((emphasized || (this.graph.nodes.length <= 500 && this.scale >= 0.55)) && source !== target) {
        const angle = Math.atan2(target.y - source.y, target.x - source.x);
        const distanceFromTarget = target.radius + 2 / this.scale;
        const tx = target.x - Math.cos(angle) * distanceFromTarget;
        const ty = target.y - Math.sin(angle) * distanceFromTarget;
        const arrow = 4 / this.scale;
        ctx.fillStyle = ctx.strokeStyle;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(tx - Math.cos(angle - Math.PI / 6) * arrow, ty - Math.sin(angle - Math.PI / 6) * arrow);
        ctx.lineTo(tx - Math.cos(angle + Math.PI / 6) * arrow, ty - Math.sin(angle + Math.PI / 6) * arrow);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    const showAllLabels = this.graph.nodes.length <= 250 && this.scale >= 0.55;
    for (const item of this.layout.values()) {
      const highlighted = this.highlightedIds.has(item.node.id);
      const centered = this.centerId === item.node.id;
      const hovered = this.hoverId === item.node.id;
      const color = groupColor(item.group);
      ctx.fillStyle = item.node.kind === 'attachment' ? '#f5f7f6' : color;
      ctx.strokeStyle = centered ? '#173c33' : highlighted || hovered ? '#1d5145' : item.node.kind === 'attachment' ? color : '#ffffff';
      ctx.lineWidth = (centered ? 3 : highlighted || hovered ? 2.4 : 1.4) / this.scale;

      if (item.node.kind === 'attachment') {
        const r = item.radius;
        ctx.beginPath();
        ctx.moveTo(item.x, item.y - r);
        ctx.lineTo(item.x + r, item.y);
        ctx.lineTo(item.x, item.y + r);
        ctx.lineTo(item.x - r, item.y);
        ctx.closePath();
      } else {
        ctx.beginPath();
        ctx.arc(item.x, item.y, item.radius, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.stroke();

      if (item.node.orphan) {
        ctx.strokeStyle = '#a7812d';
        ctx.lineWidth = 1 / this.scale;
        ctx.setLineDash([3 / this.scale, 3 / this.scale]);
        ctx.beginPath();
        ctx.arc(item.x, item.y, item.radius + 3 / this.scale, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      if (showAllLabels || highlighted || centered || hovered) {
        ctx.fillStyle = '#273537';
        ctx.font = `${Math.max(9, 11 / Math.max(0.6, this.scale))}px Inter, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(item.node.label, item.x, item.y + item.radius + 5 / this.scale);
      }
    }

    ctx.restore();
  }

  private screenToWorld(x: number, y: number): { x: number; y: number } {
    return { x: (x - this.offsetX) / this.scale, y: (y - this.offsetY) / this.scale };
  }

  private hitNode(screenX: number, screenY: number): LayoutNode | null {
    const world = this.screenToWorld(screenX, screenY);
    let best: LayoutNode | null = null;
    let bestDistance = Infinity;
    const padding = 10 / this.scale;
    for (const item of this.layout.values()) {
      const current = distance(world, item);
      if (current <= item.radius + padding && current < bestDistance) {
        best = item;
        bestDistance = current;
      }
    }
    return best;
  }

  private zoomAt(screenX: number, screenY: number, factor: number): void {
    const before = this.screenToWorld(screenX, screenY);
    this.scale = Math.max(0.06, Math.min(5, this.scale * factor));
    this.offsetX = screenX - before.x * this.scale;
    this.offsetY = screenY - before.y * this.scale;
    this.draw();
  }

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    this.zoomAt(event.clientX - rect.left, event.clientY - rect.top, event.deltaY < 0 ? 1.12 : 0.89);
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.pointerId !== null) return;
    this.pointerId = event.pointerId;
    this.pointerMoved = false;
    const rect = this.canvas.getBoundingClientRect();
    this.pointerStart = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    this.pointerLast = { ...this.pointerStart };
    this.canvas.setPointerCapture(event.pointerId);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };

    if (this.pointerId === event.pointerId) {
      const dx = point.x - this.pointerLast.x;
      const dy = point.y - this.pointerLast.y;
      if (Math.hypot(point.x - this.pointerStart.x, point.y - this.pointerStart.y) > 5) this.pointerMoved = true;
      if (this.pointerMoved) {
        this.offsetX += dx;
        this.offsetY += dy;
        this.draw();
      }
      this.pointerLast = point;
      return;
    }

    if (event.pointerType === 'mouse' && event.buttons === 0) {
      const hit = this.hitNode(point.x, point.y);
      const next = hit?.node.id ?? null;
      if (next !== this.hoverId) {
        this.hoverId = next;
        this.canvas.style.cursor = hit ? 'pointer' : 'grab';
        this.options.onHover?.(hit?.node ?? null);
        this.draw();
      }
    }
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.pointerId !== event.pointerId) return;
    const rect = this.canvas.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    if (!this.pointerMoved) {
      const hit = this.hitNode(point.x, point.y);
      if (hit) this.options.onOpen(hit.node.id);
    }
    this.pointerId = null;
    this.canvas.releasePointerCapture(event.pointerId);
    this.canvas.style.cursor = this.hoverId ? 'pointer' : 'grab';
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const amount = event.shiftKey ? 80 : 32;
    if (event.key === 'ArrowLeft') this.offsetX += amount;
    else if (event.key === 'ArrowRight') this.offsetX -= amount;
    else if (event.key === 'ArrowUp') this.offsetY += amount;
    else if (event.key === 'ArrowDown') this.offsetY -= amount;
    else if (event.key === '+' || event.key === '=') this.zoomBy(1.15);
    else if (event.key === '-') this.zoomBy(0.87);
    else if (event.key === 'Home') this.fit();
    else return;
    event.preventDefault();
    this.draw();
  };
}
