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
import { normalize_search_text } from '../webview/document_search';

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
  assert.match(html, /<h1 id="user-content-heading">Heading<\/h1>/, 'Heading ids cannot collide with the sidebar\'s own elements');
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
  assert.match(html, /id="user-content-same"/);
  assert.match(html, /id="user-content-same-1"/);
  assert.match(html, /id="user-content-中文-标题"/);
  assert.match(render_markdown({ base_url, text: '## Status text' }), /id="user-content-status-text"/,
    'A heading named like the status badge keeps its own id');
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

test('Markdown supports task lists, footnotes, autolinks and the ordinary GFM blocks', () => {
  const html = render_markdown({ base_url, text: [
    '> Quoted **text**', '', '- [x] Completed', '- [ ] Pending', '',
    '1. First', '2. Second', '', '~~Removed~~ and https://example.com/path.', '',
    'A footnote[^note].', '', '[^note]: Footnote with *emphasis*.', '', '---',
  ].join('\n') });
  assert.match(html, /<blockquote>/);
  assert.match(html, /<ol>/);
  assert.match(html, /<s>Removed<\/s>/);
  assert.match(html, /type="checkbox"[^>]*checked="checked"[^>]*disabled="disabled"/);
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 2);
  assert.match(html, /href="https:\/\/example.com\/path"/);
  assert.match(html, /class="footnote-ref"/);
  assert.match(html, /Footnote with <em>emphasis<\/em>/);
  assert.match(html, /<hr>/);
});

test('Markdown renders inline, same-line display, multiline and bracket math without duplicate search text', () => {
  const html = render_markdown({ base_url, text: [
    'Before $f=ma$ after.', '', '$$F=ma$$', '', '$$', '\\frac{a}{b}', '$$', '',
    '\\(x+y\\)', '', '\\[z^2\\]', '', '```math', '\\sqrt{2}', '```',
  ].join('\n') });
  assert.equal((html.match(/role="math"/g) ?? []).length, 6);
  assert.equal((html.match(/class="katex-display"/g) ?? []).length, 4);
  assert.doesNotMatch(html, /<annotation|<math\b|katex-mathml|markdown_math_error/);
  const text = normalize_search_text(html.replace(/<[^>]*>/g, ''));
  assert.match(text, /Before f=ma after/);
  assert.equal((text.match(/f=ma/g) ?? []).length, 1, 'Search indexes a formula once');
  assert.equal((text.match(/F=ma/g) ?? []).length, 1);
});

test('Markdown leaves escaped dollars and ordinary code literal, including currency', () => {
  const html = render_markdown({ base_url, text: [
    'The price is $5 or $10. Escaped: \\$f=ma\\$.', '',
    '`$f=ma$`', '', '```tex', '$$F=ma$$', '```', '', '    $x+y$',
  ].join('\n') });
  assert.doesNotMatch(html, /role="math"|class="katex/);
  assert.match(html, /<code>\$f=ma\$<\/code>/);
  assert.match(html, /<code class="language-tex">\$\$F=ma\$\$/);
  assert.match(html, /The price is \$5 or \$10/);
});

test('Markdown math denies resource loading and HTML commands and contains invalid formulas', () => {
  const html = render_markdown({ base_url, text: [
    '$\\href{javascript:alert(1)}{click}$', '',
    '$\\includegraphics{https://example.com/tracker.png}$', '',
    '$\\htmlClass{injected}{x}$', '',
    '$\\unknown{<img src=x onerror=alert(1)>}$', '',
    '$\\def\\loop{\\loop}\\loop$', '',
    'After error **still renders**. $z=1$',
  ].join('\n') });
  assert.doesNotMatch(html, /<(?:script|img|a)\b|class="injected"/);
  assert.match(html, /markdown_math_error/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /After error <strong>still renders<\/strong>/);
  assert.match(html, /aria-label="z=1"/);
});

test('Markdown math has per-expression and per-document work limits', () => {
  const oversized = render_markdown({ base_url, text: `$${'x+'.repeat(9_000)}y$\n\nEnd.` });
  assert.match(oversized, /markdown_math_error/);
  assert.doesNotMatch(oversized, /class="katex"/);
  assert.match(oversized, /<p>End\.<\/p>/);
  const many = render_markdown({ base_url, text: Array(514).fill('$x$').join('\n\n') });
  assert.equal((many.match(/class="katex"/g) ?? []).length, 512);
  assert.equal((many.match(/markdown_math_error/g) ?? []).length, 2);
  assert.match(render_markdown({ base_url, text: '$x$' }), /class="katex"/, 'Each document gets a fresh work budget');
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
