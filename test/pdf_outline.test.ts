import assert from 'node:assert/strict';
import * as path from 'node:path';
import { runInNewContext as run_in_new_context } from 'node:vm';
import { setImmediate as next_turn } from 'node:timers/promises';
import test from 'node:test';
import { build } from 'esbuild';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { pdf_outline } from '../webview/pdf_outline';

const bundled_outline = build({
  entryPoints: [path.resolve(__dirname, '../webview/pdf_outline.ts')], bundle: true,
  write: false, platform: 'browser', format: 'cjs', loader: { '.css': 'empty' },
}).then(result => result.outputFiles[0].text);

function deferred<value>() {
  let resolve!: (value: value) => void;
  const promise = new Promise<value>(accept => { resolve = accept; });
  return { promise, resolve };
}

class element {
  hidden = false;
  className = '';
  textContent = '';
  children: element[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, (event: unknown) => void>();
  constructor(readonly tag: string) {}
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  addEventListener(type: string, callback: (event: unknown) => void) { this.listeners.set(type, callback); }
  dispatch(type: string, event: unknown = {}) { this.listeners.get(type)?.(event); }
  append(...children: element[]) { this.children.push(...children); }
  replaceChildren(...children: element[]) { this.children = children; }
  remove() {}
  find(class_name: string): element[] {
    return this.children.flatMap(child => [...(child.className === class_name ? [child] : []), ...child.find(class_name)]);
  }
}

async function harness() {
  const module = { exports: {} as { pdf_outline: typeof pdf_outline } };
  run_in_new_context(await bundled_outline, {
    module, exports: module.exports, document: { createElement: (tag: string) => new element(tag) },
  });
  const pages: number[] = [];
  const outline = new module.exports.pdf_outline(page => pages.push(page));
  const root = outline.root as unknown as element;
  const status = root.find('pdf-outline-status')[0];
  const set_document = (source: unknown, overrides: Partial<PDFDocumentProxy> = {}) => {
    const pdf = {
      numPages: 20, getOutline: async () => source,
      getDestination: async () => null, getPageIndex: async () => 0, ...overrides,
    } as PDFDocumentProxy;
    outline.set_document(pdf);
    return pdf;
  };
  return { outline, root, status, pages, set_document };
}

test('contents load lazily, preserve hierarchy and navigate one-based internal destinations', async () => {
  const h = await harness();
  let reads = 0;
  let requested_name = '';
  let requested_reference: unknown;
  h.set_document(undefined, {
    getOutline: async () => {
      reads++;
      return [
        { title: 'Chapter', dest: [0], items: [{ title: 'Section', dest: 'section' }] },
        { title: 'External', url: 'https://example.com', unsafeUrl: 'javascript:alert(1)' },
      ] as unknown as Awaited<ReturnType<PDFDocumentProxy['getOutline']>>;
    },
    getDestination: async name => { requested_name = name; return [{ num: 20, gen: 0 }, { name: 'XYZ' }, 0, 0, 0]; },
    getPageIndex: async ref => { requested_reference = ref; return 8; },
  });
  await next_turn();
  assert.equal(reads, 0);
  h.outline.set_open(true);
  await next_turn();
  assert.equal(reads, 1);
  assert.equal(h.root.attributes.get('aria-label'), 'PDF contents');
  assert.equal(h.status.hidden, true);
  const links = h.root.find('pdf-outline-link');
  assert.deepEqual(links.map(link => link.textContent), ['Chapter', 'Section']);
  assert.equal(h.root.find('pdf-outline-label')[0].textContent, 'External');
  links[0].dispatch('click');
  links[1].dispatch('click');
  await next_turn();
  assert.deepEqual(h.pages, [1, 9]);
  assert.equal(requested_name, 'section');
  assert.equal(JSON.stringify(requested_reference), JSON.stringify({ num: 20, gen: 0 }));
  const toggle = h.root.find('pdf-outline-toggle')[0];
  assert.equal(toggle.attributes.get('aria-expanded'), 'true');
  toggle.dispatch('click');
  assert.equal(toggle.attributes.get('aria-expanded'), 'false');
  toggle.dispatch('keydown', { key: 'ArrowRight', preventDefault() {}, stopPropagation() {} });
  assert.equal(toggle.attributes.get('aria-expanded'), 'true');
  h.outline.set_open(false);
  h.outline.set_open(true);
  await next_turn();
  assert.equal(reads, 1, 'reopening uses the same document outline');
  h.outline.dispose();
});

test('empty, failed and invalid destinations give readable states without opening external URLs', async () => {
  const h = await harness();
  h.set_document(null);
  h.outline.set_open(true);
  await next_turn();
  assert.match(h.status.textContent, /no table of contents/);
  let fail = true;
  h.set_document(undefined, { getOutline: async () => { if (fail) throw new Error('worker closed'); return []; } });
  await next_turn();
  assert.match(h.status.textContent, /could not be loaded/);
  const retry = h.root.find('pdf-outline-retry')[0];
  assert.equal(retry.hidden, false);
  fail = false;
  retry.dispatch('click');
  await next_turn();
  assert.equal(retry.hidden, true);
  h.set_document([
    { title: '<img src=x onerror=alert(1)>', dest: [20] },
    { title: 'Missing', dest: 'missing' },
    { title: 'Broken reference', dest: [{ num: 1, gen: 0 }] },
    { title: 'Bad destination', dest: [-1] },
  ], { getPageIndex: async () => { throw new Error('invalid reference'); } });
  await next_turn();
  const links = h.root.find('pdf-outline-link');
  assert.equal(links[0].textContent, '<img src=x onerror=alert(1)>', 'titles remain plain DOM text');
  for (const link of links) { link.dispatch('click'); await next_turn(); }
  assert.deepEqual(h.pages, []);
  assert.match(h.status.textContent, /could not be opened/);
  assert.equal(h.root.find('pdf-outline-label').at(-1)?.textContent, 'Bad destination');
  h.outline.dispose();
});

test('cyclic, deep, wide and malformed outlines have bounded DOM and title sizes', async () => {
  const h = await harness();
  const cycle: { title: string; items: unknown[] } = { title: 'Cycle', items: [] };
  cycle.items.push(cycle);
  let deep: unknown = { title: 'Bottom' };
  for (let index = 0; index < 100; index++) deep = { title: 'Level', items: [deep] };
  h.set_document([cycle, deep, ...Array.from({ length: 5000 }, () => ({ title: 'x'.repeat(10000), dest: [0] }))]);
  h.outline.set_open(true);
  await next_turn();
  const labels = [...h.root.find('pdf-outline-label'), ...h.root.find('pdf-outline-link')];
  assert.ok(labels.length <= 2000);
  assert.equal(labels.filter(label => label.textContent === 'Cycle').length, 1);
  assert.ok(labels.filter(label => label.textContent === 'Level').length <= 12);
  assert.ok(labels.every(label => label.textContent.length <= 512));
  assert.match(h.status.textContent, /omitted/);
  h.set_document([null, false, 9, {}, { title: '\x00\n\t' }]);
  await next_turn();
  assert.deepEqual(h.root.find('pdf-outline-label').map(label => label.textContent), ['Untitled section', 'Untitled section']);
  h.outline.dispose();
});

test('refresh and disposal invalidate pending outlines and detached navigation buttons', async () => {
  const h = await harness();
  const old = deferred<Awaited<ReturnType<PDFDocumentProxy['getOutline']>>>();
  h.set_document(undefined, { getOutline: () => old.promise });
  h.outline.set_open(true);
  h.set_document([{ title: 'Current', dest: [3] }]);
  await next_turn();
  old.resolve([{ title: 'Old', dest: [1] }] as Awaited<ReturnType<PDFDocumentProxy['getOutline']>>);
  await next_turn();
  const old_link = h.root.find('pdf-outline-link')[0];
  assert.equal(old_link.textContent, 'Current');
  h.set_document([{ title: 'Newer', dest: [5] }]);
  old_link.dispatch('click');
  await next_turn();
  assert.deepEqual(h.pages, []);
  const pending = deferred<Awaited<ReturnType<PDFDocumentProxy['getOutline']>>>();
  h.set_document(undefined, { getOutline: () => pending.promise });
  h.outline.dispose();
  h.outline.dispose();
  pending.resolve([{ title: 'After disposal', dest: [1] }] as Awaited<ReturnType<PDFDocumentProxy['getOutline']>>);
  await next_turn();
  assert.equal(h.root.children.length, 0);
  assert.deepEqual(h.pages, []);
});

test('stale named destinations and page references cannot navigate after refresh, close or a newer click', async () => {
  const h = await harness();
  const destination = deferred<unknown[]>();
  let reference_calls = 0;
  h.set_document([{ title: 'Old named section', dest: 'section' }, { title: 'Immediate', dest: [2] }], {
    getDestination: () => destination.promise,
    getPageIndex: async () => { reference_calls++; return 5; },
  });
  h.outline.set_open(true);
  await next_turn();
  let links = h.root.find('pdf-outline-link');
  links[0].dispatch('click');
  links[1].dispatch('click');
  destination.resolve([{ num: 8, gen: 0 }]);
  await next_turn();
  assert.deepEqual(h.pages, [3]);
  assert.equal(reference_calls, 0, 'superseded named destinations do not start another worker request');
  for (const cancel of [() => h.outline.set_open(false), () => h.set_document([]), () => h.outline.dispose()]) {
    const page = deferred<number>();
    h.set_document([{ title: 'Pending reference', dest: [{ num: 8, gen: 0 }] }], { getPageIndex: () => page.promise });
    h.outline.set_open(true);
    await next_turn();
    links = h.root.find('pdf-outline-link');
    links[0].dispatch('click');
    cancel();
    page.resolve(7);
    await next_turn();
    assert.deepEqual(h.pages, [3]);
  }
});
