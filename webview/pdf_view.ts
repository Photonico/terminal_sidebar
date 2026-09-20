import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask, TextLayer } from 'pdfjs-dist';
import type { client_message, pdf_tab } from '../src/types';
import type { pdf_zoom } from '../src/pdf_state';
import { document_search, type document_match } from './document_search';
import { pdf_page_wheel } from './pdf_paging';
import './pdf_view.css';
import './pdf_text_layer.css';

type pdf_library = typeof import('pdfjs-dist');
let library: Promise<pdf_library> | undefined;
const assets = document.querySelector<HTMLMetaElement>('meta[name="pdf-assets"]')?.content ?? '';

function load_library(): Promise<pdf_library> {
  return library ??= import(`${assets}/pdf.mjs`).then(async (module: pdf_library) => {
    // Webview workers cannot import scripts via VS Code's resource service worker.
    // Fetch the complete bundled module first, then start a self-contained blob worker.
    const response = await fetch(`${assets}/pdf.worker.mjs`);
    if (!response.ok) throw new Error(`PDF worker could not be loaded (${response.status})`);
    const source = new Blob([await response.arrayBuffer()], { type: 'text/javascript' });
    const worker_url = URL.createObjectURL(source);
    module.GlobalWorkerOptions.workerSrc = worker_url;
    window.addEventListener('unload', () => URL.revokeObjectURL(worker_url), { once: true });
    return module;
  }).catch(error => {
    library = undefined;
    throw error;
  });
}

function page_text(items: Array<{ str: string; hasEOL?: boolean } | { type: string }>): { text: string; offsets: number[] } {
  let text = '';
  const offsets: number[] = [];
  for (const item of items) {
    if (!('str' in item)) continue;
    offsets.push(text.length);
    text += item.str;
    if (item.hasEOL) text += '\n';
  }
  return { text, offsets };
}

/** A single rendered page bounds canvas memory even for long, image-heavy theses. */
export class pdf_view {
  readonly pane = document.createElement('div');
  readonly search: document_search;
  section?: HTMLElement;
  section_button?: HTMLButtonElement;
  section_label?: HTMLSpanElement;
  private readonly viewport = document.createElement('div');
  private readonly notice = document.createElement('div');
  private readonly page_input = document.createElement('input');
  private readonly count = document.createElement('span');
  private readonly zoom_input = document.createElement('select');
  private readonly previous: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private readonly observer: ResizeObserver;
  private pdf?: PDFDocumentProxy;
  private document_task?: PDFDocumentLoadingTask;
  private loading?: PDFDocumentLoadingTask;
  private render_task?: RenderTask;
  private text_layer?: TextLayer;
  private rendered_text?: TextLayer;
  private rendered_source?: ReturnType<typeof page_text>;
  private selected_match?: document_match;
  private matches: readonly document_match[] = [];
  private scroll_to_match = false;
  private load_revision = 0;
  private render_revision = 0;
  private resize_timer?: ReturnType<typeof setTimeout>;
  private requested = false;
  private disposed = false;
  private pending_url?: string;
  private loaded_url?: string;
  private readonly destroyed_tasks = new WeakSet<PDFDocumentLoadingTask>();
  private rendered_width = 0;
  private page: number;
  private zoom: pdf_zoom;
  private readonly paging = new pdf_page_wheel();
  private edge_scroll?: 'top' | 'bottom';

