import assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { setImmediate as next_turn } from 'node:timers/promises';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import type { client_message, document_tab } from '../src/types';
import type { document_format_request } from '../webview/document_format_protocol';

const base_url = 'https://file+.vscode-resource.vscode-cdn.net/work/';
const source = (text: string) => ({ text, base_url });
const bundled_view = build({ entryPoints: [path.join(__dirname, '../webview/document_view.ts')],
  bundle: true, write: false, platform: 'browser', format: 'cjs', loader: { '.css': 'empty' },
}).then(result => result.outputFiles[0].text);
type view_api = typeof import('../webview/document_view');

class worker_fixture {
  onmessage: Worker['onmessage'] = null;
  onerror: Worker['onerror'] = null;
  terminated = false;
  request?: document_format_request;
  postMessage(request: document_format_request): void { this.request = request; }
  terminate(): void { this.terminated = true; }
  reply(text: string): void { this.onmessage?.call(this as unknown as Worker, { data: { text } } as MessageEvent); }
}

async function fixture(format: document_tab['format'] = 'html', fetcher: typeof fetch = async () => new Response('')) {
  const dom = new JSDOM('<!doctype html><head><meta name="pdf-assets" content="https://assets.local/dist/pdfjs"></head><body></body>', { url: base_url });
  const documents: JSDOM[] = [];
  const workers: worker_fixture[] = [];
  const blobs = new Map<string, Blob>();
  const revoked: string[] = [];
  const messages: client_message[] = [];
  let find_calls = 0;
  const module = { exports: {} as view_api };
  runInNewContext(await bundled_view, {
    module, exports: module.exports, window: dom.window, document: dom.window.document,
    DOMParser: dom.window.DOMParser, NodeFilter: dom.window.NodeFilter,
    AbortController: dom.window.AbortController, AbortSignal: dom.window.AbortSignal,
    DOMException: dom.window.DOMException, FocusEvent: dom.window.FocusEvent,
    TextEncoder, TextDecoder, URL: class extends URL {
      static createObjectURL(blob: Blob): string {
        const url = `blob:preview-${blobs.size + 1}`;
        blobs.set(url, blob); return url;
      }
      static revokeObjectURL(url: string): void { revoked.push(url); }
    }, Blob, Response, Headers, setTimeout, clearTimeout,
    btoa: dom.window.btoa.bind(dom.window), fetch: fetcher,
    Worker: class extends worker_fixture { constructor() { super(); workers.push(this); } },
  });
  const tab: document_tab = { kind: 'document', format, id: 'document_test', name: 'Preview',
    uri: `file:///work/test.${format}`, scroll: 0 };
  const view = new module.exports.document_view(tab, message => messages.push(message), () => { find_calls++; });
  dom.window.document.body.append(view.pane);
  const viewport = view.pane.querySelector<HTMLElement>('.document-viewport')!;

  // JSDOM does not implement srcdoc loading. Keep the real attached iframe and
  // supply the document a browser would load, then dispatch its native load event.
  const complete = (frame: HTMLIFrameElement) => {
    const inner = new JSDOM(frame.srcdoc, { url: 'about:srcdoc' });
    documents.push(inner);
    const scroll = (first: number | ScrollToOptions, second?: number) => {
      const top = typeof first === 'number' ? second ?? 0 : first.top ?? 0;
      Object.defineProperty(inner.window, 'scrollY', { value: top, configurable: true });
    };
    inner.window.scrollTo = scroll as Window['scrollTo'];
    inner.window.scrollBy = scroll as Window['scrollBy'];
    Object.defineProperties(frame, {
      contentDocument: { get: () => inner.window.document, configurable: true },
      contentWindow: { get: () => inner.window, configurable: true },
    });
    frame.dispatchEvent(new dom.window.Event('load'));
    return inner;
  };
  const complete_svg = (image: HTMLImageElement, width = 800, height = 400) => {
    Object.defineProperties(image, { naturalWidth: { value: width }, naturalHeight: { value: height } });
    image.dispatchEvent(new dom.window.Event('load'));
  };
  return { dom, view, viewport, complete, complete_svg, workers, blobs, revoked, messages, finds: () => find_calls,
    close() { view.dispose(); for (const document of documents) document.window.close(); dom.window.close(); },
  };
}

