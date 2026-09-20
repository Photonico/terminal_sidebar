import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { is_markdown_link, is_markdown_position, is_markdown_uri, max_markdown_bytes } from '../src/markdown_state';
import { markdown_image_url, render_markdown } from '../webview/markdown_render';
import { normalize_search_text, type document_match } from '../webview/document_search';

const base_url = 'https://file+.vscode-resource.vscode-cdn.net/work/paper/';

test('Markdown state accepts local documents and bounded scroll positions only', () => {
  for (const value of ['file:///work/README.md', 'file:///work/%E6%96%87%E7%AB%A0.markdown', 'vscode-remote://ssh-remote+host/work/notes.MD']) {
    assert.equal(is_markdown_uri(value), true, value);
  }
  for (const value of [null, {}, '/work/file.md', 'https://example.com/file.md', 'file:///work/file.txt',
    'file:///work/file.md#one', 'file:///work/file.md?token=1', 'file:///work/%00bad.md', 'file:///work/%zz.md']) {
    assert.equal(is_markdown_uri(value), false, String(value));
  }
  for (const scroll of [0, 1.5, 100_000_000]) assert.equal(is_markdown_position({ scroll }), true);
  for (const scroll of [-1, Infinity, NaN, '0', undefined, 100_000_001]) assert.equal(is_markdown_position({ scroll }), false);
});

