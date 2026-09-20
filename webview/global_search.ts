import { source_formatter } from './document_render';
import { prepare_html, html_search_text } from './html_preview';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import type { ISearchOptions } from '@xterm/addon-search';
import type { client_message } from '../src/types';
import type { search_tab, search_source, search_response, search_location, terminal_snapshot } from '../src/global_search_protocol';
import { document_search, search_source_range, normalize_search_text, type document_match } from './document_search';
import { load_pdf_library, page_text, pdf_document_options } from './pdf_view';
import { render_markdown } from './markdown_render';
import './global_search.css';

interface search_page { tab: search_tab; page: number; text?: string; snapshot?: terminal_snapshot; reading?: Promise<string> }

/** A snapshot search of both sidebars. PDF text is read sequentially, without rendering canvases. */
export class global_search {
  readonly root = document.createElement('div');
  private readonly engine: document_search;
  private pages: search_page[] = [];
  private readonly pending = new Map<string, { resolve(response: search_response): void; reject(): void }>();
  private task?: PDFDocumentLoadingTask;
  private pdf?: PDFDocumentProxy;
  private pdf_id?: string;
  private revision = 0;
  private query = '';
  private follow = false;
  private unavailable = new Set<string>();
  private selected?: document_match;
  private current_matches: readonly document_match[] = [];
  private page_size = 100;
  private formatter?: source_formatter;

  constructor(private readonly send: (message: client_message) => void,
    worker_factory?: ConstructorParameters<typeof document_search>[1]) {
    this.root.className = 'global_search_results';
    this.root.hidden = true;
    this.root.setAttribute('aria-label', 'Results in all open Side Terminals tabs');
    this.engine = new document_search({
      page_count: () => this.pages.length,
      read_page: index => this.read_page(index),
      select_match: (match, matches) => {
        this.selected = match;
        this.current_matches = matches;
        this.render_results();
        if (match && this.follow) this.reveal(match);
      },
    }, worker_factory);
  }

  readonly onDidChangeResults = (listener: Parameters<document_search['onDidChangeResults']>[0]) =>
    this.engine.onDidChangeResults(result => listener(this.unavailable.size && !result.message?.startsWith('Searching')
      ? { ...result, message: `${result.resultCount} results · ${this.unavailable.size} unavailable` } : result));

  async prepare(): Promise<void> {
    this.reset();
    const revision = this.revision;
    const response = await this.request({ type: 'search_catalog', request: crypto.randomUUID() });
    if (revision !== this.revision || response.type !== 'search_catalog') return;
    this.pages = response.tabs.map(tab => ({ tab, page: 0 }));
    this.root.hidden = false;
  }

  receive(message: search_response): void {
    if (message.type === 'search_source' || message.type === 'search_catalog') this.pending.get(message.request)?.resolve(message);
  }