test('HTML completion keeps its iframe attached and Find listeners alive across reloads', async () => {
  const h = await fixture();
  try {
    const first_load = h.view.load(source('<h1>First</h1>'));
    await next_turn();
    const first = h.viewport.querySelector('iframe')!;
    h.complete(first);
    await first_load;
    const changes: MutationRecord[] = [];
    const observer = new h.dom.window.MutationObserver(records => changes.push(...records));
    observer.observe(h.viewport, { childList: true });
    const second_load = h.view.load(source('<h1>Second</h1>'));
    await next_turn();
    const second = [...h.viewport.querySelectorAll('iframe')].find(frame => frame !== first)!;
    const inner = h.complete(second);
    await second_load;
    await next_turn();
    changes.push(...observer.takeRecords());
    observer.disconnect();
    assert.equal(second.isConnected, true);
    assert.equal(second.hidden, false);
    assert.equal(first.isConnected, false);
    assert.equal(changes.flatMap(change => [...change.addedNodes]).filter(node => node === second).length, 1);
    assert.equal(changes.flatMap(change => [...change.removedNodes]).includes(second), false,
      'A loaded iframe must not be removed and reinserted, which would reload its document');
    const find = new inner.window.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true });
    inner.window.document.dispatchEvent(find);
    assert.equal(find.defaultPrevented, true);
    assert.equal(h.finds(), 1);
  } finally { h.close(); }
});

test('hiding an HTML preview cancels its pending document and retries the latest source when shown', async () => {
  const h = await fixture();
  try {
    const loading = h.view.load(source('<h1>Pending</h1>'));
    await next_turn();
    const pending = h.viewport.querySelector('iframe')!;
    h.view.set_visible(false);
    await loading;
    assert.equal(pending.isConnected, false);
    h.complete(pending);
    await h.view.load(source('<h1>Latest hidden source</h1>'));
    assert.equal(h.viewport.querySelector('iframe'), null);
    h.view.set_visible(true);
    await next_turn();
    const restored = h.viewport.querySelector('iframe')!;
    assert.notEqual(restored, pending);
    assert.match(restored.srcdoc, /Latest hidden source/);
    h.complete(restored);
    await next_turn();
    assert.equal(restored.hidden, false);
    assert.equal(h.viewport.querySelectorAll('iframe').length, 1);
  } finally { h.close(); }
});

test('a stale HTML load cannot replace the latest document', async () => {
  const h = await fixture();
  try {
    const first_load = h.view.load(source('<h1>Old</h1>'));
    await next_turn();
    const first = h.viewport.querySelector('iframe')!;
    const second_load = h.view.load(source('<h1>New</h1>'));
    await next_turn();
    const second = h.viewport.querySelector('iframe')!;
    assert.notEqual(first, second);
    await first_load;
    h.complete(second);
    await second_load;
    h.complete(first);
    await next_turn();
    assert.equal(first.isConnected, false);
    assert.equal(h.viewport.querySelector('iframe'), second);
    assert.equal(second.contentDocument!.querySelector('h1')!.textContent, 'New');
    assert.equal(second.hidden, false);
  } finally { h.close(); }
});

test('hiding while HTML resources load aborts the fetch and cannot attach an obsolete frame', async () => {
  const requests: Array<{ url: string; signal?: AbortSignal | null }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), signal: init?.signal });
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  };
  const h = await fixture('html', fetcher);
  try {
    const loading = h.view.load(source('<link rel="stylesheet" href="theme.css"><h1>Waiting for resources</h1>'));
    await next_turn();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, `${base_url}theme.css`);
    assert.equal(h.viewport.querySelector('iframe'), null);
    for (let update = 0; update < 3; update++) h.view.set_visible(true);
    await next_turn();
    assert.equal(requests.length, 1, 'Repeated visible state updates reuse the current resource load');
    assert.equal(requests[0].signal?.aborted, false);
    h.view.set_visible(false);
    await loading;
    assert.equal(requests[0].signal?.aborted, true);
    assert.equal(h.viewport.querySelector('iframe'), null);
    await h.view.load(source('<h1>Latest source without resources</h1>'));
    h.view.set_visible(true);
    await next_turn();
    const frame = h.viewport.querySelector('iframe')!;
    assert.match(frame.srcdoc, /Latest source without resources/);
    h.complete(frame);
    await next_turn();
    assert.equal(frame.hidden, false);
  } finally { h.close(); }
});

