import assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const bundle = build({ entryPoints: [path.resolve(__dirname, '../webview/preview_controls.ts')],
  bundle: true, write: false, platform: 'browser', format: 'cjs', loader: { '.css': 'empty' },
}).then(result => result.outputFiles[0].text);

async function fixture() {
  const dom = new JSDOM('<!doctype html><body><div id="pane"><div id="viewport"></div></div></body>');
  const { window } = dom;
  const observers: Array<{ callback: () => void; observed: unknown[]; disconnected: boolean }> = [];
  class resize_observer {
    readonly record = { callback: () => {}, observed: [] as unknown[], disconnected: false };
    constructor(callback: () => void) { this.record.callback = callback; observers.push(this.record); }
    observe(target: unknown) { this.record.observed.push(target); }
    disconnect() { this.record.disconnected = true; }
  }
  const module = { exports: {} as typeof import('../webview/preview_controls') };
  runInNewContext(await bundle, { module, exports: module.exports, document: window.document,
    WheelEvent: window.WheelEvent, ResizeObserver: resize_observer });
  const pane = window.document.getElementById('pane')!;
  const viewport = window.document.getElementById('viewport')!;
  Object.defineProperty(viewport, 'clientHeight', { value: 400 });
  const toolbar = window.document.createElement('div');
  const notice = window.document.createElement('div');
  const scrolls: ScrollToOptions[] = [];
  let changes = 0;
  const overlay = new module.exports.preview_overlay(pane, viewport, [toolbar, notice],
    () => ({ scrollBy: (options: ScrollToOptions) => { scrolls.push(options); } }), () => { changes++; });
  pane.prepend(overlay.root);
  let height = 36;
  Object.defineProperties(overlay.root, { offsetTop: { value: 6 }, offsetHeight: { get: () => height } });
  const resize = (next: number) => { height = next; observers[0].callback(); };
  return { window, pane, viewport, overlay, toolbar, notice, observers, scrolls, resize, changes: () => changes,
    close() { overlay.dispose(); window.close(); } };
}

test('the floating toolbar publishes the space it covers so documents start below it', async () => {
  const h = await fixture();
  try {
    assert.equal(h.overlay.root.className, 'preview-float');
    assert.deepEqual([...h.overlay.root.children], [h.toolbar, h.notice], 'The notice floats with the toolbar');
    assert.equal(h.observers[0].observed[0], h.overlay.root);
    h.resize(36);
    assert.equal(h.pane.style.getPropertyValue('--preview_float_space'), '48px', 'Top offset, height and gap');
    assert.equal(h.overlay.space, 48);
    assert.equal(h.changes(), 1);
    h.resize(36);
    assert.equal(h.changes(), 1, 'An unchanged size does not re-render the document');
    h.resize(66);
    assert.equal(h.overlay.space, 78, 'A wrapped toolbar or visible notice reserves more space');
    assert.equal(h.changes(), 2);
    h.resize(0);
    assert.equal(h.overlay.space, 78, 'A hidden pane keeps its last space instead of collapsing');
    h.overlay.dispose();
    assert.equal(h.observers[0].disconnected, true);
    assert.equal(h.overlay.root.isConnected, false);
  } finally { h.close(); }
});

test('wheel input over the floating toolbar scrolls the document, while modifier zoom reaches the viewport', async () => {
  const h = await fixture();
  try {
    const wheel = (init: WheelEventInit) => {
      const event = new h.window.WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
      h.toolbar.dispatchEvent(event);
      return event;
    };
    assert.equal(wheel({ deltaY: 30, deltaX: 5 }).defaultPrevented, true);
    assert.deepEqual(h.scrolls.map(scroll => [scroll.left, scroll.top]), [[5, 30]]);
    wheel({ deltaY: 2, deltaMode: 1 });
    wheel({ deltaY: 1, deltaMode: 2 });
    assert.deepEqual(h.scrolls.slice(1).map(scroll => scroll.top), [32, 400], 'Lines and pages use document units');
    const zooms: boolean[] = [];
    h.viewport.addEventListener('wheel', event => {
      zooms.push(event.ctrlKey);
      if (event.ctrlKey) event.preventDefault();
    });
    wheel({ deltaY: -10, ctrlKey: true });
    assert.deepEqual(zooms, [true]);
    assert.equal(h.scrolls.length, 3, 'A zoom gesture handled by the viewport does not also scroll');
    wheel({ deltaY: 10 });
    assert.equal(h.scrolls.length, 4);
  } finally { h.close(); }
});
