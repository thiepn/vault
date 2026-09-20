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
export interface RenderMarkdownOptions {
  wiki?: WikiRenderBridge;
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
      if (!reference.embed) {
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
          const nested = await compileWikiAware(loaded.markdown, { wiki, stack: [...stack, loaded.entryId], depth: depth + 1, sourceEntryId: loaded.entryId });
          const embedLabel = reference.alias ?? reference.note || reference.heading || (reference.block ? 'Embedded block' : reference.targetText);
          replacement = `<section class="vault-embed vault-embed-resolved"><a href="#" class="vault-embed-label" title="${escapeHtml(reference.targetText)}" data-vault-target="${escapeHtml(reference.targetText)}" data-vault-source="${escapeHtml(options.sourceEntryId ?? '')}">${escapeHtml(embedLabel)}</a><div class="vault-embed-content">${nested}</div></section>`;
        }
      }
      prepared = prepared.slice(0, reference.from) + replacement + prepared.slice(reference.to);
    }
  }
  const compiled = markdown.parse(prepared);
  return typeof compiled === 'string' ? compiled : await compiled;
}

const calloutTypes = new Set([
  'note', 'info', 'tip', 'warning', 'danger', 'example',
  'quote', 'question', 'success', 'failure', 'bug',
]);

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
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

  enhanceLinks(container);
  enhanceCallouts(container);
  enhanceCode(container);
  await enhanceMermaid(container);
  return container;
}