test('disposing a pending HTML preview settles loading and ignores late load events', async () => {
  const h = await fixture();
  try {
    const loading = h.view.load(source('<h1>Pending</h1>'));
    await next_turn();
    const frame = h.viewport.querySelector('iframe')!;
    h.view.dispose();
    await loading;
    assert.equal(h.view.pane.isConnected, false);
    assert.equal(frame.isConnected, false);
    h.complete(frame);
    await h.view.load(source('<h1>Too late</h1>'));
    h.view.refresh();
    assert.equal(h.viewport.querySelector('iframe'), null);
    assert.equal(h.messages.length, 0);
  } finally { h.close(); }
});

test('formatted source applies only the latest save and does not inject source as markup', async () => {
  const h = await fixture('json');
  try {
    const first = h.view.load(source('{"old":1}'));
    await next_turn();
    assert.equal(h.workers[0].request?.text, '{"old":1}');
    for (let update = 0; update < 3; update++) h.view.set_visible(true);
    await next_turn();
    assert.equal(h.workers.length, 1, 'Repeated visible state updates reuse the current formatting worker');
    assert.equal(h.workers[0].terminated, false);
    const second = h.view.load(source('{"new":"<script>text</script>"}'));
    await next_turn();
    assert.equal(h.workers[0].terminated, true);
    h.workers[0].reply('obsolete');
    h.workers[1].reply('{\n  "new": "<script>text</script>"\n}');
    await Promise.all([first, second]);
    assert.equal(h.viewport.querySelector('code')!.textContent, '{\n  "new": "<script>text</script>"\n}');
    assert.equal(h.viewport.querySelector('script'), null);
  } finally { h.close(); }
});

test('hidden or disposed source previews cannot apply outstanding formatting results', async () => {
  const h = await fixture('css');
  try {
    const hidden = h.view.load(source('body{color:red}'));
    await next_turn();
    h.view.set_visible(false);
    h.workers[0].reply('body { color: red; }');
    await hidden;
    assert.equal(h.viewport.querySelector('code'), null);
    h.view.set_visible(true);
    await next_turn();
    const pending = h.workers[1];
    assert.equal(pending.request?.text, 'body{color:red}');
    h.view.dispose();
    pending.reply('too late');
    await next_turn();
    assert.equal(pending.terminated, true);
    assert.equal(h.viewport.querySelector('code'), null);
  } finally { h.close(); }
});

test('HTML reader zoom and page scrolling operate inside the iframe and survive a refresh', async () => {
  const h = await fixture();
  try {
    const loading = h.view.load(source('<h1>Chapter</h1>'));
    await next_turn();
    const frame = h.viewport.querySelector('iframe')!;
    Object.defineProperty(frame, 'clientHeight', { value: 600 });
    const inner = h.complete(frame);
    await loading;
    const scrolls: number[] = [];
    inner.window.scrollBy = ((options: ScrollToOptions) => scrolls.push(options.top ?? 0)) as Window['scrollBy'];
    h.view.pane.querySelector<HTMLButtonElement>('[title="Scroll down one page"]')!.click();
    assert.deepEqual(scrolls, [600]);
    h.view.pane.querySelector<HTMLButtonElement>('[title="Zoom in"]')!.click();
    assert.equal(inner.window.document.documentElement.style.zoom, '1.2');
    const reset = new inner.window.KeyboardEvent('keydown', { key: '0', metaKey: true, bubbles: true, cancelable: true });
    inner.window.document.dispatchEvent(reset);
    assert.equal(reset.defaultPrevented, true);
    assert.equal(inner.window.document.documentElement.style.zoom, '1');
    h.view.pane.querySelector<HTMLButtonElement>('[title="Zoom in"]')!.click();
    const reloading = h.view.load(source('<h2>Updated chapter</h2>'));
    await next_turn();
    const replacement = [...h.viewport.querySelectorAll('iframe')].find(value => value !== frame)!;
    const updated = h.complete(replacement);
    await reloading;
    assert.equal(updated.window.document.documentElement.style.zoom, '1.2');
    assert.equal(h.view.pane.querySelector('.reading-outline')?.textContent, 'Updated chapter');
  } finally { h.close(); }
});

