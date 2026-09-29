import assert from 'node:assert/strict';
import * as path from 'node:path';
import { runInNewContext as run_in_new_context } from 'node:vm';
import test from 'node:test';
import { build } from 'esbuild';
import type { pdf_toolbar, pdf_toolbar_callbacks, pdf_toolbar_state } from '../webview/pdf_toolbar';
import { create_dom, type dom_element } from './dom_fixture';

const bundled_toolbar = build({
  entryPoints: [path.resolve(__dirname, '../webview/pdf_toolbar.ts')], bundle: true,
  write: false, platform: 'browser', format: 'cjs', loader: { '.css': 'empty' },
}).then(result => result.outputFiles[0].text);

async function harness() {
  const dom = create_dom();
  const module = { exports: {} as { pdf_toolbar: typeof pdf_toolbar } };
  const calls: Array<{ action: keyof pdf_toolbar_callbacks; value?: unknown }> = [];
  const callbacks: pdf_toolbar_callbacks = {
    outline: () => calls.push({ action: 'outline' }),
    move: value => calls.push({ action: 'move', value }),
    zoom: value => calls.push({ action: 'zoom', value }),
    page: value => calls.push({ action: 'page', value }),
    set_zoom: value => calls.push({ action: 'set_zoom', value }),
    reload: () => calls.push({ action: 'reload' }),
    mode: value => calls.push({ action: 'mode', value }),
    dark: value => calls.push({ action: 'dark', value }),
  };
  run_in_new_context(await bundled_toolbar, { module, exports: module.exports, ...dom });
  const toolbar = new module.exports.pdf_toolbar(callbacks);
  dom.document.body.append(toolbar.root as unknown as dom_element);
  let state: pdf_toolbar_state = { page: 1, pages: 10, zoom: 'page-width', mode: 'continuous', dark: false, outline_open: false };
  const update = (change: Partial<pdf_toolbar_state>) => { state = { ...state, ...change }; toolbar.update(state); };
  update({});
  const control = (label: string) => {
    const found = dom.document.elements.find(element => ['button', 'input', 'select'].includes(element.tag)
      && element.getAttribute('aria-label') === label);
    assert.ok(found, `Missing control: ${label}`);
    return found;
  };
  return { ...dom, toolbar, calls, update, control };
}

test('PDF toolbar emits navigation and zoom actions, preserving custom zoom values', async () => {
  const h = await harness();
  for (const label of ['Toggle document outline', 'Scroll up one page', 'Scroll down one page', 'Zoom in', 'Actual size (100%)', 'Zoom out', 'Reload PDF']) {
    h.control(label).click();
  }
  assert.deepEqual(h.calls, [
    { action: 'outline' }, { action: 'move', value: -1 }, { action: 'move', value: 1 },
    { action: 'zoom', value: 1 }, { action: 'zoom', value: 0 }, { action: 'zoom', value: -1 }, { action: 'reload' },
  ]);
  const zoom = h.control('Zoom');
  const right = zoom.parentElement!.parentElement!;
  assert.ok(right.classList.contains('pdf-toolbar-right'));
  assert.deepEqual(right.children.map(child => child.className), [
    'pdf-zoom-control preview-zoom-control preview-control', 'pdf-mode-control preview-zoom-control preview-control',
    'pdf-page-control', 'icon-button', 'icon-button',
  ], 'The display mode sits beside zoom, before the page number, reload and settings');
  assert.equal(right.children[1], h.control('Display mode').parentElement);
  assert.equal(right.children[2], h.control('Page number').parentElement);
  assert.deepEqual(zoom.options.map(option => option.textContent), [
    'Fit width', 'Fit page', '25%', '50%', '75%', '100%', '125%', '150%', '200%', '300%', '400%',
  ]);
  for (const value of ['page-fit', '1.5']) { zoom.value = value; zoom.dispatch('change'); }
  assert.deepEqual(h.calls.slice(-2), [{ action: 'set_zoom', value: 'page-fit' }, { action: 'set_zoom', value: 1.5 }]);
  h.update({ zoom: 1.375 });
  assert.equal(zoom.value, '1.375');
  assert.equal(zoom.options.at(-1)!.textContent, '137.5%');
  h.update({ zoom: 1.375 });
  assert.equal(zoom.options.length, 12, 'Repeated state updates do not duplicate custom choices');
  h.update({ zoom: 1 });
  assert.equal(zoom.options.length, 11, 'A standard zoom removes the obsolete custom choice');
  h.toolbar.dispose();
});

