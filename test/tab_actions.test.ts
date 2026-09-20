import assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const bundle = build({ stdin: { contents: "export { tab_actions } from './webview/tab_actions'; export { terminal_menu } from './webview/menu';", resolveDir: path.resolve(__dirname, '..') },
  bundle: true, write: false, platform: 'browser', format: 'cjs',
}).then(result => result.outputFiles[0].text);

async function fixture() {
  const dom = new JSDOM('<!doctype html><body></body>');
  const module = { exports: {} as typeof import('../webview/tab_actions') & typeof import('../webview/menu') };
  runInNewContext(await bundle, { module, exports: module.exports, document: dom.window.document,
    window: dom.window, Node: dom.window.Node, AbortController: dom.window.AbortController });
  const calls: string[] = [];
  const menu = new module.exports.terminal_menu();
  const names = ['create', 'preview', 'find', 'find_all', 'close', 'close_all'] as const;
  const actions = Object.fromEntries(names.map(name => [name, () => calls.push(name)])) as unknown as import('../webview/tab_actions').tab_action_handlers;
  const toolbar = new module.exports.tab_actions(menu, actions);
  dom.window.document.body.append(toolbar.root);
  const buttons = [...toolbar.root.querySelectorAll('button')];
  return { dom, menu, toolbar, calls, buttons,
    context(index: number) {
      buttons[index]!.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      return [...dom.window.document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    },
    close() { menu.dispose(); dom.window.close(); },
  };
}

test('child toolbar keeps New, Search, Close order with functional hover hints and matching clicks', async () => {
  const h = await fixture();
  try {
    assert.deepEqual(h.buttons.map(button => button.getAttribute('aria-label')),
      ['New terminal', 'Find in active tab', 'Close active tab']);
    h.toolbar.update(true, true, false);
    h.buttons.forEach(button => { assert.match(button.title, /Right-click/); button.click(); });
    assert.deepEqual(h.calls, ['create', 'find', 'close']);
    h.toolbar.update(false, true, false);
    h.buttons.forEach(button => button.click());
    assert.deepEqual(h.calls, ['create', 'find', 'close', 'close'], 'Untrusted workspace can close tabs but cannot create or search');
    h.toolbar.update(true, false, false);
    h.buttons.forEach(button => button.click());
    assert.equal(h.calls.at(-1), 'create');
    h.toolbar.update(true, true, true);
    assert.ok(h.buttons.every(button => button.disabled));
  } finally { h.close(); }
});

test('right-click menus route each alternative and keyboard dismissal returns focus to its button', async () => {
  const h = await fixture();
  try {
    const expectations = [
      ['New terminal', 'Preview in Sidebar Terminal'],
      ['Find in active tab', 'Find in all open tabs'],
      ['Close active tab', 'Close all open tabs'],
    ];
    for (let index = 0; index < 3; index++) {
      const items = h.context(index);
      assert.deepEqual(items.map(item => item.textContent), expectations[index]);
      assert.ok(items.every(item => item.title === item.textContent));
      items[1]!.click();
    }
    assert.deepEqual(h.calls, ['preview', 'find_all', 'close_all']);
    const items = h.context(0);
    assert.equal(h.dom.window.document.activeElement, items[0]);
    items[0]!.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert.equal(h.dom.window.document.activeElement, items[1]);
    items[1]!.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(h.dom.window.document.activeElement, h.buttons[0]);
    let leaked = false;
    h.toolbar.root.addEventListener('keydown', () => { leaked = true; });
    h.buttons[2]!.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
    assert.equal(leaked, false, 'Button context menus cannot be intercepted by parent tab handlers');
    const close_items = [...h.dom.window.document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    assert.deepEqual(close_items.map(item => item.textContent), expectations[2]);
  } finally { h.close(); }
});