test('formatted source zoom scales its text without scaling the toolbar', async () => {
  const h = await fixture('css');
  try {
    const loading = h.view.load(source('body{color:red}'));
    await next_turn();
    h.workers[0].reply('body {\n  color: red;\n}');
    await loading;
    h.view.pane.querySelector<HTMLButtonElement>('[title="Zoom in"]')!.click();
    assert.equal(h.viewport.querySelector('pre')?.style.zoom, '1.2');
    assert.equal(h.view.pane.querySelector<HTMLElement>('.preview-toolbar')!.style.zoom, '');
    assert.equal(h.view.pane.querySelector('[title="Toggle document outline"]'), null);
  } finally { h.close(); }
});

test('HTML links scroll to ids, named anchors and the top, and send only external or relative links to the host', async () => {
  const h = await fixture();
  try {
    const loading = h.view.load(source(`<p><a id="to-id" href="#far">Far</a> <a id="to-name" href="#legacy%20anchor">Legacy</a>
      <a id="to-top" href="#top">Top</a> <a id="to-nowhere" href="#nowhere">Nowhere</a>
      <a id="to-web" href="https://example.com/paper">Paper</a> <a id="to-file" href="chapter.html#intro">Chapter</a></p>
      <h2 id="far">Far heading</h2><a name="legacy anchor"></a>`));
    await next_turn();
    const inner = h.complete(h.viewport.querySelector('iframe')!);
    await loading;
    const scrolled: string[] = [];
    inner.window.HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.id || this.getAttribute('name') || this.tagName);
    };
    Object.defineProperty(inner.window, 'scrollY', { value: 500, configurable: true });
    const click = (id: string) => {
      const event = new inner.window.MouseEvent('click', { bubbles: true, cancelable: true });
      inner.window.document.getElementById(id)!.dispatchEvent(event);
      return event.defaultPrevented;
    };
    for (const id of ['to-id', 'to-name', 'to-nowhere', 'to-top', 'to-web', 'to-file']) {
      assert.equal(click(id), true, `${id} never navigates the preview frame`);
    }
    assert.deepEqual(scrolled, ['far', 'legacy anchor']);
    assert.equal(inner.window.scrollY, 0, '#top returns to the beginning');
    assert.deepEqual(h.messages.filter(message => message.type === 'open_document_link')
      .map(message => (message as { href: string }).href), ['https://example.com/paper', 'chapter.html#intro'],
    'A missing fragment is ignored rather than opening the source file');
  } finally { h.close(); }
});

