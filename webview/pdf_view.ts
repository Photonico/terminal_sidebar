import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask, TextLayer } from 'pdfjs-dist';
import type { client_message, pdf_tab } from '../src/types';
import type { pdf_zoom, pdf_mode } from '../src/pdf_state';
import { document_search, type document_match } from './document_search';
import { layout_document, adjacent_page, current_page, visible_pages, type document_layout, type page_size } from './pdf_layout';
import { pdf_toolbar } from './pdf_toolbar';
import { pdf_outline } from './pdf_outline';
import { preview_overlay } from './preview_controls';
import './pdf_view.css';
import './pdf_text_layer.css';

type pdf_library = typeof import('pdfjs-dist');
let library: Promise<pdf_library> | undefined;
const assets = document.querySelector<HTMLMetaElement>('meta[name="pdf-assets"]')?.content ?? '';

export function load_pdf_library(): Promise<pdf_library> {
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

export function pdf_document_options(url: string) {
  return {
    url, cMapUrl: `${assets}/cmaps/`, cMapPacked: true,
    standardFontDataUrl: `${assets}/standard_fonts/`, wasmUrl: `${assets}/wasm/`,
    iccUrl: `${assets}/iccs/`,
    useWorkerFetch: false,
    disableRange: false, rangeChunkSize: 256 * 1024,
    disableAutoFetch: true, disableStream: true, canvasMaxAreaInBytes: 64 * 1024 * 1024,
  };
}

export function page_text(items: Array<{ str: string; hasEOL?: boolean } | { type: string }>): { text: string; offsets: number[] } {
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

interface rendered_page {
  element: HTMLDivElement;
  canvas?: HTMLCanvasElement;
  task?: RenderTask;
  layer?: TextLayer;
  source?: ReturnType<typeof page_text>;
}

/** Page geometry spans the document; only nearby canvases and text layers stay alive. */
export class pdf_view {
  readonly pane = document.createElement('div');
  readonly search: document_search;
  section?: HTMLElement;
  section_button?: HTMLButtonElement;
  section_label?: HTMLSpanElement;
  private readonly viewport = document.createElement('div');
  private readonly pages = document.createElement('div');
  private canvas_pixel_budget = 4_000_000;
  private readonly rendered = new Map<number, rendered_page>();
  private sizes: page_size[] = [];
  private geometry?: document_layout;
  private scroll_timer?: ReturnType<typeof setTimeout>;
  private readonly notice = document.createElement('div');
  private readonly toolbar: pdf_toolbar;
  private readonly outline: pdf_outline;
  private readonly overlay: preview_overlay;
  private outline_open = false;
  private mode: pdf_mode;
  private dark: boolean;
  private zoom_timer?: ReturnType<typeof setTimeout>;
  private readonly observer: ResizeObserver;
  private pdf?: PDFDocumentProxy;
  private document_task?: PDFDocumentLoadingTask;
  private loading?: PDFDocumentLoadingTask;
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


  constructor(
    readonly tab: pdf_tab,
    private readonly send: (message: client_message) => void,
    private readonly renderer: () => Promise<pdf_library> = load_pdf_library,
  ) {
    this.page = tab.page;
    this.zoom = tab.zoom;
    this.mode = tab.mode ?? 'continuous';
    this.dark = tab.dark ?? false;
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
    this.outline = new pdf_outline(page => this.navigate(page));
    this.toolbar = new pdf_toolbar({
      outline: () => this.set_outline(!this.outline_open),
      move: direction => this.move(direction),
      zoom: direction => this.change_zoom(direction),
      page: page => { this.navigate(page); this.focus(); },
      set_zoom: zoom => this.set_zoom(zoom),
      reload: () => this.refresh(),
      mode: mode => {
        if (this.mode === mode) return;
        this.mode = mode;
        this.remember();
        this.update_controls();
        void this.render();
      },
      dark: enabled => {
        this.dark = enabled;
        this.remember();
        this.update_controls();
      },
    });
    this.notice.className = 'pdf-notice';
    this.notice.setAttribute('role', 'status');
    this.notice.textContent = 'Loading PDF...';
    this.viewport.className = 'pdf-viewport';
    this.viewport.tabIndex = 0;
    this.viewport.setAttribute('aria-label', 'PDF pages. Use h and l to turn pages, j and k to scroll; Command or Control plus mouse wheel to zoom.');
    this.viewport.addEventListener('keydown', event => this.keydown(event));
    this.viewport.addEventListener('wheel', event => this.wheel(event), { passive: false });
    this.pages.className = 'pdf-pages';
    this.viewport.append(this.pages);
    this.viewport.addEventListener('scroll', () => {
      if (!this.pdf || this.pane.hidden || !this.geometry?.continuous) return;
      const page = current_page(this.geometry.continuous, this.viewport.scrollTop, this.visible_height()) + 1;
      if (page !== this.page) {
        this.page = page;
        this.update_controls();
        clearTimeout(this.scroll_timer);
        this.scroll_timer = setTimeout(() => this.remember(), 150);
      }
      void this.render_visible();
    });
    const body = document.createElement('div');
    body.className = 'pdf-body';
    body.append(this.outline.root, this.viewport);
    this.outline.root.addEventListener('keydown', event => {
      if (event.isComposing || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      this.set_outline(false);
      this.toolbar.focus_outline();
    });
    // Fit page follows the height left below the toolbar; other zooms only reveal newly uncovered pages.
    this.overlay = new preview_overlay(this.pane, this.viewport, [this.toolbar.root, this.notice], () => this.viewport,
      () => { if (this.zoom === 'page-fit') void this.render(); else void this.render_visible(); });
    this.pane.append(this.overlay.root, body);
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
    this.toolbar.set_visible(visible);
    this.outline.set_open(visible && this.outline_open);
    if (!visible) { this.cancel_render(); this.rendered_width = 0; return; }
    if (!this.requested) { this.requested = true; this.refresh(); }
    else if (this.pending_url && this.pending_url !== this.loaded_url && !this.loading) void this.load(this.pending_url);
    else if (this.pdf && this.viewport.clientWidth !== this.rendered_width) void this.render();
  }

  focus(): void { this.viewport.focus(); }

  /** The floating outline covers the document's edge without resizing it, so pages never re-render. */
  private set_outline(open: boolean): void {
    this.outline_open = open;
    this.outline.set_open(open);
    this.update_controls();
  }

  /** The reading area below the floating toolbar; scroll offsets already start beneath it. */
  private visible_height(): number {
    return Math.max(1, this.viewport.clientHeight - this.overlay.space);
  }
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
        ...pdf_document_options(url),
      });
      this.loading = task;
      const pdf = await task.promise;
      if (this.disposed || revision !== this.load_revision) return;
      this.cancel_render();
      const previous_task = this.document_task;
      this.pdf = pdf;
      this.sizes = [];
      this.geometry = undefined;
      this.outline.set_document(pdf);
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
      void this.measure_pages(pdf, revision);
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
    if (!reveal_match) this.scroll_to_match = false;
    if (this.mode !== 'continuous') { void this.render(false); return; }
    const box = this.geometry?.boxes.get(this.page - 1);
    if (box) this.viewport.scrollTop = box.top + (position === 'bottom' ? Math.max(0, box.height - this.visible_height() + 24) : 0);
    void this.render_visible();
    this.highlight_match();
  }

  private update_controls(): void {
    this.pane.dataset.pdfMode = this.mode;
    this.pane.dataset.pdfDark = String(this.dark);
    this.toolbar.update({ page: this.page, pages: this.pdf?.numPages ?? 0, zoom: this.zoom,
      mode: this.mode, dark: this.dark, outline_open: this.outline_open });
  }

  private remember(): void {
    this.send({ type: 'pdf_position', id: this.tab.id,
      position: { page: this.page, zoom: this.zoom, mode: this.mode, dark: this.dark } });
  }

  private move(direction: -1 | 1): void {
    if (!this.pdf) return;
    if (this.mode === 'continuous') this.viewport.scrollBy({ top: direction * this.visible_height() });
    else this.navigate(adjacent_page(this.page, this.pdf.numPages, this.mode, direction));
  }

  private change_zoom(direction: -1 | 0 | 1): void {
    const current = typeof this.zoom === 'number' ? this.zoom : this.geometry?.boxes.get(this.page - 1)?.scale ?? 1;
    this.set_zoom(direction === 0 ? 1 : Math.round(current * (direction > 0 ? 1.2 : 1 / 1.2) * 100) / 100);
  }

  private set_zoom(zoom: pdf_zoom, deferred = false): void {
    if (typeof zoom === 'number') {
      if (!Number.isFinite(zoom)) return;
      zoom = Math.max(0.25, Math.min(4, zoom));
    }
    if (this.zoom === zoom) return;
    this.zoom = zoom;
    this.update_controls();
    clearTimeout(this.zoom_timer);
    const commit = () => { if (!this.disposed) { this.remember(); void this.render(); } };
    if (deferred) this.zoom_timer = setTimeout(commit, 80);
    else commit();
  }

  private wheel(event: WheelEvent): void {
    if ((!event.metaKey && !event.ctrlKey) || event.altKey || !this.pdf || !Number.isFinite(event.deltaY)) return;
    event.preventDefault();
    event.stopPropagation();
    const current = typeof this.zoom === 'number' ? this.zoom : this.geometry?.boxes.get(this.page - 1)?.scale ?? 1;
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.viewport.clientHeight : 1);
    this.set_zoom(Math.round(current * Math.exp(-Math.max(-500, Math.min(500, delta)) * 0.002) * 1000) / 1000, true);
  }

  private release_page(index: number): void {
    const rendered = this.rendered.get(index);
    if (!rendered) return;
    this.rendered.delete(index);
    rendered.task?.cancel();
    rendered.layer?.cancel();
    if (rendered.canvas) { rendered.canvas.width = 0; rendered.canvas.height = 0; }
    rendered.element.remove();
  }

  private cancel_render(): void {
    ++this.render_revision;
    for (const index of this.rendered.keys()) this.release_page(index);
  }

  /** Resolve page sizes without retaining decoded images or allocating offscreen canvases. */
  private async measure_pages(pdf: PDFDocumentProxy, revision: number): Promise<void> {
    let changed = false;
    for (let index = 0; index < pdf.numPages; index++) {
      if (this.disposed || this.pdf !== pdf || revision !== this.load_revision) return;
      try {
        const page = await pdf.getPage(index + 1);
        if (this.disposed || this.pdf !== pdf || revision !== this.load_revision) return;
        const size = page.getViewport({ scale: 1 });
        const old = this.sizes[index];
        if (!old || old.width !== size.width || old.height !== size.height) {
          this.sizes[index] = { width: size.width, height: size.height };
          changed = true;
        }
        page.cleanup();
        if (changed && (index % 32 === 31 || index === pdf.numPages - 1)) {
          changed = false;
          await this.render(true);
        }
      } catch { /* Keep the estimated size; the page renderer offers Reload on failure. */ }
    }
  }

  private async render(preserve_scroll = true): Promise<void> {
    if (!this.pdf || this.disposed || this.pane.hidden || this.viewport.clientWidth < 1) return;
    const pdf = this.pdf;
    const old = this.geometry?.boxes.get(this.page - 1);
    const fraction = preserve_scroll && old ? (this.viewport.scrollTop - old.top) / old.height : 0;
    this.cancel_render();
    const revision = this.render_revision;
    if (this.sizes.length !== pdf.numPages || this.sizes.filter(Boolean).length !== pdf.numPages) {
      let page: PDFPageProxy;
      try { page = await pdf.getPage(this.page); }
      catch {
        if (!this.disposed && revision === this.render_revision) this.error('This page could not be loaded. Try another page or reload the PDF.');
        return;
      }
      if (revision !== this.render_revision || this.disposed) return;
      const size = page.getViewport({ scale: 1 });
      this.sizes = Array.from({ length: pdf.numPages }, (_, index) => this.sizes[index] ?? ({ width: size.width, height: size.height }));
      page.cleanup();
    }
    this.geometry = layout_document(this.sizes, this.viewport.clientWidth, this.visible_height(),
      this.zoom, this.mode, this.page);
    this.pages.style.height = `${this.geometry.height}px`;
    this.pages.style.width = `${this.geometry.width}px`;
    const box = this.geometry.boxes.get(this.page - 1)!;
    this.viewport.scrollTop = Math.max(0, box.top + fraction * box.height);
    this.rendered_width = this.viewport.clientWidth;
    await this.render_visible();
  }

  private async render_visible(): Promise<void> {
    if (!this.pdf || this.disposed || this.pane.hidden || !this.geometry) return;
    const visible = this.geometry.continuous
      ? visible_pages(this.geometry.continuous, this.viewport.scrollTop - this.overlay.space, this.viewport.clientHeight)
      : [...this.geometry.boxes.keys()];
    this.canvas_pixel_budget = Math.min(4_000_000, 16_000_000 / visible.length);
    for (const index of this.rendered.keys()) if (!visible.includes(index)) this.release_page(index);
    this.pane.dataset.pdfPage = String(this.page);
    this.pane.dataset.pdfPages = String(this.pdf.numPages);
    await Promise.all(visible.map(index => this.render_page(index)));
  }

  private async render_page(index: number): Promise<void> {
    if (this.rendered.has(index) || !this.pdf) return;
    const pdf = this.pdf;
    const box = this.geometry?.boxes.get(index);
    if (!box) return;
    const rendered = document.createElement('div');
    rendered.className = 'pdf-page';
    rendered.style.top = `${box.top}px`;
    rendered.style.left = `${box.left ?? 0}px`;
    rendered.style.width = `${box.width}px`;
    rendered.style.height = `${box.height}px`;
    rendered.style.setProperty('--total-scale-factor', String(box.scale));
    rendered.style.setProperty('--scale-round-x', '1px');
    rendered.style.setProperty('--scale-round-y', '1px');
    const entry: rendered_page = { element: rendered };
    this.rendered.set(index, entry);
    this.pages.append(rendered);
    const current = () => !this.disposed && this.rendered.get(index) === entry && this.pdf === pdf;
    let page: PDFPageProxy | undefined;
    try {
      page = await pdf.getPage(index + 1);
      if (!current()) return;
      const viewport = page.getViewport({ scale: box.scale });
      // Share the pixel budget across visible pages; short pages must never be omitted.
      const pixels = Math.min(window.devicePixelRatio || 1, 2, 16_384 / viewport.width,
        16_384 / viewport.height, Math.sqrt(this.canvas_pixel_budget / (viewport.width * viewport.height)));
      const canvas = entry.canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width * pixels));
      canvas.height = Math.max(1, Math.floor(viewport.height * pixels));
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      rendered.append(canvas);
      entry.task = page.render({ canvas, viewport, transform: [pixels, 0, 0, pixels, 0, 0] });
      await entry.task.promise;
      if (!current()) return;
      const module = await this.renderer();
      if (!current()) return;
      const text = document.createElement('div');
      text.className = 'textLayer';
      rendered.append(text);
      const content = await page.getTextContent();
      if (!current()) return;
      entry.layer = new module.TextLayer({ textContentSource: content, container: text, viewport });
      await entry.layer.render().catch(() => undefined);
      if (!current()) return;
      entry.source = page_text(content.items);
      const view = [...page.view];
      rendered.addEventListener('dblclick', event => {
        if (!(event.target instanceof Element) || !event.target.closest('.textLayer span')) return;
        const rectangle = rendered.getBoundingClientRect();
        const [x, y] = viewport.convertToPdfPoint(event.clientX - rectangle.left, event.clientY - rectangle.top);
        this.send({ type: 'pdf_reverse_sync', id: this.tab.id, page: index + 1,
          x: Math.max(0, x - view[0]), y: Math.max(0, view[3] - y) });
      });
      this.notice.hidden = true;
      this.highlight_match();
    } catch (error) {
      if (current() && (error as Error).name !== 'RenderingCancelledException') {
        this.error('This page could not be rendered. Try another page or reload the PDF.');
      }
    } finally {
      if (!current() && entry.canvas) { entry.canvas.width = 0; entry.canvas.height = 0; }
      page?.cleanup();
    }
  }

  reveal_match(match: document_match): boolean {
    if (!this.pdf || this.pane.hidden) return false;
    this.select_match(match, [match], true);
    return true;
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
    for (const [page_index, entry] of this.rendered) {
      const { layer, source: rendered_source, element: rendered } = entry;
      if (!layer || !rendered_source) continue;
      const matches = this.matches.filter(match => match.page === page_index);
      if (!matches.length) continue;
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
  }

  private keydown(event: KeyboardEvent): void {
    if (event.isComposing || event.altKey) return;
    if (event.ctrlKey || event.metaKey) {
      if (!['+', '=', '-', '0'].includes(event.key)) return;
      this.change_zoom(event.key === '0' ? 0 : event.key === '-' ? -1 : 1);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    switch (event.key) {
      case 'Escape': if (!this.outline_open) return; this.set_outline(false); break;
      case 'h': case 'ArrowLeft': this.navigate(adjacent_page(this.page, this.pdf?.numPages ?? 1, this.mode, -1)); break;
      case 'l': case 'ArrowRight': this.navigate(adjacent_page(this.page, this.pdf?.numPages ?? 1, this.mode, 1)); break;
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
    this.toolbar.dispose();
    this.overlay.dispose();
    this.outline.dispose();
    clearTimeout(this.zoom_timer);
    this.observer.disconnect();
    clearTimeout(this.resize_timer);
    this.destroy_task(this.loading);
    this.destroy_task(this.document_task);
    clearTimeout(this.scroll_timer);
    this.pane.remove();
  }
}
