import type { client_message, document_tab } from '../src/types';
import type { document_source } from '../src/document_state';
import { is_markdown_link } from '../src/markdown_state';
import { reading_toolbar } from './reading_toolbar';
import { preview_overlay } from './preview_controls';
import { source_formatter } from './document_render';
import { hydrate_html_resources } from './html_resources';
import { document_highlights, document_search_text } from './document_highlights';
import { document_search, type document_match } from './document_search';
import './document_view.css';

/** Scriptless web pages and source documents share search and workspace reading state. */
export class document_view {
  readonly pane = document.createElement('div');
  readonly search: document_search;
  section?: HTMLElement;
  section_button?: HTMLButtonElement;
  section_label?: HTMLSpanElement;
  private readonly viewport = document.createElement('div');
  private readonly notice = document.createElement('div');
  private readonly formatter = new source_formatter();
  private readonly toolbar: reading_toolbar;
  private readonly overlay: preview_overlay;
  private content?: HTMLElement;
  private frame?: HTMLIFrameElement;
  private pending_frame?: { frame: HTMLIFrameElement; cancel(): void };
  private resource_load?: AbortController;
  private events?: AbortController;
  private highlights?: document_highlights;
  private source?: document_source;
  private rendered_source?: document_source;
  private rendering_source?: document_source;
  private requested = false;
  private disposed = false;
  private revision = 0;
  private scroll: number;
  private sent_scroll: number;
  private scroll_timer?: ReturnType<typeof setTimeout>;

  constructor(readonly tab: document_tab, private readonly send: (message: client_message) => void,
    private readonly find: () => void) {
    this.scroll = this.sent_scroll = tab.scroll;
    this.search = new document_search({ page_count: () => 1,
      read_page: async () => this.content ? document_search_text(this.content) : '',
      select_match: (match, matches, reveal) => this.highlights?.select(match, matches, reveal && !this.pane.hidden),
    });
    this.pane.id = `terminal-${tab.id}`;
    this.pane.className = 'terminal-pane document-pane';
    this.pane.setAttribute('role', 'tabpanel');
    this.pane.setAttribute('aria-label', tab.name);
    this.toolbar = new reading_toolbar(tab.format, {
      move: direction => (this.frame?.contentWindow ?? this.viewport).scrollBy({
        top: direction * (this.frame?.clientHeight ?? Math.max(1, this.viewport.clientHeight - this.overlay.space)),
      }),
      height: () => this.frame?.clientHeight ?? this.viewport.clientHeight,
      zoom: (value, previous) => {
        if (this.frame) {
          const root = this.frame.contentDocument?.documentElement;
          const win = this.frame.contentWindow;
          if (root && win) {
            const top = win.scrollY * value / previous;
            root.style.zoom = String(value);
            win.scrollTo({ top });
          }
        } else if (this.content) {
          this.content.parentElement!.style.zoom = String(value);
          this.viewport.scrollTop *= value / previous;
        }
      },
    }, [
      { label: 'Open source file', icon: 'go-to-file', run: () => this.send({ type: 'open_document_link', id: tab.id, href: tab.uri }) },
      { label: 'Reload preview', icon: 'refresh', run: () => this.refresh() },
    ]);
    this.notice.className = 'document-notice'; this.notice.setAttribute('role', 'status');
    this.notice.textContent = 'Loading preview…';
    this.viewport.className = 'document-viewport';
    this.viewport.tabIndex = 0;
    this.viewport.setAttribute('aria-label', `${tab.format.toUpperCase()} document`);
    this.viewport.addEventListener('scroll', () => this.scrolled(this.viewport.scrollTop));
    this.viewport.addEventListener('keydown', event => this.keydown(event));
    this.viewport.addEventListener('wheel', event => this.toolbar.wheel(event), { passive: false });
    const body = document.createElement('div');
    body.className = 'reading-body';
    body.append(this.toolbar.outline, this.viewport);
    this.overlay = new preview_overlay(this.pane, this.viewport, [this.toolbar.root, this.notice],
      () => this.frame?.contentWindow ?? this.viewport);
    this.pane.append(this.overlay.root, body);
  }

