import assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { normalize_search_text, type document_match } from '../webview/document_search';
import type { markdown_tab } from '../src/types';

type highlight_api = typeof import('../webview/document_highlights');
type markdown_api = typeof import('../webview/markdown_view');
const bundle = (name: string) => build({ entryPoints: [path.join(__dirname, `../webview/${name}.ts`)],
  bundle: true, write: false, platform: 'node', format: 'cjs', loader: { '.css': 'empty' },
}).then(result => result.outputFiles[0].text);
const helper_bundle = bundle('document_highlights');
const markdown_bundle = bundle('markdown_view');

class highlight_fixture {
  priority = 0;
  readonly ranges: Range[];
  constructor(...ranges: Range[]) { this.ranges = ranges; }
}

async function fixture(with_highlights = true) {
  const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
  const registry = new Map<string, highlight_fixture>();
  if (with_highlights) {
    Object.defineProperty(dom.window, 'CSS', { value: { highlights: registry }, configurable: true });
    Object.defineProperty(dom.window, 'Highlight', { value: highlight_fixture });
  }
  Object.defineProperty(dom.window.Range.prototype, 'getBoundingClientRect', {
    value: () => new dom.window.DOMRect(0, 30, 10, 10),
  });
  const context = {
    document: dom.window.document, window: dom.window, NodeFilter: dom.window.NodeFilter,
    AbortController: dom.window.AbortController,
    Element: dom.window.Element, TextEncoder, TextDecoder, URL,
    setTimeout, clearTimeout,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  };
  const load = (source: string) => {
    const module = { exports: {} };
    runInNewContext(source, { ...context, module, exports: module.exports });
    return module.exports;
  };
  const api = load(await helper_bundle) as highlight_api;
  const root = (html: string) => {
    const element = dom.window.document.createElement('article');
    element.innerHTML = html;
    dom.window.document.body.append(element);
    return element;
  };
  return { dom, registry, api, root, load };
}

function match(text: string, query: string, from = 0): document_match {
  const start = normalize_search_text(text).indexOf(query, from);
  assert.ok(start >= 0);
  return { page: 0, start, end: start + query.length };
}

test('document highlights span real formatted DOM text and cache ranges between hits', async () => {
  const { dom, registry, api, root } = await fixture();
  try {
    const content = root('Some  <strong>bold</strong>\ntext <em> and more</em>\ntext');
    const text = api.document_search_text(content);
    const matches = [match(text, 'bold text'), match(text, 'text', 15)];
    const revealed: Range[] = [];
    const highlights = new api.document_highlights(content, range => revealed.push(range));
    assert.equal(highlights.select(matches[0], matches, true), true);
    const all = registry.get('sidebar_document_find_all')!;
    assert.equal(all.ranges.length, 2);
    assert.equal(all.ranges[0].toString(), 'bold\ntext');
    assert.equal(all.ranges[1].toString(), 'text');
    assert.equal(registry.get('sidebar_document_find')!.priority, 1);
    assert.equal(revealed.length, 1);
    highlights.select(matches[1], matches, false);
    assert.equal(registry.get('sidebar_document_find_all')!.ranges[0], all.ranges[0], 'Same query reuses DOM ranges');
    assert.equal(registry.get('sidebar_document_find')!.ranges[0], all.ranges[1]);
    assert.equal(revealed.length, 1, 'Background reindexing does not move the document');
    highlights.clear();
    assert.equal(registry.size, 0);
  } finally { dom.window.close(); }
});

test('document search text and range offsets exclude executable and styling content', async () => {
  const { dom, registry, api, root } = await fixture();
  try {
    const content = root('before <style>.secret {color:red}</style><script>hidden()</script><template>hidden</template><noscript>hidden</noscript><strong>needle</strong> after');
    assert.equal(api.document_search_text(content), 'before needle after');
    const selected = match(api.document_search_text(content), 'needle after');
    const highlights = new api.document_highlights(content, () => undefined);
    assert.equal(highlights.select(selected, [selected], false), true);
    assert.equal(registry.get('sidebar_document_find')!.ranges[0].toString(), 'needle after');
  } finally { dom.window.close(); }
});

