import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const bundle = build({ entryPoints: [path.resolve(__dirname, '../webview/hover_hint.ts')],
  bundle: true, write: false, platform: 'browser', format: 'cjs', loader: { '.css': 'empty' },
}).then(result => result.outputFiles[0].text);

async function fixture(test_case: { after(callback: () => void): void }) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const dom = new JSDOM(`<!doctype html><body><div id="toolbar">
    <button id="zoom" title="Zoom in"><span class="codicon"></span></button>
    <button id="reload" title="Reload PDF"><span class="codicon"></span></button>
    <button id="tab" title="Build · Right-click for actions"><span id="marker" title="rocket · Blue"></span><span id="label">Build</span></button>
    <button id="plain" title="Plain">Plain</button>
    <span id="untitled">Untitled</span></div></body>`, { pretendToBeVisual: true });
  const { window } = dom;
  Object.defineProperties(window, { innerWidth: { value: 300 }, innerHeight: { value: 200 } });
  const module = { exports: {} as typeof import('../webview/hover_hint') };
  runInNewContext(await bundle, { module, exports: module.exports, window, document: window.document,
    MutationObserver: window.MutationObserver, AbortController: window.AbortController,
    Element: window.Element, Node: window.Node,
    setTimeout: (...values: Parameters<typeof setTimeout>) => setTimeout(...values),
    clearTimeout: (value: ReturnType<typeof setTimeout>) => clearTimeout(value), Date: { now: () => Date.now() } });
  const hints = new module.exports.hover_hints();
  const element = (id: string) => window.document.getElementById(id)!;
  element('reload').getBoundingClientRect = () => new window.DOMRect(270, 180, 24, 20);
  element('zoom').getBoundingClientRect = () => new window.DOMRect(10, 10, 24, 24);
  Object.defineProperties(hints.hint, { offsetWidth: { value: 80 }, offsetHeight: { value: 22 } });
  const pointer = (type: string, id: string, related?: string) => element(id).dispatchEvent(new window.MouseEvent(type,
    { bubbles: true, relatedTarget: related ? element(related) : null }));
  const move = (from: string | undefined, to: string | undefined) => {
    if (from) pointer('pointerout', from, to);
    if (to) pointer('pointerover', to, from);
  };
  const flush = async () => { for (let index = 0; index < 5; index += 1) await Promise.resolve(); };
  test_case.after(() => { hints.dispose(); window.close(); mock.timers.reset(); });
  return { window, hints, element, move, pointer, flush, visible: () => !hints.hint.hidden, text: () => hints.hint.textContent };
}

test('hovering a titled icon shows its description after a delay and suppresses the native tooltip', async test_case => {
  const h = await fixture(test_case);
  h.move(undefined, 'zoom');
  assert.equal(h.element('zoom').hasAttribute('title'), false, 'The native tooltip cannot compete while hovered');
  assert.equal(h.visible(), false);
  mock.timers.tick(499);
  assert.equal(h.visible(), false);
  mock.timers.tick(1);
  assert.equal(h.visible(), true);
  assert.equal(h.text(), 'Zoom in');
  assert.equal(h.hints.hint.getAttribute('role'), 'tooltip');
  assert.deepEqual([h.hints.hint.style.left, h.hints.hint.style.top], ['4px', '38px'], 'Centred below the icon, clamped to the view');
  h.move('zoom', undefined);
  assert.equal(h.visible(), false);
  assert.equal(h.element('zoom').title, 'Zoom in', 'Leaving restores the title for accessibility and later updates');
});

test('neighbouring icons show immediately while a hint is warm, and flip above near the bottom edge', async test_case => {
  const h = await fixture(test_case);
  h.move(undefined, 'zoom');
  mock.timers.tick(500);
  h.move('zoom', 'reload');
  mock.timers.tick(0);
  assert.equal(h.text(), 'Reload PDF');
  assert.deepEqual([h.hints.hint.style.left, h.hints.hint.style.top], ['216px', '154px']);
  h.move('reload', undefined);
  mock.timers.tick(1000);
  h.move(undefined, 'zoom');
  mock.timers.tick(0);
  assert.equal(h.visible(), false, 'The warm period has expired');
});

test('titled children replace their parent hint and untitled children keep it', async test_case => {
  const h = await fixture(test_case);
  h.move(undefined, 'tab');
  mock.timers.tick(500);
  assert.equal(h.text(), 'Build · Right-click for actions');
  h.move('tab', 'label');
  assert.equal(h.text(), 'Build · Right-click for actions', 'The label belongs to the hovered tab');
  h.move('label', 'marker');
  mock.timers.tick(0);
  assert.equal(h.text(), 'rocket · Blue');
  assert.equal(h.element('tab').title, 'Build · Right-click for actions');
  h.move('marker', 'label');
  mock.timers.tick(0);
  assert.equal(h.text(), 'Build · Right-click for actions');
  assert.equal(h.element('marker').title, 'rocket · Blue');
});

test('clicks and keys dismiss a hint until the pointer leaves, and retitles update the visible hint', async test_case => {
  const h = await fixture(test_case);
  h.move(undefined, 'zoom');
  mock.timers.tick(500);
  h.element('zoom').title = 'Zoom in (125%)';
  await h.flush();
  assert.equal(h.text(), 'Zoom in (125%)');
  assert.equal(h.element('zoom').hasAttribute('title'), false);
  h.pointer('pointerdown', 'zoom');
  assert.equal(h.visible(), false);
  mock.timers.tick(1000);
  assert.equal(h.visible(), false, 'A clicked control stays quiet while the pointer remains');
  h.move('zoom', undefined);
  assert.equal(h.element('zoom').title, 'Zoom in (125%)');
  h.move(undefined, 'zoom');
  mock.timers.tick(500);
  assert.equal(h.visible(), true);
  h.element('zoom').dispatchEvent(new h.window.KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
  assert.equal(h.visible(), false);
});

test('fully visible labels and untitled elements get no hint; detached targets release the hint', async test_case => {
  const h = await fixture(test_case);
  h.move(undefined, 'plain');
  mock.timers.tick(500);
  assert.equal(h.visible(), false, 'Visible text needs no duplicate');
  h.move('plain', 'untitled');
  mock.timers.tick(500);
  assert.equal(h.visible(), false);
  h.move('untitled', 'reload');
  mock.timers.tick(500);
  assert.equal(h.visible(), true);
  h.element('reload').remove();
  h.pointer('pointermove', 'zoom');
  assert.equal(h.visible(), false, 'A re-rendered control no longer anchors the hint');
  h.hints.dispose();
  assert.equal(h.hints.hint.isConnected, false);
});
