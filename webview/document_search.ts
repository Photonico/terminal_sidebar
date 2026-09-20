import type { ISearchOptions } from '@xterm/addon-search';
import type { IDisposable } from '@xterm/xterm';
import type { document_search_request, document_search_result } from './document_search_worker';

export interface document_match { page: number; start: number; end: number }
export interface document_search_status { resultCount: number; resultIndex: number; message?: string }
export interface document_search_provider {
  page_count(): number;
  read_page(page: number): Promise<string>;
  select_match(match: document_match | undefined, matches: readonly document_match[], reveal: boolean): void;
}

type search_worker = Pick<Worker, 'postMessage' | 'terminate' | 'onmessage' | 'onerror'>;
const maximum_characters = 16_000_000;
const maximum_page_characters = 4 * 1024 * 1024;
const maximum_matches = 10_000;
let worker_source: Promise<Blob> | undefined;

/** Treat visual line breaks and repeated layout spaces as ordinary word spacing. */
export function normalize_search_text(text: string): string { return text.replace(/\s+/gu, ' '); }

/** Translate normalized result offsets back to the uncollapsed DOM text. */
export function search_source_range(text: string, start: number, end: number): { start: number; end: number } {
  let normalized = 0;
  let source_start = text.length;
  let source_end = text.length;
  for (let source = 0; source < text.length;) {
    let next = source + 1;
    if (/\s/u.test(text[source])) while (next < text.length && /\s/u.test(text[next])) next++;
    if (normalized === start) source_start = source;
    if (normalized + 1 === end) { source_end = next; break; }
    source = next;
    normalized++;
  }
  return { start: source_start, end: source_end };
}

async function create_worker(): Promise<search_worker> {
  const assets = document.querySelector<HTMLMetaElement>('meta[name="pdf-assets"]')?.content;
  if (!assets) throw new Error('Search worker assets are unavailable');
  const source = new URL('../document_search_worker.js', `${assets}/`);
  worker_source ??= fetch(source).then(async response => {
    if (!response.ok) throw new Error(`Search worker could not be loaded (${response.status})`);
    return new Blob([await response.arrayBuffer()], { type: 'text/javascript' });
  }).catch(error => { worker_source = undefined; throw error; });
  // Webview workers need the whole bundled source; importing resource URLs inside
  // a worker bypasses VS Code's resource service worker and fails.
  const wrapper = URL.createObjectURL(await worker_source);
  try { return new Worker(wrapper); }
  finally { URL.revokeObjectURL(wrapper); }
}

/** Cancellable full-document indexing; the small widget API also matches xterm search. */
export class document_search {
  private readonly listeners = new Set<(result: document_search_status) => void>();
  private readonly pages = new Map<number, string>();
  private cached_characters = 0;
  private matches: document_match[] = [];
  private index = -1;
  private revision = 0;
  private searching = false;
  private key = '';
  private query = '';
  private options: ISearchOptions = {};
  private worker?: search_worker;
  private cancel_request?: () => void;
  private disposed = false;

  constructor(
    private readonly provider: document_search_provider,
    private readonly worker_factory: () => search_worker | Promise<search_worker> = create_worker,
  ) {}

  readonly onDidChangeResults = (listener: (result: document_search_status) => void): IDisposable => {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  };

  findNext(query: string, options: ISearchOptions = {}): boolean { return this.find(query, options, false); }
  findPrevious(query: string, options: ISearchOptions = {}): boolean { return this.find(query, options, true); }

  private find(query: string, options: ISearchOptions, previous: boolean, reveal = true, anchor?: document_match): boolean {
    if (this.disposed) return false;
    const normalized = options.regex ? query : normalize_search_text(query);
    const key = JSON.stringify([normalized, !!options.regex, !!options.caseSensitive, !!options.wholeWord]);
    if (key !== this.key) {
      this.cancel();
      this.key = key;
      this.query = normalized;
      this.options = options;
      this.matches = [];
      this.index = -1;
      this.provider.select_match(undefined, [], false);
      if (!normalized) { this.emit(); return false; }
      this.searching = true;
      this.emit('Searching…');
      void this.scan(this.revision, previous, reveal, anchor);
      return true;
    }
    if (this.searching) return true;
    if (!this.matches.length) return false;
    if (!options.incremental) this.index = (this.index + (previous ? -1 : 1) + this.matches.length) % this.matches.length;
    this.provider.select_match(this.matches[this.index], this.matches, reveal);
    this.emit();
    return true;
  }