  constructor(
    readonly tab: pdf_tab,
    private readonly send: (message: client_message) => void,
    private readonly renderer: () => Promise<pdf_library> = load_library,
  ) {
    this.page = tab.page;
    this.zoom = tab.zoom;
    this.search = new document_search({
      page_count: () => this.pdf?.numPages ?? 0,
      read_page: async index => {
        const pdf = this.pdf;
        if (!pdf) return '';
        const page = await pdf.getPage(index + 1);
        try {
          const text = await page.getTextContent();
          return page_text(text.items).text;
        } finally { page.cleanup(); }
      },
      select_match: (match, matches, reveal) => this.select_match(match, matches, reveal),
    });
    this.pane.id = `terminal-${tab.id}`;
    this.pane.className = 'terminal-pane pdf-pane';
    this.pane.setAttribute('role', 'tabpanel');
    this.pane.setAttribute('aria-label', tab.name);
    const toolbar = document.createElement('div');
    toolbar.className = 'pdf-toolbar';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', 'PDF navigation');
    const button = (label: string, icon: string, action: () => void) => {
      const element = document.createElement('button');
      element.className = 'icon-button';
      element.type = 'button';
      element.title = label;
      element.setAttribute('aria-label', label);
      const symbol = document.createElement('span');
      symbol.className = `codicon codicon-${icon}`;
      symbol.setAttribute('aria-hidden', 'true');
      element.append(symbol);
      element.addEventListener('click', action);
      return element;
    };
    this.previous = button('Previous page (h)', 'chevron-left', () => this.navigate(this.page - 1));
    this.next = button('Next page (l)', 'chevron-right', () => this.navigate(this.page + 1));
    this.page_input.type = 'number';
    this.page_input.min = '1';
    this.page_input.step = '1';
    this.page_input.value = String(this.page);
    this.page_input.title = 'PDF page number, including front matter';
    this.page_input.setAttribute('aria-label', 'PDF page');
    this.page_input.addEventListener('change', () => this.navigate(Number(this.page_input.value)));
    this.page_input.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      this.navigate(Number(this.page_input.value));
      this.focus();
    });
    this.count.textContent = '/ ...';
    this.zoom_input.setAttribute('aria-label', 'PDF zoom');
    for (const [value, label] of [['page-width', 'Fit width'], ['page-fit', 'Fit page'], ['0.5', '50%'],
      ['0.75', '75%'], ['1', '100%'], ['1.25', '125%'], ['1.5', '150%'], ['2', '200%'], ['3', '300%'], ['4', '400%']]) {
      this.zoom_input.add(new Option(label, value));
    }
    this.zoom_input.value = String(this.zoom);
    if (!this.zoom_input.value && typeof this.zoom === 'number') {
      this.zoom_input.add(new Option(`${Math.round(this.zoom * 100)}%`, String(this.zoom)));
      this.zoom_input.value = String(this.zoom);
    }
    this.zoom_input.addEventListener('change', () => {
      this.zoom = this.zoom_input.value.startsWith('page-') ? this.zoom_input.value as pdf_zoom : Number(this.zoom_input.value);
      this.remember();
      void this.render();
    });
    toolbar.append(this.previous, this.page_input, this.count, this.next, this.zoom_input,
      button('Reload PDF', 'refresh', () => this.refresh()));
    this.notice.className = 'pdf-notice';
    this.notice.setAttribute('role', 'status');
    this.notice.textContent = 'Loading PDF...';
    this.viewport.className = 'pdf-viewport';
    this.viewport.tabIndex = 0;
    this.viewport.setAttribute('aria-label', 'PDF page. Use h and l to turn pages, j and k to scroll.');
    this.viewport.addEventListener('keydown', event => this.keydown(event));
    this.viewport.addEventListener('wheel', event => {
      if (!this.pdf || this.pane.hidden) return;
      const action = this.paging.step(event, {
        top: this.viewport.scrollTop, height: this.viewport.scrollHeight, visible: this.viewport.clientHeight,
        previous: this.page > 1, next: this.page < this.pdf.numPages,
      }, performance.now());
      if (action.consume) { event.preventDefault(); event.stopPropagation(); }
      if (action.page) this.navigate(this.page + action.page, action.page < 0 ? 'bottom' : 'top');
    }, { passive: false });
    this.pane.append(toolbar, this.notice, this.viewport);
    this.observer = new ResizeObserver(() => {
      clearTimeout(this.resize_timer);
      this.resize_timer = setTimeout(() => {
        if (this.zoom === 'page-fit' || this.viewport.clientWidth !== this.rendered_width) void this.render();
      }, 120);
    });
    this.observer.observe(this.viewport);
    this.update_controls();
  }

  set_visible(visible: boolean): void {
    this.pane.hidden = !visible;
    if (!visible) { this.cancel_render(); this.rendered_width = 0; return; }
    if (!this.requested) { this.requested = true; this.refresh(); }
    else if (this.pending_url && this.pending_url !== this.loaded_url && !this.loading) void this.load(this.pending_url);
    else if (this.pdf && this.viewport.clientWidth !== this.rendered_width) void this.render();
  }

  focus(): void { this.viewport.focus(); }
  refresh(): void { if (!this.disposed) this.send({ type: 'load_pdf', id: this.tab.id }); }

  error(message: string): void {
    if (this.disposed) return;
    this.notice.hidden = false;
    this.notice.textContent = message;
  }

  async load(url: string): Promise<void> {
    if (this.disposed) return;
    this.requested = true;
    this.pending_url = url;
    const revision = ++this.load_revision;
    this.destroy_task(this.loading);
    this.loading = undefined;
    if (this.pane.hidden) return;
    this.error(this.pdf ? 'Updating PDF...' : 'Loading PDF...');
    let task: PDFDocumentLoadingTask | undefined;
    try {
      const module = await this.renderer();
      if (this.disposed || revision !== this.load_revision) return;
      task = module.getDocument({
        url, cMapUrl: `${assets}/cmaps/`, cMapPacked: true,
        standardFontDataUrl: `${assets}/standard_fonts/`, wasmUrl: `${assets}/wasm/`,
        iccUrl: `${assets}/iccs/`,
        useWorkerFetch: false,
        disableRange: false, rangeChunkSize: 256 * 1024,
        disableAutoFetch: true, disableStream: true, canvasMaxAreaInBytes: 64 * 1024 * 1024,
      });
      this.loading = task;
      const pdf = await task.promise;
      if (this.disposed || revision !== this.load_revision) return;
      this.cancel_render();
      const previous_task = this.document_task;
      this.pdf = pdf;
      this.document_task = task;
      this.loaded_url = url;
      this.loading = undefined;
      this.rendered_width = 0;
      this.page = Math.min(this.page, pdf.numPages);
      this.remember();
      this.update_controls();
      this.destroy_task(previous_task);
      this.search.reset();
      await this.render(true);
    } catch (error) {
      if (!this.disposed && revision === this.load_revision) {
        console.error('Side Terminal PDF load failed', error);
        this.loading = undefined;
        this.error('PDF could not be loaded. It will refresh after the next file change; use Reload to retry.');
      }
    } finally {
      if (task && this.document_task !== task) this.destroy_task(task);
      if (this.loading === task) this.loading = undefined;
    }
  }

  private destroy_task(task?: PDFDocumentLoadingTask): void {
    if (!task || this.destroyed_tasks.has(task)) return;
    this.destroyed_tasks.add(task);
    void task.destroy().catch(() => undefined);
  }

  private navigate(page: number, position: 'top' | 'bottom' = 'top', reveal_match = false): void {
    if (!this.pdf) return;
    if (Number.isFinite(page)) this.page = Math.max(1, Math.min(Math.trunc(page), this.pdf.numPages));
    this.remember();
    this.update_controls();
    this.edge_scroll = position;
    if (!reveal_match) this.scroll_to_match = false;
    this.viewport.scrollTop = 0;
    void this.render();
  }

  private update_controls(): void {
    this.page_input.value = String(this.page);
    this.page_input.max = String(this.pdf?.numPages ?? 1);
    this.page_input.disabled = !this.pdf;
    this.previous.disabled = !this.pdf || this.page === 1;
    this.next.disabled = !this.pdf || this.page >= this.pdf.numPages;
    this.count.textContent = `/ ${this.pdf?.numPages ?? '...'}`;
  }

  private remember(): void {
    this.send({ type: 'pdf_position', id: this.tab.id, position: { page: this.page, zoom: this.zoom } });
  }

  private cancel_render(): void {
    ++this.render_revision;
    this.render_task?.cancel();
    this.text_layer?.cancel();
    this.render_task = undefined;
    this.text_layer = undefined;
  }

  private async render(preserve_scroll = false): Promise<void> {
    if (!this.pdf || this.disposed || this.pane.hidden || this.viewport.clientWidth < 1) return;
    this.cancel_render();
    const revision = this.render_revision;
    const scroll = this.viewport.scrollTop;
    const pdf = this.pdf;
    const page_number = this.page;
    const edge_scroll = this.edge_scroll;
    let page: PDFPageProxy | undefined;
    let canvas: HTMLCanvasElement | undefined;
    let attached = false;
    try {
      page = await pdf.getPage(page_number);
      if (this.disposed || revision !== this.render_revision) return;
      const base = page.getViewport({ scale: 1 });
      const width = this.viewport.clientWidth;
      const scale = typeof this.zoom === 'number' ? this.zoom : this.zoom === 'page-width'
        ? (width - 24) / base.width
        : Math.min((width - 24) / base.width, (this.viewport.clientHeight - 24) / base.height);
      const viewport = page.getViewport({ scale: Math.max(0.1, scale) });
      // Avoid unbounded allocations on HiDPI displays and large-format PDF pages.
      const pixels = Math.min(window.devicePixelRatio || 1, 2,
        16_384 / viewport.width, 16_384 / viewport.height,
        Math.sqrt(16_000_000 / (viewport.width * viewport.height)));
      canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width * pixels));
      canvas.height = Math.max(1, Math.floor(viewport.height * pixels));
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const rendered = document.createElement('div');
      rendered.className = 'pdf-page';
      rendered.style.width = `${viewport.width}px`;
      rendered.style.height = `${viewport.height}px`;
      rendered.style.setProperty('--total-scale-factor', String(viewport.scale));
      rendered.style.setProperty('--scale-round-x', '1px');
      rendered.style.setProperty('--scale-round-y', '1px');
      rendered.append(canvas);
      this.render_task = page.render({ canvas, viewport, transform: [pixels, 0, 0, pixels, 0, 0] });
      await this.render_task.promise;
      if (this.disposed || revision !== this.render_revision) return;
      const module = await this.renderer();
      if (this.disposed || revision !== this.render_revision) return;
      const text = document.createElement('div');
      text.className = 'textLayer';
      rendered.append(text);
      const content = await page.getTextContent();
      if (this.disposed || revision !== this.render_revision) return;
      this.text_layer = new module.TextLayer({ textContentSource: content, container: text, viewport });
      const text_layer = this.text_layer;
      // Canvas remains useful when an unusual PDF has a malformed text layer.
      await this.text_layer.render().catch(() => undefined);
      if (this.disposed || revision !== this.render_revision) return;
      this.clear_canvas();
      this.viewport.replaceChildren(rendered);
      this.rendered_text = text_layer;
      this.rendered_source = page_text(content.items);
      rendered.addEventListener('dblclick', event => {
        if (!(event.target instanceof Element) || !event.target.closest('.textLayer span')) return;
        const rectangle = rendered.getBoundingClientRect();
        const [x, y] = viewport.convertToPdfPoint(event.clientX - rectangle.left, event.clientY - rectangle.top);
        this.send({ type: 'pdf_reverse_sync', id: this.tab.id, page: page_number,
          x: Math.max(0, x - page!.view[0]), y: Math.max(0, page!.view[3] - y) });
      });
      attached = true;
      this.viewport.scrollTop = edge_scroll === 'bottom' ? this.viewport.scrollHeight
        : preserve_scroll ? scroll : this.viewport.scrollTop;
      this.edge_scroll = undefined;
      this.rendered_width = width;
      this.notice.hidden = true;
      this.pane.dataset.pdfPage = String(page_number);
      this.pane.dataset.pdfPages = String(pdf.numPages);
      this.highlight_match();
    } catch (error) {
      if (!this.disposed && revision === this.render_revision && (error as Error).name !== 'RenderingCancelledException') {
        this.error('This page could not be rendered. Try another page or reload the PDF.');
      }
    } finally {
      // Free offscreen canvas allocations from cancelled work immediately.
      if (canvas && !attached) { canvas.width = 0; canvas.height = 0; }
      page?.cleanup();
    }
  }

  private clear_canvas(): void {
    for (const canvas of this.viewport.querySelectorAll('canvas')) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  private select_match(match: document_match | undefined, matches: readonly document_match[], reveal: boolean): void {
    this.selected_match = match;
    this.matches = matches;
    const navigate = reveal && !this.pane.hidden;
    this.scroll_to_match = !!match && navigate;
    if (match && navigate && this.page !== match.page + 1) this.navigate(match.page + 1, 'top', true);
    else this.highlight_match();
  }

  private highlight_match(): void {
    for (const match of this.viewport.querySelectorAll('.pdf_find_match')) match.remove();
    const selected = this.selected_match;
    const layer = this.rendered_text;
    const rendered_source = this.rendered_source;
    const rendered = this.viewport.querySelector<HTMLElement>('.pdf-page');
    if (!layer || !rendered || !rendered_source) return;
    const matches = this.matches.filter(match => match.page + 1 === Number(this.pane.dataset.pdfPage));
    if (!matches.length) return;
    const strings = layer.textContentItemsStr;
    const normalized_offsets: number[] = [];
    for (let index = 0; index < rendered_source.text.length;) {
      normalized_offsets.push(index);
      if (/\s/u.test(rendered_source.text[index++])) {
        while (index < rendered_source.text.length && /\s/u.test(rendered_source.text[index])) index++;
      }
    }
    normalized_offsets.push(rendered_source.text.length);
    let first: HTMLElement | undefined;
    const page_rectangle = rendered.getBoundingClientRect();
    let first_span = 0;
    for (const match of matches) {
      const active = match === selected;
      const source = { start: normalized_offsets[match.start], end: normalized_offsets[match.end] };
      while (first_span + 1 < strings.length && rendered_source.offsets[first_span] + strings[first_span].length <= source.start) first_span++;
      for (let index = first_span; index < strings.length; index++) {
        const text = strings[index];
        const span = layer.textDivs[index];
        const offset = rendered_source.offsets[index];
        if (offset >= source.end) break;
        const start = Math.max(0, source.start - offset);
        const end = Math.min(text.length, source.end - offset);
        if (!span?.firstChild || start >= end) continue;
        const range = document.createRange();
        range.setStart(span.firstChild, start);
        range.setEnd(span.firstChild, end);
        for (const rectangle of range.getClientRects()) {
          const highlight = document.createElement('span');
          highlight.className = active ? 'pdf_find_match pdf_find_active' : 'pdf_find_match';
          highlight.style.left = `${rectangle.left - page_rectangle.left}px`;
          highlight.style.top = `${rectangle.top - page_rectangle.top}px`;
          highlight.style.width = `${rectangle.width}px`;
          highlight.style.height = `${rectangle.height}px`;
          rendered.append(highlight);
          if (active) first ??= highlight;
        }
      }
    }
    if (this.scroll_to_match && first) {
      first.scrollIntoView({ block: 'center', inline: 'nearest' });
      this.scroll_to_match = false;
    }
  }

  private keydown(event: KeyboardEvent): void {
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    switch (event.key) {
      case 'h': case 'ArrowLeft': this.navigate(this.page - 1); break;
      case 'l': case 'ArrowRight': this.navigate(this.page + 1); break;
      case 'j': this.viewport.scrollBy({ top: 70 }); break;
      case 'k': this.viewport.scrollBy({ top: -70 }); break;
      case 'g': this.navigate(1); break;
      case 'G': this.navigate(this.pdf?.numPages ?? 1); break;
      case 'r': this.refresh(); break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    ++this.load_revision;
    this.cancel_render();
    this.search.dispose();
    this.observer.disconnect();
    clearTimeout(this.resize_timer);
    this.destroy_task(this.loading);
    this.destroy_task(this.document_task);
    this.clear_canvas();
    this.pane.remove();
  }
}
