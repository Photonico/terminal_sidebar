import assert from 'node:assert/strict';
import * as path from 'node:path';
import { runInNewContext as run_in_new_context } from 'node:vm';
import { setImmediate as next_turn } from 'node:timers/promises';
import test from 'node:test';
import { build } from 'esbuild';
import type { pdf_view } from '../webview/pdf_view';
import type { pdf_position } from '../src/pdf_state';

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
  className = '';
  title = '';
  readonly attributes = new Map<string, string>();
  classList = { add: (...names: string[]) => { this.className += ' ' + names.join(' '); } };
  get firstElementChild() { return this.children[0]; }
  get options() { return this.children; }
  get valueAsNumber() { return this.value.trim() ? Number(this.value) : NaN; }
  width = 0;
  height = 0;
  clientWidth = 640;
  clientHeight = 480;
  scrollTop = 0;
  scrollLeft = 0;
  get scrollHeight() { return Math.max(this.clientHeight, (parseFloat(this.children[0]?.style.height ?? '') || 0) + 24); }
  get scrollWidth() { return Math.max(this.clientWidth, (parseFloat(this.children[0]?.style.width ?? '') || 0) + 24); }
  dataset: Record<string, string> = {};
  children: element[] = [];
  parent?: element;
  style = { height: '', width: '', setProperty() {} };
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  constructor(readonly tag: string) {}
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name); }
  addEventListener(type: string, listener: (event: unknown) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  dispatch(type: string, event: unknown) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  append(...children: element[]) { this.children.push(...children); for (const child of children) child.parent = this; }
  add(child: element) { this.append(child); }
  replaceChildren(...children: element[]) { this.children = children; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  focus() {}
  scrollBy({ top = 0, left = 0 }: { top?: number; left?: number }) {
    this.scrollTop = Math.max(0, Math.min(this.scrollHeight - this.clientHeight, this.scrollTop + top));
    this.scrollLeft = Math.max(0, Math.min(this.scrollWidth - this.clientWidth, this.scrollLeft + left));
    this.dispatch('scroll', {});
  }
  closest(selector: string) {
    if (selector === '.textLayer span') return this.tag === 'span' ? this : undefined;
    return ['input', 'select', 'textarea'].includes(this.tag) ? this : undefined;
  }
  getBoundingClientRect() { return { left: 10, top: 20 }; }
  querySelectorAll(tag: string): element[] {
    return this.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag)]);
  }
  querySelector(tag: string): element | undefined { return this.querySelectorAll(tag)[0]; }
}