  private request(message: Extract<client_message, { type: 'search_read' | 'search_catalog' }>): Promise<search_response> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(), 10000);
      const finish = (response?: search_response) => {
        clearTimeout(timer);
        this.pending.delete(message.request);
        if (response) resolve(response); else reject(new Error('Search request cancelled or timed out'));
      };
      this.pending.set(message.request, { resolve: finish, reject: () => finish() });
      this.send(message);
    });
  }

  private read_page(index: number): Promise<string> {
    const entry = this.pages[index];
    if (!entry) return Promise.resolve('');
    return entry.reading ??= this.read_source(index).then(text => { entry.text = text; return text; });
  }

  private async read_source(index: number): Promise<string> {
    const entry = this.pages[index];
    if (!entry) return '';
    if (entry.text !== undefined) return entry.text;
    const revision = this.revision;
    try {
      if (entry.tab.kind === 'pdf' && entry.page > 0 && this.pdf_id === `${entry.tab.side}:${entry.tab.id}` && this.pdf) {
        return await this.pdf_text(this.pdf, entry.page);
      }
      const response = await this.request({ type: 'search_read', request: crypto.randomUUID(), side: entry.tab.side, id: entry.tab.id });
      if (revision !== this.revision) return '';
      if (response.type !== 'search_source' || !response.source) throw new Error(response.type === 'search_source' ? response.error : 'Unavailable');
      const source: search_source = response.source;
      if (source.kind === 'terminal') {
        entry.snapshot = source.snapshot;
        entry.text = source.snapshot.text;
        return entry.text;
      }
      if (source.kind === 'markdown') {
        const content = document.createElement('template');
        // Parsing is inert: no images, links, or scripts are attached to the document.
        content.innerHTML = render_markdown({ text: source.text, base_url: 'https://invalid.local/' });
        entry.text = content.content.textContent ?? '';
        return entry.text;
      }
      if (source.kind === 'document') {
        if (source.format === 'html') {
          const html = new DOMParser().parseFromString(prepare_html({ text: source.text, base_url: 'https://invalid.local/' }), 'text/html');
          return html_search_text(html.body);
        }
        this.formatter ??= new source_formatter();
        const formatted = await this.formatter.format(source.text, source.format);
        return revision === this.revision && !formatted.cancelled ? formatted.text : '';
      }
      const module = await load_pdf_library();
      if (revision !== this.revision) return '';
      this.release_pdf();
      const task = module.getDocument(pdf_document_options(source.url));
      this.task = task;
      const pdf = await task.promise;
      if (revision !== this.revision) return '';
      this.pdf = pdf;
      this.pdf_id = `${entry.tab.side}:${entry.tab.id}`;
      this.pages.splice(index + 1, 0, ...Array.from({ length: pdf.numPages - 1 }, (_, page) => ({ tab: entry.tab, page: page + 1 })));
      return await this.pdf_text(pdf, 0);
    } catch (error) {
      if (revision === this.revision) this.unavailable.add(`${entry.tab.side}:${entry.tab.id}`);
      return '';
    }
  }

  private async pdf_text(pdf: PDFDocumentProxy, index: number): Promise<string> {
    const page = await pdf.getPage(index + 1);
    try { return page_text((await page.getTextContent()).items).text; }
    finally { page.cleanup(); }
  }

  private release_pdf(): void {
    void this.task?.destroy().catch(() => undefined);
    this.task = undefined;
    this.pdf = undefined;
    this.pdf_id = undefined;
  }

  findNext(query: string, options: ISearchOptions = {}): boolean {
    this.root.hidden = false;
    this.query = query;
    this.follow = !options.incremental;
    return this.engine.findNext(query, options);
  }
  findPrevious(query: string, options: ISearchOptions = {}): boolean {
    this.root.hidden = false;
    this.query = query;
    this.follow = !options.incremental;
    return this.engine.findPrevious(query, options);
  }

  private reveal(match: document_match): void {
    const entry = this.pages[match.page];
    if (!entry) return;
    let location: search_location = { page: entry.page, start: match.start, end: match.end };
    if (entry.snapshot) {
      const source = search_source_range(entry.snapshot.text, match.start, match.end);
      const row = [...entry.snapshot.rows].reverse().find(row => row.offset <= source.start);
      if (row) location = { page: row.row, start: source.start - row.offset, end: source.end - row.offset };
    }
    this.send({ type: 'search_reveal', side: entry.tab.side, id: entry.tab.id, location, query: this.query });
  }

  private render_results(): void {
    this.root.replaceChildren();
    const heading = document.createElement('div');
    heading.className = 'global_search_heading';
    heading.textContent = 'All open tabs · Primary and Secondary Side Bars';
    this.root.append(heading);
    const selected_index = this.current_matches.indexOf(this.selected!);
    const first = Math.max(0, Math.floor(Math.max(0, selected_index) / this.page_size) * this.page_size);
    for (const match of this.current_matches.slice(first, first + this.page_size)) {
      const entry = this.pages[match.page];
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'global_search_hit';
      button.setAttribute('aria-current', String(match === this.selected));
      const label = `${entry.tab.side === 'left' ? 'Primary' : 'Secondary'} · ${entry.tab.name}`
        + (entry.tab.kind === 'pdf' ? ` · Page ${entry.page + 1}` : '');
      const preview = entry.text ? normalize_search_text(entry.text).slice(Math.max(0, match.start - 35), match.end + 60) : '';
      button.textContent = preview ? `${label}\n${preview}` : `${label} · Match at ${match.start + 1}`;
      button.title = `Reveal match in ${label}${preview ? `\n${preview}` : ''}`;
      button.addEventListener('click', () => {
        this.follow = true;
        this.engine.select_result(this.current_matches.indexOf(match));
      });
      this.root.append(button);
    }
    if (this.current_matches.length > this.page_size) {
      const summary = document.createElement('div');
      summary.textContent = `Showing ${first + 1}–${Math.min(first + this.page_size, this.current_matches.length)}. Use Next / Previous for more.`;
      this.root.append(summary);
    }
  }

  clearActiveDecoration(): void {}
  clearDecorations(): void {
    this.engine.clearDecorations();
    this.root.hidden = true;
  }
  end(): void { this.reset(); }

  private reset(): void {
    ++this.revision;
    this.engine.clearDecorations();
    this.engine.reset();
    this.release_pdf();
    this.formatter?.dispose();
    this.formatter = undefined;
    for (const request of this.pending.values()) request.reject();
    this.pages = [];
    this.unavailable.clear();
    this.root.hidden = true;
  }
  dispose(): void { this.reset(); this.engine.dispose(); this.root.remove(); }
}
