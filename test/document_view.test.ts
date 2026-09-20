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
  const messages: client_message[] = [];
  let find_calls = 0;
  const module = { exports: {} as view_api };
  runInNewContext(await bundled_view, {
    module, exports: module.exports, window: dom.window, document: dom.window.document,
    DOMParser: dom.window.DOMParser, NodeFilter: dom.window.NodeFilter,
    AbortController: dom.window.AbortController, AbortSignal: dom.window.AbortSignal,
    DOMException: dom.window.DOMException, FocusEvent: dom.window.FocusEvent,
    TextEncoder, TextDecoder, URL, Blob, Response, Headers, setTimeout, clearTimeout,
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
  return { dom, view, viewport, complete, workers, messages, finds: () => find_calls,
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
