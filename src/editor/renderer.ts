import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import { Marked } from 'marked';
import markedKatex from 'marked-katex-extension';
import { parseWikiReferences } from '../knowledge/parser.js';

const markdown = new Marked({
  gfm: true,
  breaks: false,
  async: false,
});

markdown.use(markedKatex({
  throwOnError: false,
  trust: false,
  strict: 'warn',
}));

export interface WikiRenderBridge {
  status(target: string, sourceEntryId?: string): 'resolved' | 'ambiguous' | 'unresolved';
  load(target: string, sourceEntryId?: string): Promise<{ entryId: string; markdown: string } | null>;
}
export interface QueryRenderBridge {
  render(source: string, sourceEntryId?: string): Promise<HTMLElement>;
}
export interface AttachmentRenderBridge {
  status(target: string, sourceEntryId?: string): 'resolved' | 'ambiguous' | 'unresolved';
  load(target: string, sourceEntryId?: string): Promise<{ entryId: string; name: string; mimeType: string; size: number; url: string } | null>;
}
export interface RenderMarkdownOptions {
  wiki?: WikiRenderBridge;
  query?: QueryRenderBridge;
  attachment?: AttachmentRenderBridge;
  stack?: readonly string[];
  depth?: number;
  sourceEntryId?: string;
}
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}
async function compileWikiAware(source: string, options: RenderMarkdownOptions): Promise<string> {
  const wiki = options.wiki;
  let prepared = source;
  if (wiki) {
    const stack = [...(options.stack ?? [])];
    const depth = options.depth ?? 0;
    for (const reference of parseWikiReferences(source).sort((a, b) => b.from - a.from)) {
      let replacement: string;
      const attachmentStatus = !reference.heading && !reference.block
        ? options.attachment?.status(reference.note, options.sourceEntryId)
        : undefined;
      if (attachmentStatus === 'resolved' || attachmentStatus === 'ambiguous') {
        replacement = `<span class="vault-attachment-placeholder vault-attachment-${attachmentStatus}" data-vault-attachment-target="${escapeHtml(reference.note)}" data-vault-attachment-source="${escapeHtml(options.sourceEntryId ?? '')}" data-vault-attachment-embed="${reference.embed ? 'true' : 'false'}" data-vault-attachment-label="${escapeHtml(reference.alias ?? reference.note)}"></span>`;
      } else if (!reference.embed) {
        const status = wiki.status(reference.targetText, options.sourceEntryId);
        replacement = `<a href="#" class="vault-wiki-link vault-wiki-${status}" data-vault-target="${escapeHtml(reference.targetText)}" data-vault-source="${escapeHtml(options.sourceEntryId ?? '')}">${escapeHtml(reference.alias ?? reference.targetText)}</a>`;
      } else if (depth >= 6) {
        replacement = `<aside class="vault-embed vault-embed-cycle">Embed depth limit reached: ${escapeHtml(reference.targetText)}</aside>`;
      } else {
        const loaded = await wiki.load(reference.targetText, options.sourceEntryId);
        if (!loaded) {
          replacement = `<aside class="vault-embed vault-embed-unresolved" data-vault-target="${escapeHtml(reference.targetText)}" data-vault-source="${escapeHtml(options.sourceEntryId ?? '')}">Unresolved embed: ${escapeHtml(reference.targetText)}</aside>`;
        } else if (stack.includes(loaded.entryId)) {
          replacement = `<aside class="vault-embed vault-embed-cycle">Embed cycle: ${escapeHtml(reference.targetText)}</aside>`;
        } else {
          const nested = await compileWikiAware(loaded.markdown, {
            wiki,
            ...(options.query ? { query: options.query } : {}),
            ...(options.attachment ? { attachment: options.attachment } : {}),
            stack: [...stack, loaded.entryId],
            depth: depth + 1,
            sourceEntryId: loaded.entryId,
          });
          const embedLabel = reference.alias ?? (reference.note || reference.heading || (reference.block ? 'Embedded block' : reference.targetText));
          replacement = `<section class="vault-embed vault-embed-resolved"><a href="#" class="vault-embed-label" title="${escapeHtml(reference.targetText)}" data-vault-target="${escapeHtml(reference.targetText)}" data-vault-source="${escapeHtml(options.sourceEntryId ?? '')}">${escapeHtml(embedLabel)}</a><div class="vault-embed-content">${nested}</div></section>`;
        }
      }
      prepared = prepared.slice(0, reference.from) + replacement + prepared.slice(reference.to);
    }
  }
  const compiled = markdown.parse(prepared);
  const html = typeof compiled === 'string' ? compiled : await compiled;
  if (!options.sourceEntryId) return html;
  const querySourceEntry = escapeHtml(options.sourceEntryId);
  return html.replaceAll(
    '<code class="language-vault-query">',
    `<code class="language-vault-query" data-vault-query-source="${querySourceEntry}">`,
  );
}