test('clearing an older document cannot erase the active document highlights', async () => {
  const { dom, registry, api, root } = await fixture();
  try {
    const first = new api.document_highlights(root('<b>first</b> needle'), () => undefined);
    const second = new api.document_highlights(root('<b>second</b> needle'), () => undefined);
    const first_match = match('first needle', 'needle');
    const second_match = match('second needle', 'needle');
    first.select(first_match, [first_match], false);
    second.select(second_match, [second_match], false);
    const selected = registry.get('sidebar_document_find');
    const others = registry.get('sidebar_document_find_all');
    first.clear();
    assert.equal(registry.get('sidebar_document_find'), selected);
    assert.equal(registry.get('sidebar_document_find_all'), others);
    second.clear();
    assert.equal(registry.size, 0);
  } finally { dom.window.close(); }
});

test('document find still reveals text when the CSS Highlight API is unavailable', async () => {
  const { dom, api, root } = await fixture(false);
  try {
    const revealed: string[] = [];
    const highlights = new api.document_highlights(root('before <strong>needle</strong> after'), range => revealed.push(range.toString()));
    const selected = match('before needle after', 'needle');
    assert.doesNotThrow(() => highlights.clear());
    assert.equal(highlights.select(selected, [selected], true), true);
    assert.deepEqual(revealed, ['needle']);
    assert.doesNotThrow(() => highlights.select(undefined, [], false));
  } finally { dom.window.close(); }
});

test('stale or malformed document matches never create empty or invalid highlights', async () => {
  const { dom, registry, api, root } = await fixture();
  try {
    let reveals = 0;
    const highlights = new api.document_highlights(root('short text'), () => { reveals++; });
    for (const [start, end] of [[100, 110], [3, 110], [-1, 4], [3, 3], [4, 2], [NaN, 4], [1.5, 4]]) {
      const selected = { page: 0, start, end };
      assert.equal(highlights.select(selected, [selected], true), false, `${start}:${end}`);
      assert.equal(registry.size, 0);
    }
    assert.equal(reveals, 0);
    const valid = match('short text', 'text');
    assert.equal(highlights.select(valid, [valid], true), true, 'Valid results recover after an invalid request');
    assert.equal(registry.get('sidebar_document_find')!.ranges[0].toString(), 'text');
  } finally { dom.window.close(); }
});

test('Markdown public navigation reveals visible matches and leaves hidden previews in place', async () => {
  const { dom, registry, load } = await fixture();
  const { markdown_view } = load(await markdown_bundle) as markdown_api;
  const tab: markdown_tab = { kind: 'markdown', id: 'md_test', name: 'Markdown', uri: 'file:///work/test.md', scroll: 0 };
  const view = new markdown_view(tab, () => undefined);
  try {
    dom.window.document.body.append(view.pane);
    view.load({ base_url: 'https://file+.vscode-resource.vscode-cdn.net/work/', text: 'Some **bold**\ntext and more.' });
    const content = view.pane.querySelector<HTMLElement>('.markdown-content')!;
    const viewport = view.pane.querySelector<HTMLElement>('.markdown-viewport')!;
    Object.defineProperty(viewport, 'clientHeight', { value: 100 });
    const selected = match(content.textContent ?? '', 'bold text');
    assert.equal(view.reveal_match(selected), true);
    assert.equal(registry.get('sidebar_document_find')!.ranges[0].toString(), 'bold\ntext');
    viewport.scrollTop = 400;
    view.set_visible(false);
    assert.equal(view.reveal_match(selected), false);
    assert.equal(viewport.scrollTop, 400, 'Hidden Markdown does not jump to a search result');
  } finally { view.dispose(); dom.window.close(); }
});