async function harness(position: Partial<pdf_position> = {}) {
  const module = { exports: {} as { pdf_view: typeof pdf_view } };
  const elements: element[] = [];
  let now = 0;
  run_in_new_context(await bundled_view, {
    module, exports: module.exports, setTimeout, clearTimeout, AbortController, URL, performance: { now: () => now },
    document: {
      body: new element('body'), addEventListener() {},
      querySelector: () => ({ content: 'https://local.test/pdfjs' }),
      createElement: (tag: string) => { const created = new element(tag); elements.push(created); return created; },
    },
    window: { devicePixelRatio: 2, addEventListener() {} }, Element: element, Node: element,
    Option: class extends element { constructor(text: string, value: string) { super('option'); this.textContent = text; this.value = value; } },
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
    ...position,
  } as unknown as ConstructorParameters<typeof pdf_view>[0], message => messages.push(message),
  () => loader() as unknown as Promise<typeof import('pdfjs-dist')>);
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({
      width: 600 * scale, height: 800 * scale, scale,
      convertToPdfPoint: (x: number, y: number) => [x / scale + 5, 810 - y / scale],
      convertToViewportPoint: (x: number, y: number) => [(x - 5) * scale, (810 - y) * scale],
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
  assert.equal(h.layers(), 2);
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
  assert.equal(h.layers(), 4);
  assert.equal(h.view.pane.querySelectorAll('canvas').length, 2);
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
  assert.equal(h.layers(), 2);
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
  assert.equal(calls, 3);
  h.view.set_visible(false);
  delayed.resolve(h.library);
  await loaded;
  assert.equal(h.layers(), 0);
  assert.ok(h.elements.filter(element => element.tag === 'canvas').every(canvas => canvas.width === 0));
  h.view.set_visible(true);
  await next_turn();
  assert.equal(h.layers(), 2, 'the cancelled page renders on reactivation');
  h.view.dispose();
});

test('double-clicking PDF text reports unscaled, unrotated top-left SyncTeX points', async () => {
  for (const rotated of [false, true]) {
    const h = await harness();
    if (rotated) h.page.getViewport = ({ scale }) => ({
      width: 800 * scale, height: 600 * scale, scale,
      convertToPdfPoint: (x, y) => [y / scale + 5, x / scale + 10],
      convertToViewportPoint: (x, y) => [(y - 10) * scale, (x - 5) * scale],
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

test('the toolbar and notice float over the pages, and the floating outline opens without re-rendering', async () => {
  const h = await harness();
  const loaded = h.view.load('outline');
  await next_turn();
  h.tasks[0].resolve(h.document);
  await loaded;
  const find = (name: string) => h.elements.find(item => item.className.split(' ').includes(name))!;
  const [overlay, body] = (h.view.pane as unknown as element).children;
  assert.equal(overlay.className, 'preview-float');
  assert.deepEqual(overlay.children.map(child => child.className.split(' ')[0]), ['pdf-toolbar', 'pdf-notice']);
  assert.deepEqual(body.children.map(child => child.className), ['pdf-outline preview-outline', 'pdf-viewport']);
  let renders = 0;
  const render = h.page.render;
  h.page.render = () => { renders++; return render(); };
  const outline = find('pdf-outline');
  const button = h.elements.find(item => item.getAttribute('aria-label') === 'Toggle document outline')!;
  button.dispatch('click', {});
  await next_turn();
  assert.equal(outline.hidden, false);
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(renders, 0, 'The floating outline leaves the page width unchanged');
  let focused = 0;
  button.focus = () => { focused++; };
  const escape = () => ({ key: 'Escape', defaulted: false, preventDefault() { this.defaulted = true; }, stopPropagation() {} });
  const inside = escape();
  outline.dispatch('keydown', inside);
  assert.equal(outline.hidden, true);
  assert.equal(inside.defaulted, true);
  assert.equal(focused, 1, 'Escape inside the outline returns to its button');
  button.dispatch('click', {});
  const viewport = find('pdf-viewport');
  const from_pages = escape();
  viewport.dispatch('keydown', from_pages);
  assert.equal(outline.hidden, true, 'Escape from the pages closes the outline too');
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  const idle = escape();
  viewport.dispatch('keydown', idle);
  assert.equal(idle.defaulted, false, 'Escape stays available once the outline is closed');
  h.view.dispose();
});

test('PDF links jump to their destination point, keep web links native and send sibling files to the host', async () => {
  const h = await harness();
  Object.assign(h.page, { getAnnotations: async () => [
    { annotationType: 2, rect: [105, 700, 205, 720], dest: 'section.4' },
    { annotationType: 2, rect: [105, 600, 205, 620], url: 'https://example.com/paper' },
    { annotationType: 2, rect: [105, 500, 205, 520], unsafeUrl: 'appendix.pdf' },
    { annotationType: 2, rect: [105, 400, 205, 420], action: 'LastPage' },
  ] });
  const requested: unknown[] = [];
  const loaded = h.view.load('links');
  await next_turn();
  h.tasks[0].resolve({ ...h.document,
    getDestination: async (name: string) => { requested.push(name); return [{ num: 40, gen: 0 }, { name: 'XYZ' }, 5, 410, null]; },
    getPageIndex: async () => 3 });
  await loaded;
  await next_turn();
  const layer = h.elements.find(item => item.className === 'pdf-link-layer')!;
  assert.ok(layer, 'Rendered pages receive a link layer');
  const [internal, web, sibling, last] = layer.children as unknown as Array<element & { href?: string; style: Record<string, string> }>;
  assert.equal(web.href, 'https://example.com/paper');
  assert.equal(internal.href, undefined);
  const scale = (640 - 24) / 600;
  assert.equal(internal.style.top, `${(810 - 720) * scale}px`, 'Link areas use the rendered page scale');
  const viewport = h.elements.find(item => item.className === 'pdf-viewport')!;
  const handled = () => ({ prevented: 0, stopped: 0, preventDefault() { this.prevented++; }, stopPropagation() { this.stopped++; } });
  const click = handled();
  internal.dispatch('click', click);
  for (let turn = 0; turn < 4; turn++) await next_turn();
  assert.deepEqual([click.prevented, click.stopped], [1, 1]);
  assert.deepEqual(requested, ['section.4']);
  const geometry = (h.view as unknown as { geometry: { boxes: Map<number, { top: number; scale: number }> } }).geometry;
  const box = geometry.boxes.get(3)!;
  assert.ok(Math.abs(viewport.scrollTop - (box.top + (810 - 410) * box.scale)) < 0.001,
    'The destination point, not just its page, is brought into view');
  assert.equal(h.view.pane.dataset.pdfPage, '4');
  sibling.dispatch('click', handled());
  assert.equal(JSON.stringify(h.messages.at(-1)), JSON.stringify({ type: 'open_pdf_link', id: 'document', href: 'appendix.pdf' }));
  last.dispatch('click', handled());
  await next_turn();
  assert.equal(h.view.pane.dataset.pdfPage, '10');
  h.view.dispose();
});

test('scrolling directly across the document updates the page and frees distant canvases', async () => {
  const h = await harness();
  const loaded = h.view.load('scroll-navigation');
  await next_turn();
  h.tasks[0].resolve(h.document);
  await loaded;
  const viewport = h.elements.find(element => (element as unknown as { className: string }).className === 'pdf-viewport')!;
  const canvases = h.elements.filter(element => element.tag === 'canvas');
  viewport.scrollTop = 7500;
  viewport.dispatch('scroll', {});
  await next_turn();
  assert.equal(h.view.pane.dataset.pdfPage, '10');
  assert.ok([...canvases].every(canvas => canvas.width === 0), 'offscreen allocations are released');
  assert.ok(h.view.pane.querySelectorAll('canvas').length <= 6);
  viewport.scrollTop = 0;
  viewport.dispatch('scroll', {});
  await next_turn();
  assert.equal(h.view.pane.dataset.pdfPage, '1');
  h.view.dispose();
});

test('Enter commits the PDF page input, renders that page and remembers its position', async () => {
  const h = await harness();
  const loaded = h.view.load('page-input');
  await next_turn();
  h.tasks[0].resolve(h.document);
  await loaded;
  const input = h.elements.find(element => element.tag === 'input')!;
  input.value = '8';
  input.dispatch('input', {});
  let prevented = false;
  let stopped = false;
  input.dispatch('keydown', {
    key: 'Enter', isComposing: false,
    preventDefault() { prevented = true; }, stopPropagation() { stopped = true; },
  });
  await next_turn();
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.equal(h.view.pane.dataset.pdfPage, '8');
  const message = h.messages.at(-1) as { type: string; position: { page: number } };
  assert.equal(message.type, 'pdf_position');
  assert.equal(message.position.page, 8);
  h.view.dispose();
});

test('hidden loading preserves the real dimensions of mixed-size pages before first display', async () => {
  const h = await harness();
  const loaded = h.view.load('mixed-sizes');
  await next_turn();
  h.view.set_visible(false);
  h.tasks[0].resolve({ numPages: 2, getPage: async (number: number) => ({ ...h.page,
    getViewport: ({ scale }: { scale: number }) => ({ width: (number === 1 ? 600 : 1200) * scale, height: 800 * scale, scale }),
  }) });
  await loaded;
  await next_turn();
  h.view.set_visible(true);
  await next_turn();
  const geometry = (h.view as unknown as { geometry: { boxes: Map<number, { height: number }> } }).geometry;
  assert.equal(geometry.boxes.size, 2);
  assert.equal(geometry.boxes.get(0)!.height, geometry.boxes.get(1)!.height * 2);
  h.view.dispose();
});

test('paged browsing, search jumps, zoom and dark mode survive PDF refresh', async () => {
  const h = await harness();
  const load = h.view.load('modes');
  await next_turn(); h.tasks[0].resolve(h.document); await load;
  const button = (title: string) => h.elements.find(element => element.tag === 'button' && element.title === title)!;
  const mode = h.elements.find(element => element.tag === 'select' && element.title === 'Display mode')!;
  mode.value = 'spread';
  mode.dispatch('change', {});
  await next_turn();
  assert.equal(h.view.pane.dataset.pdfMode, 'spread');
  let canvases = h.view.pane.querySelectorAll('canvas');
  assert.equal(canvases.length, 2);
  h.view.reveal_match({ page: 6, start: 0, end: 1 } as never);
  await next_turn();
  assert.equal(h.view.pane.dataset.pdfPage, '7');
  assert.ok([...canvases].every(canvas => canvas.width === 0), 'the previous pair releases its bitmaps');
  mode.value = 'single';
  mode.dispatch('change', {});
  await next_turn();
  assert.equal(h.view.pane.querySelectorAll('canvas').length, 1);
  button('Dark mode').dispatch('click', {});
  button('Actual size (100%)').dispatch('click', {});
  await next_turn();
  const position = (h.messages.at(-1) as { position: Record<string, unknown> }).position;
  assert.equal(position.page, 7);
  assert.equal(position.zoom, 1);
  assert.equal(position.mode, 'single');
  assert.equal(position.dark, true);
  const reload = h.view.load('modes-refreshed');
  await next_turn(); h.tasks[1].resolve(h.document); await reload;
  assert.equal(h.view.pane.dataset.pdfPage, '7');
  assert.equal(h.view.pane.dataset.pdfMode, 'single');
  assert.equal(h.view.pane.dataset.pdfDark, 'true');
  h.view.dispose();
});

test('modifier wheel zoom coalesces rendering, clamps scale and leaves ordinary scrolling alone', async () => {
  const h = await harness();
  const load = h.view.load('zoom');
  await next_turn(); h.tasks[0].resolve(h.document); await load;
  const viewport = h.elements.find(element => element.className === 'pdf-viewport')!;
  let prevented = 0;
  const wheel = { metaKey: true, ctrlKey: false, altKey: false, deltaMode: 0, deltaY: -500,
    preventDefault() { prevented++; }, stopPropagation() {} };
  const before = h.messages.length;
  for (let i = 0; i < 15; i++) viewport.dispatch('wheel', wheel);
  assert.equal(prevented, 15);
  assert.equal(h.messages.length, before, 'wheel bursts do not emit a host message per tick');
  await new Promise(resolve => setTimeout(resolve, 110));
  assert.equal((h.messages.at(-1) as { position: { zoom: number } }).position.zoom, 4);
  viewport.dispatch('wheel', { ...wheel, metaKey: false });
  assert.equal(prevented, 15);
  viewport.dispatch('wheel', { ...wheel, deltaY: 500 });
  h.view.dispose();
  const disposed = h.messages.length;
  await new Promise(resolve => setTimeout(resolve, 110));
  assert.equal(h.messages.length, disposed, 'a disposed reader cannot commit delayed zoom');
});

function input_event(values: Record<string, unknown>) {
  return { defaultPrevented: false, stopped: false, ...values,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
}

async function reading_harness(position: Partial<pdf_position> = {}) {
  const h = await harness(position);
  const load = h.view.load('navigation');
  await next_turn(); h.tasks[0].resolve(h.document); await load; await next_turn();
  const viewport = h.elements.find(item => item.className === 'pdf-viewport')!;
  const key = (key: string) => {
    const event = input_event({ key, target: viewport });
    viewport.dispatch('keydown', event);
    return event;
  };
  const wheel = (deltaY: number, values: Record<string, unknown> = {}) => {
    const event = input_event({ deltaY, deltaX: 0, deltaMode: 0, ...values });
    viewport.dispatch('wheel', event);
    return event;
  };
  return { ...h, viewport, key, wheel };
}

test('arrow keys pan in every PDF mode, while PageUp and PageDown turn pages or spreads', async () => {
  for (const mode of ['continuous', 'horizontal', 'single', 'spread'] as const) {
    const h = await reading_harness({ mode, zoom: 2 });
    const down = h.key('ArrowDown');
    assert.equal(h.viewport.scrollTop, 70, mode);
    assert.equal(down.defaultPrevented, true);
    assert.equal(down.stopped, true);
    h.key('ArrowRight');
    assert.equal(h.viewport.scrollLeft, 70, mode);
    assert.equal(h.view.pane.dataset.pdfPage, '1', 'panning does not directly turn pages');
    h.key('ArrowUp'); h.key('ArrowLeft');
    assert.equal(h.viewport.scrollTop, 0);
    assert.equal(h.viewport.scrollLeft, 0);
    h.key('PageDown'); await next_turn();
    assert.equal(h.view.pane.dataset.pdfPage, mode === 'spread' ? '3' : '2', mode);
    h.key('PageUp'); await next_turn();
    assert.equal(h.view.pane.dataset.pdfPage, '1', mode);
    h.view.dispose();
  }
});

test('Shift+wheel pans horizontally in all modes, including pretranslated and line/page deltas', async () => {
  for (const mode of ['continuous', 'horizontal', 'single', 'spread'] as const) {
    const h = await reading_harness({ mode, zoom: 2 });
    assert.equal(h.wheel(90, { shiftKey: true }).defaultPrevented, true);
    assert.equal(h.viewport.scrollLeft, 90, mode);
    h.wheel(0, { shiftKey: true, deltaX: 30 });
    assert.equal(h.viewport.scrollLeft, 120);
    h.wheel(2, { shiftKey: true, deltaMode: 1 });
    assert.equal(h.viewport.scrollLeft, 152);
    h.wheel(-1, { shiftKey: true, deltaMode: 2 });
    assert.equal(h.viewport.scrollLeft, 0);
    assert.equal(h.viewport.scrollTop, 0);
    assert.equal(h.view.pane.dataset.pdfPage, '1');
    h.view.dispose();
  }
});

test('single and spread modes scroll to an edge before turning, and return to the previous bottom', async () => {
  for (const mode of ['single', 'spread'] as const) {
    const h = await reading_harness({ mode, zoom: 2 });
    h.key('ArrowRight');
    const bottom = h.viewport.scrollHeight - h.viewport.clientHeight;
    h.viewport.scrollTop = bottom - 20;
    h.key('ArrowDown');
    assert.equal(h.viewport.scrollTop, bottom);
    assert.equal(h.view.pane.dataset.pdfPage, '1');
    h.key('ArrowDown'); await next_turn();
    assert.equal(h.view.pane.dataset.pdfPage, mode === 'spread' ? '3' : '2');
    assert.equal(h.viewport.scrollTop, 0);
    assert.equal(h.viewport.scrollLeft, 70, 'page turns preserve horizontal panning');
    h.key('ArrowUp'); await next_turn();
    assert.equal(h.view.pane.dataset.pdfPage, '1');
    assert.equal(h.viewport.scrollTop, bottom, 'reverse turns enter at the previous page bottom');
    h.viewport.scrollTop = 0;
    h.key('ArrowUp');
    assert.equal(h.viewport.scrollTop, 0, 'the first page remains at its upper edge');
    h.wheel(80);
    assert.equal(h.viewport.scrollTop, 80, 'ordinary wheel pans tall pages');
    h.viewport.scrollTop = bottom;
    h.wheel(80); await next_turn();
    assert.equal(h.view.pane.dataset.pdfPage, mode === 'spread' ? '3' : '2');
    h.view.dispose();
  }
});

test('wheel bursts do not skip fitted pages and document boundaries stay in place', async () => {
  for (const mode of ['single', 'spread'] as const) {
    const h = await reading_harness({ mode, zoom: 'page-fit' });
    h.wheel(100); await next_turn();
    const step = mode === 'spread' ? 2 : 1;
    assert.equal(h.view.pane.dataset.pdfPage, String(1 + step));
    h.set_time(100);
    h.wheel(100); await next_turn();
    assert.equal(h.view.pane.dataset.pdfPage, String(1 + step), 'trailing wheel event is coalesced');
    h.set_time(350);
    h.wheel(100); await next_turn();
    assert.equal(h.view.pane.dataset.pdfPage, String(1 + 2 * step));
    h.key('G'); await next_turn();
    h.set_time(700);
    h.wheel(100); h.key('PageDown'); await next_turn();
    assert.equal(h.view.pane.dataset.pdfPage, '10', 'the final page/spread stays selected');
    h.view.dispose();
  }
});

test('horizontal scrolling tracks the current page, releases offscreen canvases and preserves zoom position', async () => {
  const h = await reading_harness({ mode: 'horizontal', zoom: 2 });
  const old_canvases = h.view.pane.querySelectorAll('canvas');
  h.viewport.scrollLeft = 9 * (1200 + 12);
  h.viewport.dispatch('scroll', {}); await next_turn();
  assert.equal(h.view.pane.dataset.pdfPage, '10');
  assert.ok([...old_canvases].every(canvas => canvas.width === 0));
  assert.ok(h.view.pane.querySelectorAll('canvas').length <= 3);
  h.key('ArrowDown');
  assert.equal(h.view.pane.dataset.pdfPage, '10', 'vertical movement stays within the horizontal row');
  h.key('PageUp'); await next_turn();
  assert.equal(h.view.pane.dataset.pdfPage, '9');
  assert.equal(h.viewport.scrollLeft, 8 * (1200 + 12));
  h.key('ArrowRight');
  const zoom = h.elements.find(item => item.tag === 'select' && item.title === 'Zoom')!;
  zoom.value = '3'; zoom.dispatch('change', {}); await next_turn();
  assert.ok(Math.abs(h.viewport.scrollLeft - (8 * (1800 + 12) + 105)) < 0.001);
  assert.equal(h.viewport.scrollTop, 105, 'both pan offsets scale with zoom');
  h.view.dispose();
});

test('PDF toolbar buttons allow reader navigation while inputs and dropdowns retain native keys', async () => {
  const h = await reading_harness({ zoom: 2 });
  const toolbar = h.elements.find(item => item.className.split(' ').includes('pdf-toolbar'))!;
  const button = h.elements.find(item => item.title === 'Zoom in')!;
  const arrow = input_event({ key: 'ArrowDown', target: button });
  toolbar.dispatch('keydown', arrow);
  assert.equal(h.viewport.scrollTop, 70);
  for (const control of h.elements.filter(item => item.tag === 'input' || item.tag === 'select')) {
    const event = input_event({ key: 'ArrowDown', target: control });
    toolbar.dispatch('keydown', event);
    assert.equal(event.defaultPrevented, false);
    assert.equal(h.viewport.scrollTop, 70);
  }
  h.view.dispose();
});