test('PDF page input commits once for Enter/change in either order and preserves active edits', async () => {
  const h = await harness();
  const input = h.control('Page number');
  input.focus();
  input.value = '4';
  input.dispatch('input');
  h.update({ page: 2 });
  assert.equal(input.value, '4', 'Scrolling does not overwrite an in-progress page edit');
  const enter = input.dispatch('keydown', { key: 'Enter' });
  input.dispatch('change');
  assert.equal(enter.defaultPrevented, true);
  assert.deepEqual(h.calls, [{ action: 'page', value: 4 }]);
  h.update({ page: 4 });
  input.value = '7';
  input.dispatch('input');
  input.dispatch('change');
  input.dispatch('keydown', { key: 'Enter' });
  assert.deepEqual(h.calls.at(-1), { action: 'page', value: 7 });
  assert.equal(h.calls.length, 2);
  h.update({ page: 7 });
  input.value = '';
  input.dispatch('input');
  input.dispatch('change');
  assert.equal(input.value, '7');
  assert.equal(h.calls.length, 2, 'An empty input restores the current page');
  input.value = '999';
  input.dispatch('input');
  input.dispatch('keydown', { key: 'Enter' });
  assert.equal(input.value, '10');
  assert.deepEqual(h.calls.at(-1), { action: 'page', value: 10 });
  h.toolbar.dispose();
});

test('PDF display mode uses a native select and follows reader state', async () => {
  const h = await harness();
  const mode = h.control('Display mode');
  assert.equal(mode.tag, 'select');
  assert.equal(mode.value, 'continuous');
  assert.deepEqual(mode.options.map(option => [option.value, option.textContent]), [
    ['continuous', 'Continuous vertical'], ['horizontal', 'Continuous horizontal'],
    ['single', 'Single page'], ['spread', 'Two pages'],
  ]);
  for (const value of ['horizontal', 'single', 'spread', 'continuous']) {
    mode.value = value;
    mode.dispatch('change');
    assert.deepEqual(h.calls.at(-1), { action: 'mode', value });
  }
  h.update({ mode: 'horizontal' });
  assert.equal(mode.value, 'horizontal');
  assert.equal(h.calls.length, 4, 'Reader updates do not emit redundant layout changes');
  h.toolbar.dispose();
  mode.dispatch('change');
  assert.equal(h.calls.length, 4, 'Disposal removes the mode listener');
});

