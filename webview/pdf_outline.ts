import type { PDFDocumentProxy } from 'pdfjs-dist';
import './pdf_outline.css';

type page_reference = number | { num: number; gen: number };
type outline_destination = string | page_reference;
interface outline_entry { title: string; destination?: outline_destination; children: outline_entry[] }

const maximum_nodes = 2000;
const maximum_depth = 12;
const maximum_title_length = 512;

function reference(value: unknown): page_reference | undefined {
  if (Number.isSafeInteger(value) && (value as number) >= 0) return value as number;
  if (!value || typeof value !== 'object') return undefined;
  const { num, gen } = value as Record<string, unknown>;
  return Number.isSafeInteger(num) && (num as number) > 0 && Number.isSafeInteger(gen) && (gen as number) >= 0
    ? { num: num as number, gen: gen as number } : undefined;
}

/** PDF data becomes a bounded, acyclic tree before any DOM is created. */
function outline_tree(source: unknown): { entries: outline_entry[]; truncated: boolean } {
  const visited = new WeakSet<object>();
  let examined = 0;
  let truncated = false;
  const visit = (items: unknown, depth: number): outline_entry[] => {
    if (!Array.isArray(items)) return [];
    if (depth >= maximum_depth) { truncated ||= items.length > 0; return []; }
    const result: outline_entry[] = [];
    for (const item of items) {
      if (examined >= maximum_nodes) { truncated = true; break; }
      examined++;
      if (!item || typeof item !== 'object' || visited.has(item)) continue;
      visited.add(item);
      const title = typeof item.title === 'string'
        ? item.title.slice(0, maximum_title_length).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/gu, ' ').trim() : '';
      const destination = typeof item.dest === 'string' && item.dest.length > 0 && item.dest.length <= 8192
        ? item.dest : Array.isArray(item.dest) ? reference(item.dest[0]) : undefined;
      result.push({ title: title || 'Untitled section', destination, children: visit(item.items, depth + 1) });
    }
    return result;
  };
  const entries = visit(source, 0);
  return { entries, truncated };
}

/** Lazy document contents; navigation reports one-based page numbers to the reader. */
export class pdf_outline {
  readonly root = document.createElement('nav');
  private readonly status = document.createElement('p');
  private readonly list = document.createElement('ul');
  private readonly retry = document.createElement('button');
  private pdf?: PDFDocumentProxy;
  private revision = 0;
  private navigation = 0;
  private loaded = false;
  private loading = false;
  private disposed = false;

  constructor(private readonly navigate: (page: number) => void) {
    this.root.className = 'pdf-outline';
    this.root.hidden = true;
    this.root.setAttribute('aria-label', 'PDF contents');
    const heading = document.createElement('div');
    heading.className = 'pdf-outline-heading';
    heading.textContent = 'Contents';
    this.status.className = 'pdf-outline-status';
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.list.className = 'pdf-outline-list';
    this.retry.className = 'pdf-outline-retry';
    this.retry.type = 'button';
    this.retry.textContent = 'Retry';
    this.retry.title = 'Retry loading document outline';
    this.retry.hidden = true;
    this.retry.addEventListener('click', () => { void this.load(); });
    this.root.append(heading, this.status, this.list, this.retry);
    this.message('Contents will appear when the PDF is ready.');
  }

  set_document(pdf: PDFDocumentProxy): void {
    if (this.disposed) return;
    this.revision++;
    this.navigation++;
    this.pdf = pdf;
    this.loaded = false;
    this.loading = false;
    this.list.replaceChildren();
    this.retry.hidden = true;
    this.root.setAttribute('aria-busy', 'false');
    this.message('Loading contents…');
    if (!this.root.hidden) void this.load();
  }

  set_open(open: boolean): void {
    if (this.disposed) return;
    this.root.hidden = !open;
    if (open) void this.load();
    else this.navigation++;
  }

  private current(revision: number): boolean { return !this.disposed && revision === this.revision; }

  private message(text: string): void {
    this.status.textContent = text;
    this.status.hidden = !text;
  }