const calloutTypes = new Set([
  'note', 'info', 'tip', 'warning', 'danger', 'example',
  'quote', 'question', 'success', 'failure', 'bug',
]);

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

async function enhanceAttachments(root: HTMLElement, bridge: AttachmentRenderBridge | undefined): Promise<void> {
  if (!bridge) return;
  const placeholders = [...root.querySelectorAll<HTMLElement>('.vault-attachment-placeholder')];
  for (const placeholder of placeholders) {
    const target = placeholder.dataset.vaultAttachmentTarget ?? '';
    const sourceEntryId = placeholder.dataset.vaultAttachmentSource || undefined;
    const embed = placeholder.dataset.vaultAttachmentEmbed === 'true';
    const label = placeholder.dataset.vaultAttachmentLabel || target;
    if (placeholder.classList.contains('vault-attachment-ambiguous')) {
      const warning = document.createElement('aside');
      warning.className = 'render-warning vault-attachment-warning';
      warning.textContent = `Ambiguous attachment: ${target}`;
      placeholder.replaceWith(warning);
      continue;
    }
    const loaded = await bridge.load(target, sourceEntryId);
    if (!loaded) {
      const warning = document.createElement('aside');
      warning.className = 'render-warning vault-attachment-warning';
      warning.textContent = `Attachment unavailable: ${target}`;
      placeholder.replaceWith(warning);
      continue;
    }

    if (!embed) {
      const link = document.createElement('a');
      link.className = 'vault-attachment-link';
      link.href = loaded.url;
      link.download = loaded.name;
      link.textContent = label;
      link.title = loaded.name;
      placeholder.replaceWith(link);
      continue;
    }

    const mime = loaded.mimeType.toLocaleLowerCase();
    if (mime.startsWith('image/')) {
      const figure = document.createElement('figure');
      figure.className = 'vault-media vault-media-image';
      const image = document.createElement('img');
      image.src = loaded.url;
      image.alt = label === target ? loaded.name : label;
      image.loading = 'lazy';
      image.decoding = 'async';
      figure.append(image);
      if (label && label !== target) {
        const caption = document.createElement('figcaption');
        caption.textContent = label;
        figure.append(caption);
      }
      placeholder.replaceWith(figure);
      continue;
    }

    if (mime.startsWith('audio/')) {
      const audio = document.createElement('audio');
      audio.className = 'vault-media vault-media-audio';
      audio.controls = true;
      audio.preload = 'metadata';
      audio.src = loaded.url;
      placeholder.replaceWith(audio);
      continue;
    }

    if (mime.startsWith('video/')) {
      const video = document.createElement('video');
      video.className = 'vault-media vault-media-video';
      video.controls = true;
      video.preload = 'metadata';
      video.src = loaded.url;
      placeholder.replaceWith(video);
      continue;
    }

    const card = document.createElement('a');
    card.className = 'vault-media vault-media-file';
    card.href = loaded.url;
    card.download = loaded.name;
    const name = document.createElement('strong');
    name.textContent = label || loaded.name;
    const detail = document.createElement('span');
    detail.textContent = loaded.mimeType;
    card.append(name, detail);
    placeholder.replaceWith(card);
  }
}

function enhanceLinks(root: HTMLElement): void {
  for (const anchor of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const href = anchor.getAttribute('href') ?? '';
    if (/^https?:\/\//i.test(href)) {
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
    }
  }
  for (const image of root.querySelectorAll<HTMLImageElement>('img')) {
    image.loading = 'lazy';
    image.decoding = 'async';
  }
}

