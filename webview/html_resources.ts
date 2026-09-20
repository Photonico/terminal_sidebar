import create_purifier from 'dompurify';
import parse from 'css-tree/parser';
import generate from 'css-tree/generator';
import walk from 'css-tree/walker';
import type { CssNode, List, ListItem } from 'css-tree';
import type { markdown_source } from '../src/markdown_state';
import { local_document_resource } from './document_resources';
import { prepare_html } from './html_preview';

export interface html_resource_limits {
  max_bytes: number;
  max_resources: number;
  max_depth: number;
  timeout_ms: number;
}

const default_limits: html_resource_limits = { max_bytes: 8 * 1024 * 1024, max_resources: 64, max_depth: 4, timeout_ms: 8000 };
const max_css_bytes = 512 * 1024;
const max_output_chars = 16 * 1024 * 1024;
const mime_by_extension: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  svg: 'image/svg+xml', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
};
const allowed_mimes = new Set(Object.values(mime_by_extension));

export interface html_resource_options {
  signal?: AbortSignal;
  fetch?: typeof fetch;
  /** Callers may lower these bounds, but cannot expand the reader's resource budget. */
  limits?: Partial<html_resource_limits>;
}

interface resource { bytes: Uint8Array; mime: string }

/** Parent-webview fetches retain VS Code's public resource routing; srcdoc never fetches local files. */
export async function hydrate_html_resources(source: markdown_source, options: html_resource_options = {}): Promise<{ html: string; warnings: string[] }> {
  const loader = new resource_loader(source, options);
  try { return await loader.render(); } finally { loader.dispose(); }
}

class resource_loader {
  private readonly abort = new AbortController();
  private readonly limits: html_resource_limits;
  private readonly request: typeof fetch;
  private readonly root: URL;
  private readonly warnings = new Set<string>();
  private readonly fetched = new Map<string, Promise<resource | undefined>>();
  private readonly rendered = new Map<string, Promise<string | undefined>>();
  private readonly timeout: ReturnType<typeof setTimeout>;
  private readonly cancel = () => this.abort.abort();
  private bytes = 0;
  private output_chars = 0;

  constructor(private readonly source: markdown_source, private readonly options: html_resource_options) {
    this.root = new URL(source.base_url);
    this.request = options.fetch ?? ((...args) => fetch(...args));
    this.limits = { ...default_limits };
    for (const key of Object.keys(default_limits) as Array<keyof html_resource_limits>) {
      const value = options.limits?.[key];
      if (value !== undefined && Number.isFinite(value)) this.limits[key] = Math.max(1, Math.min(default_limits[key], Math.trunc(value)));
    }
    options.signal?.addEventListener('abort', this.cancel, { once: true });
    if (options.signal?.aborted) this.cancel();
    this.timeout = setTimeout(() => { this.warnings.add('Some local assets exceeded the loading time limit.'); this.cancel(); }, this.limits.timeout_ms);
  }

  dispose(): void {
    clearTimeout(this.timeout);
    this.options.signal?.removeEventListener('abort', this.cancel);
    this.abort.abort();
  }

  private check_cancelled(): void { this.options.signal?.throwIfAborted(); }

  async render(): Promise<{ html: string; warnings: string[] }> {
    this.check_cancelled();
    const document = new DOMParser().parseFromString(prepare_html(this.source), 'text/html');
    // prepare_html prepends this trusted, resource-free CSS before document styles.
    const search_style = document.head.querySelector('style');
    for (const stylesheet of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet" i]')) {
      const value = await this.asset(stylesheet.getAttribute('href') ?? '', this.root.href, true, 0, new Set());
      if (value) stylesheet.setAttribute('href', value); else stylesheet.remove();
    }
    for (const style of document.querySelectorAll('style')) {
      if (style !== search_style) style.textContent = await this.css(style.textContent ?? '', this.root.href, 0, new Set());
    }
    for (const element of document.querySelectorAll('[style]')) {
      element.setAttribute('style', await this.css(element.getAttribute('style') ?? '', this.root.href, 0, new Set(), true));
    }
    for (const element of document.querySelectorAll('[src], [poster], [background], image[href]')) {
      for (const attribute of ['src', 'poster', 'background', ...(element.localName === 'image' ? ['href'] : [])]) {
        const reference = element.getAttribute(attribute);
        if (!reference) continue;
        const value = await this.asset(reference, this.root.href, false, 0, new Set());
        if (value) element.setAttribute(attribute, value); else element.removeAttribute(attribute);
      }
    }
    this.check_cancelled();
    document.querySelector('base')?.remove();
    const policy = document.querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy"]')!;
    policy.content = "default-src 'none'; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; img-src data:; font-src data:; media-src data:; style-src data: 'unsafe-inline';";
    const html = '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
    if (html.length > max_output_chars + this.source.text.length) throw new Error('HTML preview exceeds its rendered resource budget.');
    return { html, warnings: [...this.warnings] };
  }

