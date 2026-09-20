import assert from 'node:assert/strict';
import * as path from 'node:path';
import { runInNewContext as run_in_new_context } from 'node:vm';
import { setImmediate as next_turn } from 'node:timers/promises';
import test from 'node:test';
import { build } from 'esbuild';
import type { pdf_view } from '../webview/pdf_view';

const bundled_view = build({
  entryPoints: [path.resolve(__dirname, '../webview/pdf_view.ts')], bundle: true,
  write: false, platform: 'browser', format: 'cjs', loader: { '.css': 'empty' },
}).then(result => result.outputFiles[0].text);

function deferred<value>() {
  let resolve!: (value: value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<value>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

class element {
  hidden = false;
  value = '';
  textContent = '';
  width = 0;
  height = 0;
  clientWidth = 640;
  clientHeight = 480;
  scrollTop = 0;
  scrollHeight = 480;
  dataset: Record<string, string> = {};
  children: element[] = [];
  style = { setProperty() {} };
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  constructor(readonly tag: string) {}
  setAttribute() {}
  addEventListener(type: string, listener: (event: unknown) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  dispatch(type: string, event: unknown) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  append(...children: element[]) { this.children.push(...children); }
  add(child: element) { this.append(child); }
  replaceChildren(...children: element[]) { this.children = children; }
  remove() {}
  focus() {}
  closest() { return this.tag === 'span' ? this : undefined; }
  getBoundingClientRect() { return { left: 10, top: 20 }; }
  querySelectorAll(tag: string): element[] {
    return this.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag)]);
  }
  querySelector(tag: string): element | undefined { return this.querySelectorAll(tag)[0]; }
}

async function harness() {
  const module = { exports: {} as { pdf_view: typeof pdf_view } };
  const elements: element[] = [];
  let now = 0;
  run_in_new_context(await bundled_view, {
    module, exports: module.exports, setTimeout, clearTimeout, performance: { now: () => now },
    document: {
      querySelector: () => ({ content: 'https://local.test/pdfjs' }),
      createElement: (tag: string) => { const created = new element(tag); elements.push(created); return created; },
    },
    window: { devicePixelRatio: 2 }, Element: element,
    Option: class extends element { constructor() { super('option'); } },
    ResizeObserver: class { observe() {} disconnect() {} },
  });
  const tasks: Array<ReturnType<typeof deferred<unknown>> & { destroyed: number; options: Record<string, unknown>; destroy(): Promise<void> }> = [];
  let layers = 0;
  const library = {
    getDocument: (options: Record<string, unknown>) => {
      const task = { ...deferred<unknown>(), options, destroyed: 0, async destroy() { this.destroyed++; } };
      tasks.push(task);
      return task;
    },
    TextLayer: class { constructor() { layers++; } async render() {} cancel() {} },
  };
  const messages: unknown[] = [];
  let loader: () => Promise<typeof library> = async () => library;
  const view = new module.exports.pdf_view({
    id: 'document', name: 'Document', pdf_uri: 'file:///document.pdf', page: 1, zoom: 'page-width', kind: 'pdf',
  } as unknown as ConstructorParameters<typeof pdf_view>[0], message => messages.push(message),
  () => loader() as unknown as Promise<typeof import('pdfjs-dist')>);
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({
      width: 600 * scale, height: 800 * scale, scale,
      convertToPdfPoint: (x: number, y: number) => [x / scale + 5, 810 - y / scale],
    }),
    view: [5, 10, 605, 810],
    render: () => ({ promise: Promise.resolve(), cancel() {} }),
    streamTextContent: () => undefined,
    getTextContent: async () => ({ items: [], styles: {} }),
    cleanup() {},
  };
  return {
    view, tasks, messages, elements, library, page, layers: () => layers, set_time: (time: number) => { now = time; },
    set_loader: (next: typeof loader) => { loader = next; },
    document: { numPages: 10, getPage: async () => page },
  };
}

test('a hidden PDF refresh is loaded when the tab is shown again', async () => {
  const h = await harness();
  const first = h.view.load('file-a');
  await next_turn();
  h.tasks[0].resolve(h.document);
  await first;
  assert.equal(h.layers(), 1);
  h.view.set_visible(false);
  await h.view.load('file-b');
  assert.equal(h.tasks.length, 1, 'hidden tabs defer fetching');
  h.view.set_visible(true);
  await next_turn();
  assert.equal(h.tasks[1].options.url, 'file-b');
  assert.equal(h.tasks[1].options.disableAutoFetch, true);
  assert.equal(h.tasks[1].options.disableStream, true);
  assert.equal(h.tasks[1].options.disableRange, false);
  assert.ok(!('data' in h.tasks[1].options), 'PDF bytes are not copied through messages');
  h.tasks[1].resolve(h.document);
  await next_turn();
  assert.equal(h.tasks[0].destroyed, 1);
  assert.equal(h.layers(), 2);
  assert.equal(h.view.pane.querySelectorAll('canvas').length, 1);
  h.view.dispose();
  assert.equal(h.tasks[1].destroyed, 1);
});

test('out-of-order PDF loads cannot replace the current document or leak workers', async () => {
  const h = await harness();
  const first = h.view.load('older');
  await next_turn();
  const second = h.view.load('newer');
  await next_turn();
  h.tasks[1].resolve(h.document);
  await second;
  h.tasks[0].resolve({ ...h.document, numPages: 99 });
  await first;
  assert.equal(h.view.pane.dataset.pdfPages, '10');
  assert.equal(h.tasks[0].destroyed, 1);
  assert.equal(h.layers(), 1);
  h.view.dispose();
});