  select_result(index: number): void {
    if (this.disposed || this.searching || !Number.isInteger(index) || !this.matches[index]) return;
    this.index = index;
    this.provider.select_match(this.matches[index], this.matches, true);
    this.emit();
  }

  private async scan(revision: number, previous: boolean, reveal: boolean, anchor?: document_match): Promise<void> {
    try {
      const worker = await this.worker_factory();
      if (!this.current(revision)) { worker.terminate(); return; }
      this.worker = worker;
      let characters = 0;
      let truncated = false;
      for (let page = 0; page < this.provider.page_count(); page++) {
        let text = this.pages.get(page);
        if (text === undefined) {
          text = normalize_search_text(await this.provider.read_page(page));
          if (!this.current(revision)) return;
          if (text.length > maximum_page_characters) throw new Error('This page is too large to search safely');
          if (this.cached_characters + text.length <= maximum_characters) {
            this.pages.set(page, text);
            this.cached_characters += text.length;
          }
        }
        characters += text.length;
        if (characters > maximum_characters) throw new Error('This document is too large to search safely');
        const result = await this.match_page(worker, {
          text, query: this.query, regex: !!this.options.regex, case_sensitive: !!this.options.caseSensitive,
          whole_word: !!this.options.wholeWord, limit: maximum_matches - this.matches.length,
        });
        if (!this.current(revision)) return;
        if (result.message) throw new Error(result.message);
        this.matches.push(...result.matches.map(hit => ({ page, ...hit })));
        if (result.truncated || this.matches.length >= maximum_matches) { truncated = true; break; }
        this.emit(`Searching… ${page + 1} / ${this.provider.page_count()}`);
      }
      if (!this.current(revision)) return;
      this.searching = false;
      this.index = this.matches.length ? (previous ? this.matches.length - 1 : 0) : -1;
      if (anchor && this.matches.length) {
        const nearest = this.matches.findIndex(match => match.page > anchor.page
          || (match.page === anchor.page && match.start >= anchor.start));
        if (nearest >= 0) this.index = nearest;
      }
      this.provider.select_match(this.matches[this.index], this.matches, reveal);
      this.emit(truncated ? `${this.matches.length}+ results` : undefined);
    } catch (error) {
      if (!this.current(revision)) return;
      this.searching = false;
      this.matches = [];
      this.index = -1;
      this.provider.select_match(undefined, [], false);
      this.emit(error instanceof Error ? error.message : 'Document search failed');
    } finally {
      if (this.current(revision)) { this.worker?.terminate(); this.worker = undefined; }
    }
  }

  private match_page(worker: search_worker, request: document_search_request): Promise<document_search_result> {
    return new Promise((resolve, reject) => {
      const finish = (result?: document_search_result, error?: Error) => {
        clearTimeout(timer);
        this.cancel_request = undefined;
        worker.onmessage = null;
        worker.onerror = null;
        if (error) reject(error); else resolve(result!);
      };
      const timer = setTimeout(() => {
        worker.terminate();
        finish(undefined, new Error('Search took too long; simplify the regular expression'));
      }, 1500);
      this.cancel_request = () => finish(undefined, new Error('Search cancelled'));
      worker.onmessage = event => finish(event.data as document_search_result);
      worker.onerror = () => finish(undefined, new Error('Document search worker failed'));
      worker.postMessage(request);
    });
  }

  private emit(message?: string): void {
    const status = { resultCount: this.matches.length, resultIndex: this.index, message };
    for (const listener of this.listeners) listener(status);
  }

  private current(revision: number): boolean { return !this.disposed && revision === this.revision; }
  private cancel(): void {
    ++this.revision;
    this.cancel_request?.();
    this.worker?.terminate();
    this.worker = undefined;
    this.searching = false;
  }

  clearDecorations(): void {
    this.cancel();
    this.key = '';
    this.query = '';
    this.matches = [];
    this.index = -1;
    this.provider.select_match(undefined, [], false);
    this.emit();
  }

  clearActiveDecoration(): void { /* Keep the selected result visible when Find loses focus. */ }

  /** Refresh after a document update while retaining the open widget's query and options. */
  reset(): void {
    const query = this.query;
    const options = this.options;
    const anchor = this.matches[this.index];
    this.clearDecorations();
    this.pages.clear();
    this.cached_characters = 0;
    // Reindexing is not a navigation gesture. Keep the reader's page/scroll intact.
    if (query) this.find(query, { ...options, incremental: true }, false, false, anchor);
  }

  dispose(): void {
    if (this.disposed) return;
    this.clearDecorations();
    this.disposed = true;
    this.pages.clear();
    this.listeners.clear();
  }
}