  private resolve(value: string, relative_to: string): URL | undefined {
    if (!value || /[\x00-\x20\x7f\\]/.test(value) || value.startsWith('//')) return undefined;
    try {
      const url = new URL(value, relative_to);
      if (url.origin !== this.root.origin || !url.pathname.startsWith(this.root.pathname) || url.username || url.password || url.search) return undefined;
      const checked = local_document_resource(url.pathname.slice(this.root.pathname.length) + url.hash, this.root.href);
      return checked ? new URL(checked) : undefined;
    } catch { return undefined; }
  }

  private async asset(value: string, relative_to: string, stylesheet: boolean, depth: number, ancestors: ReadonlySet<string>): Promise<string | undefined> {
    this.check_cancelled();
    const url = this.resolve(value, relative_to);
    if (!url) { if (value) this.warnings.add('External or unsafe asset references were blocked.'); return undefined; }
    const fragment = url.hash;
    url.hash = '';
    const key = url.href;
    if (ancestors.has(key) || depth > this.limits.max_depth) { this.warnings.add('Nested or circular stylesheet imports were limited.'); return undefined; }
    const rendered_key = `${stylesheet ? 'css' : 'asset'}:${key}`;
    let pending = this.rendered.get(rendered_key);
    if (!pending) {
      pending = this.encode_asset(key, stylesheet, depth, new Set([...ancestors, key]));
      this.rendered.set(rendered_key, pending);
    }
    const data = await pending;
    this.check_cancelled();
    if (!data) return undefined;
    if (this.output_chars + data.length > max_output_chars) { this.warnings.add('Some assets exceeded the rendered size limit.'); return undefined; }
    this.output_chars += data.length;
    return data + fragment;
  }

