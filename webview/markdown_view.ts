import type { client_message, markdown_tab } from '../src/types';
import { is_markdown_link, type markdown_source } from '../src/markdown_state';
import { render_markdown } from './markdown_render';
import { document_search, search_source_range, type document_match } from './document_search';
import './markdown_view.css';

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
  private highlight?: Highlight;
  private other_highlights?: Highlight;
  private cached_matches?: readonly document_match[];
  private match_ranges: Range[] = [];

  constructor(readonly tab: markdown_tab, private readonly send: (message: client_message) => void) {
    this.scroll = tab.scroll;
    this.sent_scroll = tab.scroll;
    this.search = new document_search({
      page_count: () => 1,
      read_page: async () => this.content.textContent ?? '',
      select_match: (match, matches, reveal) => this.select_match(match, matches, reveal),
    });
    this.pane.id = `terminal-${tab.id}`;
    this.pane.className = 'terminal-pane markdown-pane';
    this.pane.setAttribute('role', 'tabpanel');
    this.pane.setAttribute('aria-label', tab.name);
    const toolbar = document.createElement('div');
    toolbar.className = 'markdown-toolbar';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', 'Markdown preview');
    const label = document.createElement('span');
    label.textContent = 'Markdown preview';
    const button = (title: string, icon: string, action: () => void) => {
      const element = document.createElement('button');
      element.className = 'icon-button';
      element.type = 'button';
      element.title = title;
      element.setAttribute('aria-label', title);
      const symbol = document.createElement('span');
      symbol.className = `codicon codicon-${icon}`;
      symbol.setAttribute('aria-hidden', 'true');
      element.append(symbol);
      element.addEventListener('click', action);
      return element;
    };
    toolbar.append(label,
      button('Open source file', 'go-to-file', () => this.send({ type: 'open_markdown_link', id: tab.id, href: tab.uri })),
      button('Reload Markdown', 'refresh', () => this.refresh()));
    this.notice.className = 'markdown-notice';
    this.notice.setAttribute('role', 'status');
    this.notice.textContent = 'Loading Markdown...';
    this.viewport.className = 'markdown-viewport';
    this.viewport.tabIndex = 0;
    this.viewport.setAttribute('aria-label', 'Markdown document. Use j and k to scroll, g for the beginning, G for the end.');
    this.content.className = 'markdown-content';
    this.viewport.append(this.content);
    this.viewport.addEventListener('keydown', event => this.keydown(event));
    this.viewport.addEventListener('scroll', () => {
      if (this.restore_frame !== undefined) return;
      clearTimeout(this.scroll_timer);
      this.scroll = this.viewport.scrollTop;
      this.scroll_timer = setTimeout(() => this.remember(), 180);
    });
    this.content.addEventListener('click', event => this.open_link(event));
    this.pane.append(toolbar, this.notice, this.viewport);
  }

  set_visible(visible: boolean): void {
    if (!visible) this.remember();
    this.pane.hidden = !visible;
    if (!visible) return;
    if (!this.requested) { this.requested = true; this.refresh(); }
    if (this.source !== this.rendered_source) this.render();
  }

  focus(): void { this.viewport.focus(); }
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

  private open_link(event: MouseEvent): void {
    const anchor = event.target instanceof Element ? event.target.closest('a') : undefined;
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute('href');
    if (!is_markdown_link(href)) return;
    if (href.startsWith('#')) {
      try {
        const heading = this.content.querySelector(`#${CSS.escape(decodeURIComponent(href.slice(1)))}`);
        if (heading) { heading.scrollIntoView({ block: 'start' }); return; }
      } catch { return; }
    }
    this.send({ type: 'open_markdown_link', id: this.tab.id, href });
  }

  private select_match(match?: document_match, matches: readonly document_match[] = [], reveal = true): void {
    if (this.highlight && CSS.highlights?.get('sidebar_markdown_find') === this.highlight) CSS.highlights.delete('sidebar_markdown_find');
    if (this.other_highlights && CSS.highlights?.get('sidebar_markdown_find_all') === this.other_highlights) CSS.highlights.delete('sidebar_markdown_find_all');
    this.highlight = undefined;
    this.other_highlights = undefined;
    if (!match || this.disposed) {
      this.cached_matches = undefined;
      this.match_ranges = [];
      return;
    }
    if (reveal && !this.pane.hidden && this.restore_frame !== undefined) {
      cancelAnimationFrame(this.restore_frame);
      this.restore_frame = undefined;
    }
    if (this.cached_matches !== matches) {
      this.cached_matches = matches;
      this.match_ranges = this.ranges_for_matches(matches);
    }
    const range = this.match_ranges[matches.indexOf(match)];
    if (!range) return;
    if (typeof Highlight !== 'undefined' && CSS.highlights) {
      this.other_highlights = new Highlight(...this.match_ranges);
      this.highlight = new Highlight(range);
      this.highlight.priority = 1;
      CSS.highlights.set('sidebar_markdown_find_all', this.other_highlights);
      CSS.highlights.set('sidebar_markdown_find', this.highlight);
    }
    if (reveal && !this.pane.hidden) {
      const rectangle = range.getBoundingClientRect();
      const viewport = this.viewport.getBoundingClientRect();
      this.viewport.scrollTop += rectangle.top - viewport.top - this.viewport.clientHeight / 2;
    }
  }

  /** Sorted non-overlapping results can share one forward pass through the text. */
  private ranges_for_matches(matches: readonly document_match[]): Range[] {
    const text = this.content.textContent ?? '';
    const nodes: Array<{ node: Node; start: number; end: number }> = [];
    const walker = document.createTreeWalker(this.content, NodeFilter.SHOW_TEXT);
    let raw_offset = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.textContent?.length ?? 0;
      if (length) nodes.push({ node, start: raw_offset, end: raw_offset + length });
      raw_offset += length;
    }
    if (!nodes.length) return [];
    const point = (offset: number) => {
      let lower = 0;
      let upper = nodes.length - 1;
      while (lower < upper) {
        const middle = Math.floor((lower + upper) / 2);
        if (nodes[middle].end < offset) lower = middle + 1;
        else upper = middle;
      }
      return { node: nodes[lower].node, offset: offset - nodes[lower].start };
    };
    let source_end = 0;
    let normalized_end = 0;
    return matches.map(match => {
      const offsets = search_source_range(text.slice(source_end), match.start - normalized_end, match.end - normalized_end);
      const start = point(source_end + offsets.start);
      const end = point(source_end + offsets.end);
      source_end += offsets.end;
      normalized_end = match.end;
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      return range;
    });
  }

  private keydown(event: KeyboardEvent): void {
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
    this.select_match(undefined);
    clearTimeout(this.scroll_timer);
    if (this.restore_frame !== undefined) cancelAnimationFrame(this.restore_frame);
    this.pane.remove();
    this.source = undefined;
    this.rendered_source = undefined;
  }
}
