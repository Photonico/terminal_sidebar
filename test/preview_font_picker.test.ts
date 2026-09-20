import assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { is_client_message } from '../src/profiles';

const bundle = build({ entryPoints: [path.resolve(__dirname, '../webview/preview_font_picker.ts')],
  bundle: true, write: false, platform: 'browser', format: 'cjs', loader: { '.css': 'empty' },
}).then(result => result.outputFiles[0].text);

async function fixture() {
  const dom = new JSDOM('<!doctype html><body><button id="anchor">Font</button><button id="outside">Outside</button></body>');
  const module = { exports: {} as typeof import('../webview/preview_font_picker') };
  runInNewContext(await bundle, { module, exports: module.exports, window: dom.window,
    document: dom.window.document, AbortController: dom.window.AbortController });
  const selections: string[] = [];
  const picker = new module.exports.preview_font_picker(font => selections.push(font));
  const anchor = dom.window.document.querySelector<HTMLButtonElement>('#anchor')!;
  anchor.getBoundingClientRect = () => new dom.window.DOMRect(240, 76, 24, 24);
  Object.defineProperties(picker.root, { offsetWidth: { value: 260 }, offsetHeight: { value: 220 } });
  const option = (label: string) => picker.root.querySelector<HTMLButtonElement>(`[role="menuitemradio"][aria-label="${label}"]`)!;
  return { dom, picker, anchor, selections, option,
    close() { picker.dispose(); dom.window.close(); } };
}

test('font choices are anchored, start with Default and separator, and follow synced selection', async () => {
  const h = await fixture();
  try {
    h.picker.toggle(h.anchor);
    const menu = h.picker.root.querySelector('[role="menu"]')!;
    assert.equal(menu.children[0].getAttribute('aria-label'), 'Default');
    assert.equal(menu.children[1].getAttribute('role'), 'separator');
    assert.equal(h.picker.root.style.left, '4px');
    assert.equal(h.picker.root.style.top, '104px');
    assert.equal(h.anchor.getAttribute('aria-expanded'), 'true');
    assert.equal(h.option('Default').getAttribute('aria-checked'), 'true');
    h.picker.set_font('serif');
    assert.equal(h.option('Default').getAttribute('aria-checked'), 'false');
    assert.equal(h.option('Serif').getAttribute('aria-checked'), 'true');
    h.option('Monospace').click();
    assert.deepEqual(h.selections, ['monospace']);
    assert.equal(h.picker.root.hidden, true);
    assert.equal(h.dom.window.document.activeElement, h.anchor);
    h.picker.set_font('Georgia, serif');
    h.picker.toggle(h.anchor);
    assert.equal(h.option('Custom font…').getAttribute('aria-checked'), 'true');
    assert.equal(h.picker.root.querySelector('input')!.value, 'Georgia, serif');
  } finally { h.close(); }
});

test('inline custom font rejects unsafe text and sends a trimmed Unicode font list', async () => {
  const h = await fixture();
  try {
    h.picker.toggle(h.anchor);
    h.option('Custom font…').click();
    const form = h.picker.root.querySelector('form')!;
    const input = h.picker.root.querySelector('input')!;
    const submit = () => form.dispatchEvent(new h.dom.window.Event('submit', { cancelable: true }));
    assert.equal(form.hidden, false);
    assert.equal(h.dom.window.document.activeElement, input);
    for (const invalid of ['', 'Arial; color:red', 'url(https://font.test)', 'x'.repeat(257), '123', 'Georgia,,serif', 'Georgia,']) {
      input.value = invalid;
      input.dispatchEvent(new h.dom.window.Event('input'));
      submit();
      assert.equal(h.selections.length, 0);
      assert.equal(form.querySelector('button')!.disabled, true);
    }
    input.value = '  Georgia, "思源宋体", serif  ';
    input.dispatchEvent(new h.dom.window.Event('input'));
    assert.equal(form.querySelector('button')!.disabled, false);
    submit();
    assert.deepEqual(h.selections, ['Georgia, "思源宋体", serif']);
    assert.equal(h.picker.root.hidden, true);
  } finally { h.close(); }
});

test('font popover supports keyboard navigation, Escape, outside dismissal and disposal', async () => {
  const h = await fixture();
  try {
    const key = (value: string) => h.dom.window.document.activeElement?.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', {
      key: value, bubbles: true, cancelable: true,
    }));
    h.picker.toggle(h.anchor);
    key('ArrowDown'); assert.equal(h.dom.window.document.activeElement, h.option('Editor font'));
    key('End'); assert.equal(h.dom.window.document.activeElement, h.option('Custom font…'));
    key('Escape'); assert.equal(h.picker.root.hidden, true);
    assert.equal(h.dom.window.document.activeElement, h.anchor);
    h.picker.toggle(h.anchor);
    h.dom.window.document.querySelector<HTMLElement>('#outside')!.focus();
    assert.equal(h.picker.root.hidden, true);
    h.picker.toggle(h.anchor);
    h.dom.window.document.body.dispatchEvent(new h.dom.window.Event('pointerdown', { bubbles: true }));
    assert.equal(h.picker.root.hidden, true);
    h.picker.toggle(h.anchor);
    const option = h.option('Serif');
    h.picker.dispose(); option.click();
    assert.deepEqual(h.selections, []);
    assert.equal(h.picker.root.isConnected, false);
    assert.equal(h.anchor.getAttribute('aria-expanded'), 'false');
  } finally { h.close(); }
});

test('font update messages reject malformed names before reaching VS Code settings', () => {
  for (const font of ['default', 'editor', 'serif', 'Georgia, "思源宋体", serif', '"123", serif']) {
    assert.equal(is_client_message({ type: 'set_preview_font', id: 'md_1', font }), true);
  }
  for (const font of [null, 1, '', '  ', 'font; color:red', 'a'.repeat(257), '123', 'Georgia,,serif', 'Georgia,']) {
    assert.equal(is_client_message({ type: 'set_preview_font', id: 'md_1', font }), false);
  }
  assert.equal(is_client_message({ type: 'set_preview_font', id: '', font: 'default' }), false);
  assert.equal(is_client_message({ type: 'choose_preview_font', id: 'md_1' }), false);
});
