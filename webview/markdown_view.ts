import { document_highlights, document_search_text } from './document_highlights';
import { reading_toolbar } from './reading_toolbar';
import { preview_font_picker } from './preview_font_picker';
import { preview_overlay } from './preview_controls';
import type { client_message, markdown_tab } from '../src/types';
import { is_markdown_link, type markdown_source } from '../src/markdown_state';
import { render_markdown, heading_id_prefix, heading_slug } from './markdown_render';
import { document_search, type document_match } from './document_search';
import './markdown_view.css';
import './markdown_math.css';

/** A read-only document pane; saving from Vim or another editor refreshes it. */
export class markdown_view {
  readonly pane = document.createElement('div');
  readonly search: document_search;
  section?: HTMLElement;
  section_button?: HTMLButtonElement;
  section_label?: HTMLSpanElement;
  private readonly viewport = document.createElement('div');
  private readonly content = document.createElement('article');
  private readonly notice = document.createElement('div');
  private requested = false;
  private disposed = false;
  private source?: markdown_source;
  private rendered_source?: markdown_source;
  private scroll: number;
  private sent_scroll: number;
  private scroll_timer?: ReturnType<typeof setTimeout>;
  private restore_frame?: number;
  private readonly highlights: document_highlights;
  private readonly toolbar: reading_toolbar;
  private readonly overlay: preview_overlay;
  private readonly font_picker: preview_font_picker;

  constructor(readonly tab: markdown_tab, private readonly send: (message: client_message) => void) {
    this.scroll = tab.scroll;
    this.sent_scroll = tab.scroll;
    this.highlights = new document_highlights(this.content, range => {
      const rectangle = range.getBoundingClientRect();
      const viewport = this.viewport.getBoundingClientRect();
      this.viewport.scrollTop += rectangle.top - viewport.top - this.viewport.clientHeight / 2;
    });
    this.search = new document_search({
      page_count: () => 1,
      read_page: async () => document_search_text(this.content),
      select_match: (match, matches, reveal) => this.select_match(match, matches, reveal),
    });
    this.pane.id = `terminal-${tab.id}`;
    this.pane.className = 'terminal-pane markdown-pane';
    this.pane.setAttribute('role', 'tabpanel');
    this.pane.setAttribute('aria-label', tab.name);
    this.font_picker = new preview_font_picker(font => this.send({ type: 'set_preview_font', id: tab.id, font }));
    this.toolbar = new reading_toolbar('markdown', {
      move: direction => this.viewport.scrollBy({ top: direction * Math.max(1, this.viewport.clientHeight - this.overlay.space) }),
      height: () => this.viewport.clientHeight,
      zoom: (value, previous) => {
        this.content.style.zoom = String(value);
        this.viewport.scrollTop *= value / previous;
      },
    }, [
      { label: 'Change preview font', icon: 'text-size', run: anchor => this.font_picker.toggle(anchor) },
      { label: 'Open source file', icon: 'go-to-file', run: () => this.send({ type: 'open_markdown_link', id: tab.id, href: tab.uri }) },
      { label: 'Reload Markdown', icon: 'refresh', run: () => this.refresh() },
    ]);
    this.notice.className = 'markdown-notice';
    this.notice.setAttribute('role', 'status');
    this.notice.textContent = 'Loading Markdown...';
    this.viewport.className = 'markdown-viewport';
    this.viewport.tabIndex = 0;
    this.viewport.setAttribute('aria-label', 'Markdown document. Use j and k to scroll, g for the beginning, G for the end.');
    this.content.className = 'markdown-content';
    this.viewport.append(this.content);
    this.viewport.addEventListener('keydown', event => this.keydown(event));
    this.viewport.addEventListener('wheel', event => this.toolbar.wheel(event), { passive: false });
    this.viewport.addEventListener('scroll', () => {
      if (this.restore_frame !== undefined) return;
      clearTimeout(this.scroll_timer);
      this.scroll = this.viewport.scrollTop;
      this.scroll_timer = setTimeout(() => this.remember(), 180);
    });
    this.content.addEventListener('click', event => this.open_link(event));
    const body = document.createElement('div');
    body.className = 'reading-body';
    body.append(this.toolbar.outline, this.viewport);
    this.overlay = new preview_overlay(this.pane, this.viewport, [this.toolbar.root, this.notice], () => this.viewport);
    this.pane.append(this.overlay.root, body);
  }

  set_visible(visible: boolean): void {
    if (!visible) this.font_picker.close();
    if (!visible) this.remember();
    this.pane.hidden = !visible;
    if (!visible) return;
    if (!this.requested) { this.requested = true; this.refresh(); }
    if (this.source !== this.rendered_source) this.render();
  }