  private async encode_asset(url: string, stylesheet: boolean, depth: number, ancestors: ReadonlySet<string>): Promise<string | undefined> {
    const asset = await this.read(url);
    if (!asset) return undefined;
    let bytes = asset.bytes;
    let mime = asset.mime;
    if (stylesheet) {
      if (bytes.length > max_css_bytes) { this.warnings.add('An oversized stylesheet was omitted.'); return undefined; }
      bytes = new TextEncoder().encode(await this.css(new TextDecoder().decode(bytes), url, depth, ancestors));
      mime = 'text/css';
    } else if (!allowed_mimes.has(mime)) { this.warnings.add('An unsupported local asset type was omitted.'); return undefined; }
    else if (mime === 'image/svg+xml') {
      const purifier = create_purifier(window);
      const safe = purifier.sanitize(new TextDecoder().decode(bytes), {
        USE_PROFILES: { svg: true, svgFilters: true },
        FORBID_TAGS: ['script', 'foreignObject', 'style', 'animate', 'animateMotion', 'animateTransform', 'set'],
        FORBID_ATTR: ['style'],
      });
      const svg = new DOMParser().parseFromString(safe, 'image/svg+xml');
      if (svg.querySelector('parsererror') || svg.documentElement.localName !== 'svg') { this.warnings.add('An invalid SVG image was omitted.'); return undefined; }
      for (const element of svg.querySelectorAll('*')) {
        for (const attribute of [...element.attributes]) {
          if ((attribute.localName === 'href' || attribute.localName === 'src') && !attribute.value.startsWith('#')) element.removeAttributeNode(attribute);
        }
      }
      bytes = new TextEncoder().encode(svg.documentElement.outerHTML);
    }
    if (bytes.length * 4 / 3 > max_output_chars) { this.warnings.add('An oversized generated asset was omitted.'); return undefined; }
    const chunks: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += 0x8000) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
    return `data:${mime};base64,${btoa(chunks.join(''))}`;
  }

  private read(url: string): Promise<resource | undefined> {
    const known = this.fetched.get(url);
    if (known) return known;
    if (this.fetched.size >= this.limits.max_resources || this.abort.signal.aborted) {
      this.warnings.add('Some local assets exceeded the loading budget.'); return Promise.resolve(undefined);
    }
    const pending = this.fetch_resource(url);
    this.fetched.set(url, pending);
    return pending;
  }

  private async fetch_resource(url: string): Promise<resource | undefined> {
    try {
      const response = await this.request(url, { signal: this.abort.signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
      if (!response.ok || !response.body) throw new Error('Asset unavailable');
      const length = Number(response.headers.get('content-length'));
      if (Number.isFinite(length) && length > this.limits.max_bytes - this.bytes) {
        await response.body.cancel(); this.warnings.add('Some local assets exceeded the byte limit.'); return undefined;
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          this.check_cancelled();
          const next = await reader.read();
          if (next.done) break;
          this.bytes += next.value.byteLength;
          size += next.value.byteLength;
          if (this.bytes > this.limits.max_bytes) {
            await reader.cancel(); this.warnings.add('Some local assets exceeded the byte limit.'); return undefined;
          }
          chunks.push(next.value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const extension = new URL(url).pathname.split('.').at(-1)?.toLowerCase() ?? '';
      const mime = mime_by_extension[extension] ?? '';
      return { bytes, mime };
    } catch {
      this.check_cancelled();
      this.warnings.add('Some local assets could not be loaded.'); return undefined;
    }
  }

  private async css(text: string, relative_to: string, depth: number, ancestors: ReadonlySet<string>, declarations = false): Promise<string> {
    this.check_cancelled();
    if (this.abort.signal.aborted) return '';
    if (text.length > max_css_bytes) { this.warnings.add('An oversized stylesheet was omitted.'); return ''; }
    let ast: CssNode;
    try { ast = parse(text, { context: declarations ? 'declarationList' : 'stylesheet', parseCustomProperty: true }); }
    catch { this.warnings.add('An invalid stylesheet was omitted.'); return ''; }
    const jobs: Array<() => Promise<void>> = [];
    let visited = 0;
    walk(ast, {
      enter: (node: CssNode, item: ListItem<CssNode>, list: List<CssNode>) => {
        if (++visited > 50_000) return walk.break;
        if (node.type === 'Raw') {
          node.value = '';
          this.warnings.add('Unsupported CSS syntax was omitted.');
          return;
        }
        if (node.type === 'Atrule' && node.name.toLowerCase() === 'import') {
          const reference = node.prelude?.type === 'AtrulePrelude' ? node.prelude.children.first : undefined;
          if (reference?.type === 'Url' || reference?.type === 'String') {
            jobs.push(async () => {
              const data = await this.asset(reference.value, relative_to, true, depth + 1, ancestors);
              if (data) reference.value = data; else if (item && list) list.remove(item);
            });
          } else if (item && list) list.remove(item);
          return walk.skip;
        }
        if (node.type === 'Url' && !node.value.startsWith('#')) {
          jobs.push(async () => { node.value = await this.asset(node.value, relative_to, false, depth, ancestors) ?? ''; });
        }
        if (node.type === 'Function' && /^(?:-webkit-)?image-set$/i.test(node.name)) {
          for (const child of node.children) {
            if (child.type === 'String') jobs.push(async () => { child.value = await this.asset(child.value, relative_to, false, depth, ancestors) ?? ''; });
          }
        }
      },
    });
    if (visited > 50_000) { this.warnings.add('An overly complex stylesheet was omitted.'); return ''; }
    for (const job of jobs) await job();
    return generate(ast);
  }
}