const vector = (label: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400" viewBox="0 0 800 400"><text>${label}</text></svg>`;

test('SVG uses an image context with original vector content, fits initially and keeps zoom when refreshed', async () => {
  const h = await fixture('svg');
  try {
    Object.defineProperties(h.viewport, { clientWidth: { value: 424 }, clientHeight: { value: 424 } });
    const original = vector('Vector text');
    const loading = h.view.load(source(original));
    const image = h.viewport.querySelector('img')!;
    const url = image.src;
    assert.equal(await h.blobs.get(url)!.text(), original);
    assert.equal(h.blobs.get(url)!.type, 'image/svg+xml;charset=utf-8');
    assert.equal(h.viewport.querySelector('svg, iframe, object, code'), null);
    assert.equal(h.workers.length, 0);
    h.complete_svg(image);
    await loading;
    assert.equal(image.hidden, false);
    assert.equal(image.style.width, '400px');
    assert.equal(image.style.height, '200px');
    assert.equal(h.view.pane.querySelector<HTMLSelectElement>('[aria-label="Zoom"]')!.value, '0.5');
    h.view.pane.querySelector<HTMLButtonElement>('[title="Actual size (100%)"]')!.click();
    assert.equal(image.style.width, '800px');
    const reload = h.view.load(source(vector('Updated')));
    const replacement = [...h.viewport.querySelectorAll('img')].find(value => value !== image)!;
    h.complete_svg(replacement);
    await reload;
    assert.equal(replacement.style.width, '800px');
    assert.equal(h.revoked.includes(url), true);
    h.view.pane.querySelector<HTMLButtonElement>('[title="Fit image"]')!.click();
    assert.equal(replacement.style.width, '400px');
    h.view.dispose();
    assert.deepEqual(h.revoked, [...h.blobs.keys()]);
  } finally { h.close(); }
});

test('SVG parse and image-load failures retain the last good preview', async () => {
  const h = await fixture('svg');
  try {
    const loading = h.view.load(source(vector('Good')));
    const good = h.viewport.querySelector('img')!;
    h.complete_svg(good);
    await loading;
    await h.view.load(source('<svg xmlns="http://www.w3.org/2000/svg"><broken></svg>'));
    assert.equal(h.viewport.querySelector('img'), good);
    assert.equal(h.blobs.size, 1);
    assert.match(h.view.pane.querySelector('.document-notice')!.textContent!, /could not be parsed/);
    const failing = h.view.load(source(vector('Broken image')));
    const broken = [...h.viewport.querySelectorAll('img')].find(value => value !== good)!;
    const broken_url = broken.src;
    broken.dispatchEvent(new h.dom.window.Event('error'));
    await failing;
    assert.equal(h.viewport.querySelector('img'), good);
    assert.equal(h.revoked.includes(broken_url), true);
    assert.equal(h.revoked.includes(good.src), false);
    assert.match(h.view.pane.querySelector('.document-notice')!.textContent!, /could not be rendered/);
  } finally { h.close(); }
});

test('SVG loads are cancelled on replacement, hiding and disposal without stale image or Blob leaks', async () => {
  const h = await fixture('svg');
  try {
    const first_load = h.view.load(source(vector('Stale')));
    const first = h.viewport.querySelector('img')!;
    const next_load = h.view.load(source(vector('Current')));
    const current = h.viewport.querySelector('img')!;
    assert.notEqual(first, current);
    await first_load;
    h.complete_svg(first);
    assert.equal(first.isConnected, false);
    h.view.set_visible(false);
    await next_load;
    assert.equal(current.isConnected, false);
    await h.view.load(source(vector('Latest hidden save')));
    assert.equal(h.viewport.querySelector('img'), null);
    h.view.set_visible(true);
    const latest = h.viewport.querySelector('img')!;
    assert.match(await h.blobs.get(latest.src)!.text(), /Latest hidden save/);
    h.complete_svg(latest);
    await next_turn();
    assert.equal(latest.hidden, false);
    const disposed = h.view.load(source(vector('Disposed')));
    h.view.dispose();
    await disposed;
    assert.equal(h.view.pane.isConnected, false);
    assert.equal(new Set(h.revoked).size, h.blobs.size);
    assert.equal(h.revoked.length, h.blobs.size, 'Every URL is revoked exactly once');
  } finally { h.close(); }
});

test('SVG arrows, page keys and Shift-wheel pan the image and Ctrl-F does not search XML', async () => {
  const h = await fixture('svg');
  try {
    const moves: ScrollToOptions[] = [];
    h.viewport.scrollBy = ((options: ScrollToOptions) => { moves.push(options); }) as HTMLElement['scrollBy'];
    Object.defineProperties(h.viewport, { clientWidth: { value: 400 }, clientHeight: { value: 300 } });
    const loading = h.view.load(source(vector('Visible image text')));
    h.complete_svg(h.viewport.querySelector('img')!);
    await loading;
    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown']) {
      const event = new h.dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      h.viewport.dispatchEvent(event);
      assert.equal(event.defaultPrevented, true);
    }
    for (const init of [{ deltaY: 50 }, { deltaY: 60, shiftKey: true }, { deltaX: 70, shiftKey: true },
      { deltaY: 1, shiftKey: true, deltaMode: 2 }]) {
      const event = new h.dom.window.WheelEvent('wheel', { ...init, cancelable: true });
      h.viewport.dispatchEvent(event);
      assert.equal(event.defaultPrevented, true);
    }
    assert.deepEqual(moves.map(value => ({ top: value.top ?? 0, left: value.left ?? 0 })), [
      { top: -48, left: 0 }, { top: 48, left: 0 }, { top: 0, left: -48 }, { top: 0, left: 48 },
      { top: -300, left: 0 }, { top: 300, left: 0 }, { top: 50, left: 0 },
      { top: 0, left: 60 }, { top: 0, left: 70 }, { top: 0, left: 400 },
    ]);
    h.viewport.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }));
    assert.equal(h.finds(), 0);
  } finally { h.close(); }
});