  set_visible(visible: boolean): void {
    if (!visible) {
      this.remember();
      ++this.revision;
      this.pending_frame?.cancel();
      this.resource_load?.abort();
      this.rendering_source = undefined;
    }
    this.pane.hidden = !visible;
    if (!visible) return;
    if (!this.requested) { this.requested = true; this.refresh(); }
    if (this.source !== this.rendered_source && this.source !== this.rendering_source) void this.render();
  }
  focus(): void { if (this.frame) this.frame.contentWindow?.focus(); else this.viewport.focus(); }
  refresh(): void { if (!this.disposed) this.send({ type: 'load_document', id: this.tab.id }); }
  error(message: string): void { if (!this.disposed) { this.notice.textContent = message; this.notice.hidden = false; } }
  async load(source: document_source): Promise<void> {
    if (this.disposed) return;
    this.source = source;
    await this.render();
  }

  private async render(): Promise<void> {
    if (this.disposed || this.pane.hidden || !this.source) return;
    const revision = ++this.revision;
    this.pending_frame?.cancel();
    this.resource_load?.abort();
    const source = this.source;
    this.rendering_source = source;
    if (this.tab.format === 'html') {
      const controller = new AbortController();
      this.resource_load = controller;
      try {
        const result = await hydrate_html_resources(source, { signal: controller.signal });
        if (controller.signal.aborted || this.disposed || this.pane.hidden || revision !== this.revision) return;
        await this.render_html(source, revision, result.html, result.warnings);
      }
      catch { if (revision === this.revision) this.error('HTML could not be rendered. Reload to retry.'); }
      finally {
        if (this.resource_load === controller) this.resource_load = undefined;
        if (revision === this.revision) this.rendering_source = undefined;
      }
      return;
    }
    const result = await this.formatter.format(source.text, this.tab.format);
    if (revision === this.revision) this.rendering_source = undefined;
    if (result.cancelled || this.disposed || this.pane.hidden || revision !== this.revision) return;
    const pre = document.createElement('pre');
    pre.className = 'document-source';
    const code = document.createElement('code');
    code.textContent = result.text; pre.append(code);
    this.viewport.replaceChildren(pre);
    this.ready(code, source);
    this.notice.hidden = !result.error;
    this.notice.textContent = result.error ?? '';
    this.viewport.scrollTop = this.scroll;
  }

  private render_html(source: document_source, revision: number, html: string, warnings: string[]): Promise<void> {
    const frame = document.createElement('iframe');
    frame.className = 'document-html'; frame.title = this.tab.name;
    frame.setAttribute('sandbox', 'allow-same-origin');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.hidden = true;
    frame.srcdoc = html;
    return new Promise(resolve => {
      let finished = false;
      const finish = (loaded: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (this.pending_frame?.frame === frame) this.pending_frame = undefined;
        if (!loaded) frame.remove();
        resolve();
      };
      const timer = setTimeout(() => {
        if (revision === this.revision) this.error('HTML preview did not finish loading. Reload to retry.');
        finish(false);
      }, 8000);
      this.pending_frame = { frame, cancel: () => finish(false) };
      frame.addEventListener('load', () => {
        if (finished || this.disposed || this.pane.hidden || revision !== this.revision) { finish(false); return; }
        const doc = frame.contentDocument;
        const win = frame.contentWindow;
        if (!doc?.body || !win || doc.URL !== 'about:srcdoc') return;
        this.events?.abort();
        this.events = new AbortController();
        const options = { signal: this.events.signal };
        this.frame = frame;
        frame.hidden = false;
        // Moving an attached iframe reloads its document and invalidates its listeners.
        for (const child of Array.from(this.viewport.childNodes)) if (child !== frame) child.remove();
        this.ready(doc.body, source);
        this.notice.hidden = !warnings.length;
        this.notice.textContent = warnings.join(' ');
        win.scrollTo(0, this.scroll);
        win.addEventListener('scroll', () => this.scrolled(win.scrollY), options);
        doc.addEventListener('keydown', event => this.keydown(event), options);
        doc.addEventListener('wheel', event => this.toolbar.wheel(event), { ...options, passive: false });
        doc.addEventListener('focusin', () => this.pane.dispatchEvent(new FocusEvent('focusin', { bubbles: true })), options);
        const open_link = (event: MouseEvent) => {
          const target = event.target as Element | null;
          const anchor = target?.closest?.('a, area');
          if (!anchor) return;
          event.preventDefault();
          const href = anchor.getAttribute('href');
          if (!is_markdown_link(href)) return;
          if (href.startsWith('#')) {
            let fragment = href.slice(1);
            try { fragment = decodeURIComponent(fragment); } catch { /* Keep the literal fragment. */ }
            const target = fragment ? doc.getElementById(fragment) ?? doc.getElementsByName(fragment)[0] : undefined;
            if (target) target.scrollIntoView({ block: 'start' });
            else if (!fragment || fragment.toLowerCase() === 'top') win.scrollTo({ top: 0 });
          } else this.send({ type: 'open_document_link', id: this.tab.id, href });
        };
        doc.addEventListener('click', open_link, options);
        doc.addEventListener('auxclick', event => {
          if ((event.target as Element | null)?.closest?.('a, area')) event.preventDefault();
        }, options);
        finish(true);
      });
      this.viewport.append(frame);
    });
  }