  focus(): void { this.viewport.focus(); }
  set_font(font: string): void { this.font_picker.set_font(font); }
  refresh(): void { this.send({ type: 'load_markdown', id: this.tab.id }); }

  error(message: string): void {
    this.notice.hidden = false;
    this.notice.textContent = message;
  }

  load(source: markdown_source): void {
    if (this.disposed) return;
    this.source = source;
    this.render();
  }

  render(): void {
    if (this.disposed || this.pane.hidden || !this.source) return;
    try {
      this.content.innerHTML = render_markdown(this.source);
      this.rendered_source = this.source;
      this.toolbar.set_content(this.content);
      this.search.reset();
      this.notice.hidden = true;
      if (this.restore_frame !== undefined) cancelAnimationFrame(this.restore_frame);
      this.restore_frame = requestAnimationFrame(() => {
        this.viewport.scrollTop = this.scroll;
        this.restore_frame = undefined;
      });
    } catch {
      this.error('Markdown could not be rendered. Edit the file and save to retry.');
    }
  }

  /** Web and mail links reach VS Code's webview link handling, which opens them once and without a trust
   * prompt in trusted workspaces. Fragments and relative files stop here so the host does not act on them too. */
  private open_link(event: MouseEvent): void {
    const anchor = event.target instanceof Element ? event.target.closest('a') : undefined;
    if (!anchor || !this.content.contains(anchor)) return;
    const href = anchor.getAttribute('href');
    if (href && /^(?:https?|mailto):/i.test(href) && is_markdown_link(href)) return;
    event.preventDefault();
    event.stopPropagation();
    if (!is_markdown_link(href)) return;
    if (href.startsWith('#')) this.reveal_fragment(href.slice(1));
    else this.send({ type: 'open_markdown_link', id: this.tab.id, href });
  }

  /** Accepts the anchors people write: exact ids, heading text, GitHub slugs and different letter case. */
  private reveal_fragment(fragment: string): void {
    let decoded = fragment;
    try { decoded = decodeURIComponent(fragment); } catch { /* Keep the literal fragment. */ }
    if (!decoded || decoded.toLowerCase() === 'top') { this.viewport.scrollTop = 0; return; }
    const candidates = [decoded, heading_id_prefix + decoded, heading_id_prefix + heading_slug(decoded)];
    const elements = [...this.content.querySelectorAll<HTMLElement>('[id]')];
    const target = candidates.map(id => elements.find(element => element.id === id)).find(Boolean)
      ?? elements.find(element => candidates.some(id => element.id.toLowerCase() === id.toLowerCase()));
    target?.scrollIntoView({ block: 'start' });
  }

  reveal_match(match: document_match): boolean {
    if (!this.rendered_source || this.pane.hidden) return false;
    this.select_match(match, [match], true);
    return true;
  }

  private select_match(match?: document_match, matches: readonly document_match[] = [], reveal = true): void {
    if (reveal && !this.pane.hidden && this.restore_frame !== undefined) {
      cancelAnimationFrame(this.restore_frame);
      this.restore_frame = undefined;
    }
    this.highlights.select(this.disposed ? undefined : match, matches, reveal && !this.pane.hidden);
  }

  private keydown(event: KeyboardEvent): void {
    if (this.toolbar.keydown(event)) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const distance = event.key === 'j' ? 48 : event.key === 'k' ? -48 : 0;
    if (distance) this.viewport.scrollBy({ top: distance });
    else if (event.key === 'g') this.viewport.scrollTop = 0;
    else if (event.key === 'G') this.viewport.scrollTop = this.viewport.scrollHeight;
    else return;
    event.preventDefault();
    event.stopPropagation();
  }

  private remember(): void {
    clearTimeout(this.scroll_timer);
    if (!this.disposed && this.scroll !== this.sent_scroll) {
      this.sent_scroll = this.scroll;
      this.send({ type: 'markdown_position', id: this.tab.id, position: { scroll: this.scroll } });
    }
  }

  dispose(): void {
    this.remember();
    this.disposed = true;
    this.search.dispose();
    this.toolbar.dispose();
    this.overlay.dispose();
    this.font_picker.dispose();
    this.select_match(undefined);
    clearTimeout(this.scroll_timer);
    if (this.restore_frame !== undefined) cancelAnimationFrame(this.restore_frame);
    this.pane.remove();
    this.source = undefined;
    this.rendered_source = undefined;
  }
}