function enhanceCallouts(root: HTMLElement): void {
  for (const quote of [...root.querySelectorAll('blockquote')]) {
    const first = quote.firstElementChild;
    if (!(first instanceof HTMLElement)) continue;
    const text = first.textContent ?? '';
    const marker = /^\[!([A-Za-z]+)\]([+-])?(?:\s+)?/.exec(text);
    if (!marker) continue;
    const type = marker[1]!.toLowerCase();
    if (!calloutTypes.has(type)) continue;

    const remaining = text.slice(marker[0].length).trim();
    if (remaining) first.textContent = remaining;
    else first.remove();

    const collapsible = marker[2] === '+' || marker[2] === '-';
    if (collapsible) {
      const details = document.createElement('details');
      details.className = `callout callout-${type}`;
      details.open = marker[2] === '+';
      const summary = document.createElement('summary');
      summary.className = 'callout-title';
      summary.textContent = titleCase(type);
      const body = document.createElement('div');
      body.className = 'callout-body';
      while (quote.firstChild) body.append(quote.firstChild);
      details.append(summary, body);
      quote.replaceWith(details);
    } else {
      const wrapper = document.createElement('aside');
      wrapper.className = `callout callout-${type}`;
      const title = document.createElement('div');
      title.className = 'callout-title';
      title.textContent = titleCase(type);
      const body = document.createElement('div');
      body.className = 'callout-body';
      while (quote.firstChild) body.append(quote.firstChild);
      wrapper.append(title, body);
      quote.replaceWith(wrapper);
    }
  }
}

async function enhanceQueries(root: HTMLElement, bridge: QueryRenderBridge | undefined, sourceEntryId?: string): Promise<void> {
  if (!bridge) return;
  const blocks = [...root.querySelectorAll<HTMLElement>('pre > code.language-vault-query')];
  for (const code of blocks) {
    const pre = code.parentElement;
    if (!pre) continue;
    try {
      const rendered = await bridge.render(code.textContent ?? '', code.dataset.vaultQuerySource ?? sourceEntryId);
      pre.replaceWith(rendered);
    } catch (error) {
      const warning = document.createElement('aside');
      warning.className = 'render-warning query-render-warning';
      warning.textContent = `Vault query could not run: ${error instanceof Error ? error.message : 'invalid query'}`;
      pre.replaceWith(warning);
    }
  }
}

function enhanceCode(root: HTMLElement): void {
  for (const code of root.querySelectorAll<HTMLElement>('pre > code')) {
    if (code.classList.contains('language-mermaid')) continue;
    try {
      hljs.highlightElement(code);
    } catch {
      code.classList.add('hljs');
    }
    const pre = code.parentElement;
    if (!pre) continue;
    const frame = document.createElement('div');
    frame.className = 'code-frame';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy-code';
    button.textContent = 'Copy';
    button.setAttribute('aria-label', 'Copy code');
    button.addEventListener('click', () => {
      void navigator.clipboard?.writeText(code.textContent ?? '').then(() => {
        button.textContent = 'Copied';
        window.setTimeout(() => { button.textContent = 'Copy'; }, 1200);
      }).catch(() => undefined);
    });
    pre.replaceWith(frame);
    frame.append(button, pre);
  }
}

async function enhanceMermaid(root: HTMLElement): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>('pre > code.language-mermaid')];
  if (!blocks.length) return;

  const { default: mermaid } = await import('./mermaid-runtime.js');
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'neutral',
    suppressErrorRendering: true,
  });

  let index = 0;
  for (const code of blocks) {
    const pre = code.parentElement;
    if (!pre) continue;
    const source = code.textContent ?? '';
    const diagram = document.createElement('div');
    diagram.className = 'mermaid-diagram';
    try {
      const id = `vault-mermaid-${crypto.randomUUID()}-${index++}`;
      const rendered = await mermaid.render(id, source);
      diagram.innerHTML = String(DOMPurify.sanitize(rendered.svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
      }));
      pre.replaceWith(diagram);
    } catch (error) {
      const message = document.createElement('div');
      message.className = 'render-warning';
      message.textContent = `Mermaid could not render this diagram: ${error instanceof Error ? error.message : 'invalid diagram'}`;
      pre.after(message);
    }
  }
}

/**
 * Compile Markdown into a detached, sanitized reading surface.
 * The caller swaps this into the document only after async enhancements finish.
 */
export async function renderMarkdown(markdownSource: string, options: RenderMarkdownOptions = {}): Promise<HTMLElement> {
  const container = document.createElement('div');
  container.className = 'reading-document';

  const html = await compileWikiAware(markdownSource, options);
  container.innerHTML = String(DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form'],
    ADD_ATTR: ['target'],
  }));

  await enhanceAttachments(container, options.attachment);
  enhanceLinks(container);
  enhanceCallouts(container);
  await enhanceQueries(container, options.query, options.sourceEntryId);
  enhanceCode(container);
  await enhanceMermaid(container);
  return container;
}