  private async load(): Promise<void> {
    const pdf = this.pdf;
    if (this.disposed || this.root.hidden || !pdf || this.loaded || this.loading) return;
    const revision = this.revision;
    this.loading = true;
    this.retry.hidden = true;
    this.root.setAttribute('aria-busy', 'true');
    this.message('Loading contents…');
    try {
      const source: unknown = await pdf.getOutline();
      if (!this.current(revision)) return;
      const { entries, truncated } = outline_tree(source);
      this.list.replaceChildren();
      this.render(entries, this.list, revision, 0);
      this.loaded = true;
      this.message(truncated ? 'Some contents are omitted because this outline is very large.'
        : entries.length ? '' : 'This PDF has no table of contents.');
    } catch {
      if (!this.current(revision)) return;
      this.message('Contents could not be loaded.');
      this.retry.hidden = false;
    } finally {
      if (this.current(revision)) {
        this.loading = false;
        this.root.setAttribute('aria-busy', 'false');
      }
    }
  }

  private render(entries: readonly outline_entry[], parent: HTMLElement, revision: number, depth: number): void {
    for (const entry of entries) {
      const item = document.createElement('li');
      const row = document.createElement('div');
      row.className = 'pdf-outline-row';
      const children = document.createElement('ul');
      children.className = 'pdf-outline-list';
      if (entry.children.length) {
        const toggle = document.createElement('button');
        toggle.className = 'pdf-outline-toggle';
        toggle.type = 'button';
        const expand = (open: boolean) => {
          children.hidden = !open;
          toggle.textContent = open ? '▾' : '▸';
          toggle.setAttribute('aria-expanded', String(open));
          toggle.title = `${open ? 'Collapse' : 'Expand'} ${entry.title}`;
          toggle.setAttribute('aria-label', toggle.title);
        };
        expand(depth === 0);
        toggle.addEventListener('click', () => expand(children.hidden));
        toggle.addEventListener('keydown', event => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          event.stopPropagation();
          expand(event.key === 'ArrowRight');
        });
        row.append(toggle);
      } else {
        const spacer = document.createElement('span');
        spacer.className = 'pdf-outline-spacer';
        row.append(spacer);
      }
      if (entry.destination !== undefined) {
        const button = document.createElement('button');
        button.className = 'pdf-outline-link';
        button.type = 'button';
        button.textContent = entry.title;
        button.title = `Go to ${entry.title}`;
        button.addEventListener('click', () => { void this.open_destination(entry.destination!, revision); });
        row.append(button);
      } else {
        const label = document.createElement('span');
        label.className = 'pdf-outline-label';
        label.textContent = entry.title;
        label.title = entry.title;
        row.append(label);
      }
      item.append(row);
      if (entry.children.length) {
        this.render(entry.children, children, revision, depth + 1);
        item.append(children);
      }
      parent.append(item);
    }
  }

  private async open_destination(destination: outline_destination, revision: number): Promise<void> {
    const pdf = this.pdf;
    if (!pdf || !this.current(revision) || this.root.hidden) return;
    const request = ++this.navigation;
    const current = () => this.current(revision) && request === this.navigation && !this.root.hidden;
    try {
      let target: page_reference | undefined;
      if (typeof destination === 'string') {
        const resolved: unknown = await pdf.getDestination(destination);
        if (!current()) return;
        target = Array.isArray(resolved) ? reference(resolved[0]) : undefined;
      } else target = destination;
      const index = typeof target === 'number' ? target : target ? await pdf.getPageIndex(target) : undefined;
      if (!current()) return;
      if (index === undefined || !Number.isSafeInteger(index) || index < 0 || index >= pdf.numPages) {
        this.message('This section has no valid page destination.');
        return;
      }
      this.message('');
      this.navigate(index + 1);
    } catch {
      if (current()) this.message('This section could not be opened.');
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.revision++;
    this.navigation++;
    this.pdf = undefined;
    this.list.replaceChildren();
    this.root.replaceChildren();
    this.root.remove();
  }
}