  private ready(root: HTMLElement, source: document_source): void {
    this.highlights?.clear();
    this.content = root;
    this.toolbar.set_content(root);
    this.rendered_source = source;
    this.highlights = new document_highlights(root, range => {
      const rectangle = range.getBoundingClientRect();
      const origin = this.frame ? { top: 0, left: 0 } : this.viewport.getBoundingClientRect();
      const width = this.frame?.clientWidth ?? this.viewport.clientWidth;
      const height = this.frame?.clientHeight ?? this.viewport.clientHeight;
      const left = rectangle.left < origin.left || rectangle.right > origin.left + width
        ? rectangle.left - origin.left - Math.min(24, width / 4) : 0;
      const top = rectangle.top - origin.top - height / 2;
      if (this.frame) this.frame.contentWindow?.scrollBy({ left, top });
      else this.viewport.scrollBy({ left, top });
    });
    this.search.reset();
  }

  reveal_match(match: document_match): boolean {
    return !this.pane.hidden && !!this.highlights?.select(match, [match], true);
  }
  private keydown(event: KeyboardEvent): void {
    if (this.toolbar.keydown(event)) return;
    if (event.isComposing || event.altKey) return;
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'f') {
      event.preventDefault(); event.stopPropagation(); this.find(); return;
    }
    if (event.metaKey || event.ctrlKey) return;
    const target = this.frame?.contentWindow ?? this.viewport;
    if (event.key === 'j') target.scrollBy({ top: 48 });
    else if (event.key === 'k') target.scrollBy({ top: -48 });
    else if (event.key === 'g') target.scrollTo({ top: 0 });
    else if (event.key === 'G') target.scrollTo({ top: this.frame?.contentDocument?.documentElement.scrollHeight ?? this.viewport.scrollHeight });
    else return;
    event.preventDefault(); event.stopPropagation();
  }
  private scrolled(scroll: number): void {
    if (this.disposed || this.pane.hidden) return;
    this.scroll = Math.max(0, Math.min(100_000_000, scroll));
    clearTimeout(this.scroll_timer);
    this.scroll_timer = setTimeout(() => this.remember(), 180);
  }
  private remember(): void {
    clearTimeout(this.scroll_timer);
    if (!this.disposed && this.sent_scroll !== this.scroll) {
      this.sent_scroll = this.scroll;
      this.send({ type: 'document_position', id: this.tab.id, position: { scroll: this.scroll } });
    }
  }
  dispose(): void {
    this.remember(); this.disposed = true; ++this.revision;
    this.pending_frame?.cancel(); this.events?.abort(); this.formatter.dispose();
    this.resource_load?.abort();
    this.toolbar.dispose(); this.overlay.dispose();
    this.highlights?.clear(); this.search.dispose(); this.pane.remove();
    this.source = undefined; this.rendered_source = undefined; this.rendering_source = undefined;
    this.content = undefined; this.frame = undefined;
  }
}
