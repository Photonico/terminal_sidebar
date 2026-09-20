import assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const bundle = build({ entryPoints: [path.resolve(__dirname, '../webview/reading_toolbar.ts')],
  bundle: true, write: false, platform: 'browser', format: 'cjs', loader: { '.css': 'empty' },
}).then(result => result.outputFiles[0].text);

async function fixture(format = 'markdown') {
  const dom = new JSDOM('<!doctype html><body></body>');
  const module = { exports: {} as typeof import('../webview/reading_toolbar') };
  runInNewContext(await bundle, { module, exports: module.exports,
    document: dom.window.document, AbortController: dom.window.AbortController });
  const moves: number[] = [];
  const zooms: number[] = [];
  const toolbar = new module.exports.reading_toolbar(format, {
    move: direction => moves.push(direction), zoom: value => zooms.push(value), height: () => 500,
  }, [{ label: 'Reload preview', icon: 'refresh', run() {} }]);
  dom.window.document.body.append(toolbar.root, toolbar.outline);
  const control = (label: string) => {
    const result = toolbar.root.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
    assert.ok(result, `Missing control ${label}`);
    return result;
  };
  return { dom, toolbar, moves, zooms, control,
    close() { toolbar.dispose(); dom.window.close(); } };
}

test('document toolbar scrolls, zooms and restores actual size with labels on every action', async () => {
  const h = await fixture();
  try {
    assert.equal(h.toolbar.root.querySelector('.document-badge')?.parentElement?.firstElementChild?.className, 'document-badge');
    assert.doesNotMatch(h.toolbar.root.textContent ?? '', /Markdown preview|Source preview/);
    h.control('Scroll up one page').click();
    h.control('Scroll down one page').click();
    assert.deepEqual(h.moves, [-1, 1]);
    h.control('Zoom in').click();
    h.control('Zoom out').click();
    const select = h.control('Zoom') as unknown as HTMLSelectElement;
    select.value = '2'; select.dispatchEvent(new h.dom.window.Event('change'));
    h.control('Actual size (100%)').click();
    assert.deepEqual(h.zooms, [1.2, 1, 2, 1]);
    assert.equal(select.value, '1');
    assert.equal(select.options.length, 9, 'Temporary wheel/button percentages are removed when selecting a standard value');
    for (const button of h.toolbar.root.querySelectorAll('button')) {
      assert.ok(button.title);
      assert.equal(button.getAttribute('aria-label'), button.title);
    }
    assert.deepEqual([...h.toolbar.root.querySelectorAll('svg circle')].map(circle => circle.getAttribute('r')), ['6.5', '6.5', '6.5']);
    const zoom = h.control('Zoom in');
    h.toolbar.dispose(); zoom.click();
    assert.equal(h.zooms.length, 4, 'Detached toolbar controls do not keep action listeners');
  } finally { h.close(); }
});

test('reader zoom shortcuts leave ordinary typing and scrolling alone and clamp modifier-wheel zoom', async () => {
  const h = await fixture('json');
  try {
    assert.equal(h.toolbar.root.querySelector('[aria-label="Toggle document outline"]'), null);
    const key = (key: string, modifiers: KeyboardEventInit = {}) => new h.dom.window.KeyboardEvent('keydown', { key, cancelable: true, ...modifiers });
    assert.equal(h.toolbar.keydown(key('+')), false);
    assert.equal(h.toolbar.keydown(key('+', { ctrlKey: true, isComposing: true })), false);
    const bigger = key('=', { metaKey: true });
    assert.equal(h.toolbar.keydown(bigger), true);
    assert.equal(bigger.defaultPrevented, true);
    assert.equal(h.zooms.at(-1), 1.2);
    const plain = new h.dom.window.WheelEvent('wheel', { deltaY: 100, cancelable: true });
    h.toolbar.wheel(plain);
    assert.equal(plain.defaultPrevented, false);
    for (let step = 0; step < 5; step++) {
      h.toolbar.wheel(new h.dom.window.WheelEvent('wheel', { ctrlKey: true, deltaY: -1e6, cancelable: true }));
    }
    assert.equal(h.zooms.at(-1), 4);
    for (let step = 0; step < 5; step++) {
      h.toolbar.wheel(new h.dom.window.WheelEvent('wheel', { metaKey: true, deltaY: 1, deltaMode: 2, cancelable: true }));
    }
    assert.equal(h.zooms.at(-1), 0.25);
    h.toolbar.keydown(key('0', { ctrlKey: true }));
    assert.equal(h.zooms.at(-1), 1);
  } finally { h.close(); }
});

test('outline follows current document headings and preserves zoom after a refresh', async () => {
  const h = await fixture('html');
  try {
    const content = h.dom.window.document.createElement('article');
    content.innerHTML = '<h1>First</h1><h2>Child</h2>';
    const visited: string[] = [];
    for (const heading of content.querySelectorAll<HTMLElement>('h1,h2')) heading.scrollIntoView = () => visited.push(heading.textContent!);
    h.toolbar.set_content(content);
    const outline = h.control('Toggle document outline');
    assert.equal(outline.disabled, false);
    outline.click();
    assert.equal(h.toolbar.outline.hidden, false);
    (h.toolbar.outline.lastElementChild as HTMLButtonElement).click();
    assert.deepEqual(visited, ['Child']);
    h.control('Zoom in').click();
    content.replaceChildren();
    h.toolbar.set_content(content);
    assert.equal(h.zooms.at(-1), 1.2, 'New content receives the current reader scale');
    assert.equal(outline.disabled, true);
    assert.equal(outline.getAttribute('aria-expanded'), 'false');
    assert.equal(h.toolbar.outline.hidden, true);
    assert.equal(h.toolbar.outline.children.length, 0, 'Obsolete headings are released');
  } finally { h.close(); }
});
