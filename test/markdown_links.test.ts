import assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import type { client_message, markdown_tab } from '../src/types';

const bundled_view = build({ entryPoints: [path.join(__dirname, '../webview/markdown_view.ts')],
  bundle: true, write: false, platform: 'node', format: 'cjs', loader: { '.css': 'empty' },
}).then(result => result.outputFiles[0].text);

async function fixture(text: string) {
  const dom = new JSDOM('<!doctype html><body><span id="status-text">Idle</span></body>', { pretendToBeVisual: true });
  const module = { exports: {} as typeof import('../webview/markdown_view') };
  runInNewContext(await bundled_view, { module, exports: module.exports,
    document: dom.window.document, window: dom.window, NodeFilter: dom.window.NodeFilter,
    AbortController: dom.window.AbortController, Element: dom.window.Element, TextEncoder, TextDecoder, URL,
    setTimeout, clearTimeout, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
  const messages: client_message[] = [];
  const tab: markdown_tab = { kind: 'markdown', id: 'md_links', name: 'notes.md', uri: 'file:///work/notes.md', scroll: 0 };
  const view = new module.exports.markdown_view(tab, message => messages.push(message));
  dom.window.document.body.prepend(view.pane);
  view.load({ base_url: 'https://file+.vscode-resource.vscode-cdn.net/work/', text });
  const scrolled: string[] = [];
  dom.window.HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) { scrolled.push(this.id); };
  const viewport = view.pane.querySelector<HTMLElement>('.markdown-viewport')!;
  const click = (label: string) => {
    const link = [...view.pane.querySelectorAll('.markdown-content a')].find(anchor => anchor.textContent === label);
    assert.ok(link, `Missing link ${label}`);
    let reached_window = false;
    const listener = () => { reached_window = true; };
    dom.window.addEventListener('click', listener);
    const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    dom.window.removeEventListener('click', listener);
    return { prevented: event.defaultPrevented, reached_window };
  };
  return { dom, view, viewport, messages, scrolled, click, close() { view.dispose(); dom.window.close(); } };
}

const document_text = `# Notes

- [Slug](#target-section)
- [Heading text](#Target%20Section)
- [Upper case](#TARGET-SECTION)
- [Missing](#no-such-heading)
- [Top](#top)
- [Web](https://example.com/paper)
- [Mail](mailto:author@example.com)
- [Sibling](chapter.md#intro)
- Footnote[^1]

## Target Section

## Status text

[^1]: A note.
`;

test('Markdown fragments find headings by id, text, slug or letter case, and missing ones do nothing', async () => {
  const h = await fixture(document_text);
  try {
    for (const label of ['Slug', 'Heading text', 'Upper case']) {
      assert.deepEqual(h.click(label), { prevented: true, reached_window: false }, `${label} is handled only by the preview`);
    }
    assert.deepEqual(h.scrolled, ['user-content-target-section', 'user-content-target-section', 'user-content-target-section']);
    const footnote = h.view.pane.querySelector<HTMLAnchorElement>('.markdown-content sup a')!;
    footnote.dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    assert.match(h.scrolled.at(-1) ?? '', /footnote/, 'Footnote references reach their note');
    h.click('Missing');
    assert.equal(h.scrolled.length, 4);
    h.viewport.scrollTop = 300;
    h.click('Top');
    assert.equal(h.viewport.scrollTop, 0);
    assert.equal(h.messages.filter(message => message.type === 'open_markdown_link').length, 0,
      'Fragments never ask the host to open the source file');
    assert.equal(h.dom.window.document.getElementById('status-text')?.textContent, 'Idle',
      'A heading named like a sidebar element does not take over its id');
  } finally { h.close(); }
});

test('Markdown web and mail links reach VS Code once, while relative files go to the extension host', async () => {
  const h = await fixture(document_text);
  try {
    for (const label of ['Web', 'Mail']) {
      assert.deepEqual(h.click(label), { prevented: false, reached_window: true },
        `${label} is left to the webview's own link handling, which opens it without a trust prompt`);
    }
    assert.deepEqual(h.click('Sibling'), { prevented: true, reached_window: false });
    assert.equal(JSON.stringify(h.messages.filter(message => message.type === 'open_markdown_link')),
      JSON.stringify([{ type: 'open_markdown_link', id: 'md_links', href: 'chapter.md#intro' }]));
  } finally { h.close(); }
});