test('failed and disposed PDF loads destroy tasks without late state updates', async () => {
  const h = await harness();
  const failed = h.view.load('bad');
  await next_turn();
  h.tasks[0].reject(new Error('bad PDF'));
  await failed;
  assert.equal(h.tasks[0].destroyed, 1);
  const pending = h.view.load('pending');
  await next_turn();
  h.view.dispose();
  h.view.dispose();
  h.tasks[1].resolve(h.document);
  await pending;
  assert.equal(h.tasks[1].destroyed, 1);
  assert.equal(h.messages.length, 0);
  assert.equal(h.layers(), 0);
});

test('hiding during the text-layer import cancels stale rendering and releases its canvas', async () => {
  const h = await harness();
  const delayed = deferred<typeof h.library>();
  let calls = 0;
  h.set_loader(() => ++calls === 1 ? Promise.resolve(h.library) : delayed.promise);
  const loaded = h.view.load('pending-render');
  await next_turn();
  h.tasks[0].resolve(h.document);
  await next_turn();
  assert.equal(calls, 2);
  h.view.set_visible(false);
  delayed.resolve(h.library);
  await loaded;
  assert.equal(h.layers(), 0);
  assert.ok(h.elements.filter(element => element.tag === 'canvas').every(canvas => canvas.width === 0));
  h.view.set_visible(true);
  await next_turn();
  assert.equal(h.layers(), 1, 'the cancelled page renders on reactivation');
  h.view.dispose();
});

test('double-clicking PDF text reports unscaled, unrotated top-left SyncTeX points', async () => {
  for (const rotated of [false, true]) {
    const h = await harness();
    if (rotated) h.page.getViewport = ({ scale }) => ({
      width: 800 * scale, height: 600 * scale, scale,
      convertToPdfPoint: (x, y) => [y / scale + 5, x / scale + 10],
    });
    const loaded = h.view.load('coordinates');
    await next_turn();
    h.tasks[0].resolve(h.document);
    await loaded;
    const rendered = h.elements.find(element => (element as unknown as { className: string }).className === 'pdf-page');
    assert.ok(rendered);
    rendered.dispatch('dblclick', { target: new element('span'), clientX: 50, clientY: 80 });
    const message = h.messages.at(-1) as { type: string; page: number; x: number; y: number };
    const scale = (640 - 24) / (rotated ? 800 : 600);
    assert.equal(message.type, 'pdf_reverse_sync');
    assert.equal(message.page, 1);
    assert.ok(Math.abs(message.x - (rotated ? 60 : 40) / scale) < 0.001);
    assert.ok(Math.abs(message.y - (rotated ? 800 - 40 / scale : 60 / scale)) < 0.001);
    const count = h.messages.length;
    rendered.dispatch('dblclick', { target: new element('canvas'), clientX: 50, clientY: 80 });
    assert.equal(h.messages.length, count, 'background clicks do not invoke reverse search');
    h.view.dispose();
  }
});

test('refresh and hidden search result callbacks preserve the PDF reading page', async () => {
  const h = await harness();
  const loaded = h.view.load('before-refresh');
  await next_turn();
  h.tasks[0].resolve(h.document);
  await loaded;
  const viewport = h.elements.find(element => (element as unknown as { className: string }).className === 'pdf-viewport')!;
  const key = { key: 'l', preventDefault() {}, stopPropagation() {} };
  viewport.dispatch('keydown', key);
  viewport.dispatch('keydown', key);
  await next_turn();
  assert.equal(h.view.pane.dataset.pdfPage, '3');
  // Replace only the async search engine boundary, exercising the real viewer callback.
  const provider = (h.view.search as unknown as { provider: {
    select_match(match: { page: number; start: number; end: number }, matches: [], reveal: boolean): void;
  } }).provider;
  provider.select_match({ page: 0, start: 0, end: 1 }, [], false);
  await next_turn();
  assert.equal(h.view.pane.dataset.pdfPage, '3');
  h.view.set_visible(false);
  provider.select_match({ page: 0, start: 0, end: 1 }, [], true);
  h.view.set_visible(true);
  await next_turn();
  assert.equal(h.view.pane.dataset.pdfPage, '3');
  h.view.dispose();
});

test('reverse wheel page navigation lands at the bottom of the previous rendered page', async () => {
  const h = await harness();
  const loaded = h.view.load('wheel-navigation');
  await next_turn();
  h.tasks[0].resolve(h.document);
  await loaded;
  const viewport = h.elements.find(element => (element as unknown as { className: string }).className === 'pdf-viewport')!;
  viewport.dispatch('keydown', { key: 'l', preventDefault() {}, stopPropagation() {} });
  await next_turn();
  viewport.scrollTop = 0;
  viewport.scrollHeight = 1200;
  let consumed = false;
  viewport.dispatch('wheel', {
    deltaX: 0, deltaY: -100, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false,
    preventDefault() { consumed = true; }, stopPropagation() {},
  });
  await next_turn();
  assert.equal(consumed, true);
  assert.equal(h.view.pane.dataset.pdfPage, '1');
  assert.equal(viewport.scrollTop, viewport.scrollHeight, 'browser clamps this request to the page bottom');
  h.view.dispose();
});