test('PDF settings contains only dark mode and supports keyboard navigation and dismissal', async () => {
  const h = await harness();
  const settings = h.control('PDF settings');
  const menu = h.document.elements.find(element => element.getAttribute('role') === 'menu')!;
  const dark = h.control('Dark mode');
  assert.deepEqual(menu.children, [dark]);
  assert.equal(dark.getAttribute('role'), 'menuitemcheckbox');
  assert.equal(dark.getAttribute('aria-checked'), 'false');
  settings.focus();
  settings.dispatch('keydown', { key: 'ArrowDown' });
  assert.equal(menu.hidden, false);
  assert.equal(settings.getAttribute('aria-expanded'), 'true');
  assert.equal(h.document.activeElement, dark);
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
    const event = dark.dispatch('keydown', { key });
    assert.equal(event.defaultPrevented, true);
    assert.equal(h.document.activeElement, dark, 'The only settings item retains keyboard focus');
  }
  settings.dispatch('keydown', { key: 'ArrowUp' });
  assert.equal(h.document.activeElement, dark);
  dark.click();
  assert.deepEqual(h.calls.at(-1), { action: 'dark', value: true });
  assert.equal(menu.hidden, true);
  assert.equal(h.document.activeElement, settings);
  h.update({ dark: true });
  assert.equal(dark.getAttribute('aria-checked'), 'true');
  settings.click();
  dark.click();
  assert.deepEqual(h.calls.at(-1), { action: 'dark', value: false });
  settings.click();
  const escape = dark.dispatch('keydown', { key: 'Escape' });
  assert.equal(escape.defaultPrevented, true);
  assert.equal(menu.hidden, true);
  assert.equal(h.document.activeElement, settings);
  settings.click();
  const tab = dark.dispatch('keydown', { key: 'Tab' });
  assert.equal(tab.defaultPrevented, false, 'Tab remains available to browser focus navigation');
  assert.equal(menu.hidden, true);
  settings.click();
  h.control('Page number').focus();
  assert.equal(menu.hidden, true, 'Moving focus outside closes the settings');
  settings.click();
  h.document.body.dispatch('pointerdown');
  assert.equal(menu.hidden, true, 'Clicking outside closes the settings');
  settings.click();
  h.toolbar.set_visible(false);
  assert.equal(menu.hidden, true, 'Switching away from the reader closes its body-level menu');
  assert.equal(settings.getAttribute('aria-expanded'), 'false');
  h.toolbar.set_visible(true);
  assert.equal(menu.hidden, true, 'Returning to the reader does not reopen the menu');
  h.toolbar.dispose();
  settings.click();
  h.control('Reload PDF').click();
  assert.equal(menu.parentElement, undefined);
  assert.equal(h.calls.length, 2, 'Disposal removes all action listeners');
});

test('PDF navigation boundaries follow continuous scrolling and complete spreads', async () => {
  const h = await harness();
  const previous = h.control('Scroll up one page');
  const next = h.control('Scroll down one page');
  for (const page of [1, 10]) {
    h.update({ mode: 'continuous', page });
    assert.equal(previous.disabled, false);
    assert.equal(next.disabled, false, 'The final page may still extend below the viewport');
    assert.match(previous.firstElementChild!.className, /arrow-circle-up$/);
    assert.match(next.firstElementChild!.className, /arrow-circle-down$/);
  }
  for (const page of [1, 10]) {
    h.update({ mode: 'horizontal', page });
    assert.equal(previous.disabled, false);
    assert.equal(next.disabled, false, 'The final page may still extend beyond the viewport');
    assert.match(previous.firstElementChild!.className, /arrow-circle-left$/);
    assert.match(next.firstElementChild!.className, /arrow-circle-right$/);
    assert.equal(previous.getAttribute('aria-label'), 'Scroll left one page');
    assert.equal(next.getAttribute('aria-label'), 'Scroll right one page');
  }
  h.update({ mode: 'single', page: 1 });
  assert.equal(previous.disabled, true);
  assert.equal(next.disabled, false);
  assert.equal(previous.title, 'Previous page');
  assert.equal(next.title, 'Next page');
  assert.match(previous.firstElementChild!.className, /arrow-circle-up$/);
  assert.match(next.firstElementChild!.className, /arrow-circle-down$/);
  h.update({ page: 10 });
  assert.equal(previous.disabled, false);
  assert.equal(next.disabled, true);
  for (const page of [1, 2]) {
    h.update({ mode: 'spread', page });
    assert.equal(previous.disabled, true, `The first pair has no previous spread at page ${page}`);
    assert.equal(next.disabled, false);
  }
  for (const page of [9, 10]) {
    h.update({ page });
    assert.equal(previous.disabled, false);
    assert.equal(next.disabled, true, `The final pair has no next spread at page ${page}`);
    assert.match(previous.firstElementChild!.className, /arrow-circle-up$/);
    assert.match(next.firstElementChild!.className, /arrow-circle-down$/);
    assert.equal(previous.getAttribute('aria-label'), 'Previous two pages');
    assert.equal(next.getAttribute('aria-label'), 'Next two pages');
  }
  h.update({ page: 9, pages: 9 });
  assert.equal(next.disabled, true, 'An unpaired last page is the final spread');
  h.update({ pages: 0 });
  assert.equal(previous.disabled, true);
  assert.equal(next.disabled, true);
  h.toolbar.dispose();
});