test('Markdown supports ordinary syntax while raw HTML and executable links stay inert', () => {
  const html = render_markdown({ base_url, text: '# Heading\n\n**Bold** and *emphasis*.\n\n| One | Two |\n| --- | --- |\n| a | b |\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n[command](command:workbench.action.closeWindow)\n[ok](https://example.com)\n\n```ts\nconst a = 1;\n```' });
  assert.match(html, /<h1 id="heading">Heading<\/h1>/);
  assert.match(html, /<strong>Bold<\/strong>/);
  assert.match(html, /<table>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script\b|href="(?:javascript|command):/);
  assert.match(html, /href="https:\/\/example.com"/);
  assert.match(html, /<code class="language-ts">/);
});

test('Markdown links cannot invoke commands and heading anchors are stable and unique', () => {
  for (const href of ['#heading', 'next.md', '../chapter/file.md#part', 'https://example.com/a', 'mailto:test@example.com', 'file:///work/test.md']) {
    assert.equal(is_markdown_link(href), true);
  }
  for (const href of ['', '//evil.example/file', '\\evil\file', 'command:workbench.action.closeWindow', 'javascript:alert(1)', 'data:text/html,a', ' https://example.com', 'https://example.com\n']) {
    assert.equal(is_markdown_link(href), false);
  }
  const html = render_markdown({ base_url, text: '# Same\n\n# Same\n\n## 中文 标题\n\n[Part](#same-1)' });
  assert.match(html, /id="same"/);
  assert.match(html, /id="same-1"/);
  assert.match(html, /id="中文-标题"/);
});

test('Markdown images resolve only within the selected document directory', () => {
  assert.equal(markdown_image_url('images/figure.png', base_url), `${base_url}images/figure.png`);
  assert.equal(markdown_image_url('figure%20one.png', base_url), `${base_url}figure%20one.png`);
  for (const image of ['https://example.com/track.png', '//example.com/a.png', 'data:image/svg+xml,a',
    'file:///private/key.png', '/work/other.png', '../private.png', '%2e%2e/private.png',
    'assets%2f..%2f..%2fprivate.png', 'assets%5c..%5cprivate.png', 'image.png?track=1', 'image%00.png']) {
    assert.equal(markdown_image_url(image, base_url), undefined, image);
  }
  const html = render_markdown({ base_url, text: '![Local](images/figure.png)\n\n![Remote](https://example.com/track.png)' });
  assert.match(html, new RegExp(`<img src="${base_url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}images/figure.png"`));
  assert.match(html, /markdown-image-unavailable">Remote/);
  assert.doesNotMatch(html, /src="https:\/\/example.com/);
});

type watcher_api = typeof import('../src/markdown_watch');

async function watch_fixture() {
  const listeners = { change: [] as Array<(file: unknown) => void>, create: [] as Array<(file: unknown) => void>, delete: [] as Array<(file: unknown) => void> };
  let disposed = false;
  const subscribe = (kind: keyof typeof listeners) => (callback: (file: unknown) => void) => {
    listeners[kind].push(callback);
    return { dispose() {} };
  };
  const vscode = {
    workspace: { createFileSystemWatcher: () => ({
      onDidChange: subscribe('change'), onDidCreate: subscribe('create'), onDidDelete: subscribe('delete'),
      dispose() { disposed = true; },
    }) },
    RelativePattern: class { constructor(readonly base: unknown, readonly pattern: string) {} },
  };
  const result = await build({ entryPoints: [path.join(__dirname, '../src/markdown_watch.ts')], bundle: true,
    write: false, platform: 'node', format: 'cjs', external: ['vscode'] });
  const module = { exports: {} };
  const require = createRequire(__filename);
  runInNewContext(result.outputFiles[0].text, {
    module, exports: module.exports, require: (id: string) => id === 'vscode' ? vscode : require(id),
    Buffer, TextDecoder, setTimeout, clearTimeout,
  });
  return { api: module.exports as watcher_api, listeners, disposed: () => disposed };
}

test('Markdown reads reject oversized or non-UTF8 input without losing valid Unicode', async () => {
  const { api } = await watch_fixture();
  const directory = await mkdtemp(path.join(tmpdir(), 'sidebar_markdown_'));
  try {
    const file = path.join(directory, 'readme.md');
    await writeFile(file, '\uFEFF# 中文 😀\n');
    assert.equal(await api.read_markdown(file), '# 中文 😀\n');
    await writeFile(file, Buffer.from([0xc3, 0x28]));
    await assert.rejects(api.read_markdown(file), /UTF-8/);
    await writeFile(file, Buffer.alloc(max_markdown_bytes + 1));
    await assert.rejects(api.read_markdown(file), /4 MiB/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Markdown watcher follows Vim atomic saves and recreation, and stops on disposal', async () => {
  const fixture = await watch_fixture();
  const directory = await mkdtemp(path.join(tmpdir(), 'sidebar_markdown_'));
  const file = path.join(directory, 'readme.md');
  const uri = { path: file, fsPath: file, toString: () => `file://${file}`, with: (change: { path: string }) => ({ path: change.path }) };
  const sources: string[] = [];
  const errors: string[] = [];
  const watch = new fixture.api.markdown_watch(uri as never, text => sources.push(text), message => errors.push(message));
  try {
    await writeFile(file, '# First');
    watch.refresh();
    await delay(450);
    assert.deepEqual(sources, ['# First']);
    const temporary = path.join(directory, '.readme.swap');
    await writeFile(temporary, '# Saved from Vim');
    await rename(temporary, file);
    fixture.listeners.delete[0](uri);
    fixture.listeners.create[0](uri);
    fixture.listeners.change[0](uri);
    await delay(450);
    assert.deepEqual(sources, ['# First', '# Saved from Vim']);
    await rm(file);
    fixture.listeners.delete[0](uri);
    await delay(450);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /last preview is kept/);
    await writeFile(file, '# Recreated');
    fixture.listeners.create[0](uri);
    await delay(450);
    assert.equal(sources.at(-1), '# Recreated');
    watch.refresh();
    watch.dispose();
    await delay(450);
    assert.equal(sources.length, 3);
    assert.equal(fixture.disposed(), true);
  } finally { watch.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('Markdown search highlights across formatting boundaries and preserves another pane ownership', async () => {
  type text_node = { textContent: string };
  class range_fixture {
    start?: { node: text_node; offset: number };
    end?: { node: text_node; offset: number };
    setStart(node: text_node, offset: number) { this.start = { node, offset }; }
    setEnd(node: text_node, offset: number) { this.end = { node, offset }; }
    getBoundingClientRect() { return { top: 30 }; }
  }
  class highlight_fixture {
    priority = 0;
    constructor(readonly ranges: range_fixture[]) {}
  }
  const nodes = ['Some  ', 'bold', '\ntext ', ' and more', '\ntext'].map(textContent => ({ textContent }));
  const text = nodes.map(node => node.textContent).join('');
  const content = { textContent: text };
  const highlights = new Map<string, highlight_fixture>();
  const document = {
    createTreeWalker() {
      let index = 0;
      return { nextNode: () => nodes[index++] };
    },
    createRange: () => new range_fixture(),
  };
  const result = await build({ entryPoints: [path.join(__dirname, '../webview/markdown_view.ts')], bundle: true,
    write: false, platform: 'node', format: 'cjs', loader: { '.css': 'empty' } });
  const module = { exports: {} };
  runInNewContext(result.outputFiles[0].text, {
    module, exports: module.exports, document, NodeFilter: { SHOW_TEXT: 4 }, CSS: { highlights },
    Highlight: class extends highlight_fixture { constructor(...ranges: range_fixture[]) { super(ranges); } },
    TextEncoder, TextDecoder, URL,
  });
  const prototype = (module.exports as { markdown_view: { prototype: object } }).markdown_view.prototype;
  const make_view = () => Object.assign(Object.create(prototype), {
    content, pane: { hidden: false }, match_ranges: [],
    viewport: { scrollTop: 0, clientHeight: 100, getBoundingClientRect: () => ({ top: 0 }) },
  }) as { select_match(match?: document_match, matches?: readonly document_match[], reveal?: boolean): void;
    pane: { hidden: boolean }; viewport: { scrollTop: number } };
  const normalized = normalize_search_text(text);
  const matches = [normalized.indexOf('bold text'), normalized.lastIndexOf('text')]
    .map((start, index) => ({ page: 0, start, end: start + (index ? 4 : 9) }));
  const first = make_view();
  first.select_match(matches[0], matches);
  const all = highlights.get('sidebar_markdown_find_all')!;
  assert.equal(all.ranges.length, 2);
  assert.equal(all.ranges[0].start!.node, nodes[0]);
  assert.equal(all.ranges[0].start!.offset, nodes[0].textContent.length);
  assert.equal(all.ranges[0].end!.node, nodes[2]);
  assert.equal(all.ranges[0].end!.offset, 5);
  assert.equal(all.ranges[1].start!.node, nodes[4]);
  assert.equal(all.ranges[1].start!.offset, 1);
  assert.equal(highlights.get('sidebar_markdown_find')!.priority, 1);
  first.viewport.scrollTop = 400;
  first.select_match(matches[0], matches, false);
  assert.equal(first.viewport.scrollTop, 400, 'Automatic reindexing keeps the current reading position');
  first.pane.hidden = true;
  first.select_match(matches[0], matches, true);
  assert.equal(first.viewport.scrollTop, 400, 'Hidden previews never navigate to a match');
  const second = make_view();
  second.select_match(matches[1], matches);
  const active = highlights.get('sidebar_markdown_find');
  first.select_match();
  assert.equal(highlights.get('sidebar_markdown_find'), active);
  assert.equal(highlights.get('sidebar_markdown_find_all')!.ranges.length, 2);
  second.select_match();
  assert.equal(highlights.size, 0);
});
