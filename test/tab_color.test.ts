import assert from 'node:assert/strict';
import test from 'node:test';
import { is_client_message } from '../src/profiles';
import { is_tab_color, tab_colors, type tab_color } from '../src/tab_color';
import { sidebar_tabs } from '../src/tabs';

test('tab name colors and protocol accept only declared terminal theme color tokens', () => {
  for (const color of tab_colors) {
    assert.equal(is_tab_color(color), true);
    assert.equal(is_client_message({ type: 'set_tab_color', id: 'tab_0', color }), true);
  }
  for (const color of [undefined, null, [], '', 1, {}, { color: 'ansiRed' }, '#ff0000', 'red',
    'ansiRed; background: url(x)', new String('ansiBlue')]) {
    assert.equal(is_tab_color(color), false);
    assert.equal(is_client_message({ type: 'set_tab_color', id: 'tab_0', color }), color === undefined);
  }
  assert.equal(is_client_message({ type: 'set_tab_color', id: 'tab_0' }), true);
  assert.equal(is_client_message({ type: 'set_tab_color', id: '../tab', color: 'ansiBlue' }), false);
  assert.equal(is_client_message({ type: 'set_tab_marker', id: 'tab_0', marker: { shape: 'circle', color: 'ansiBlue' } }), false);
});

test('startup and temporary tab colors persist locally and snapshots remain isolated', () => {
  const profiles = [{ id: 'profile', name: 'Shell', command: '', shell: '' }];
  const model = new sidebar_tabs(profiles);
  const startup_id = model.tabs[0].id;
  const temporary_id = model.add_tab().id;
  assert.equal(model.set_color(startup_id, 'ansiBlue'), true);
  assert.equal(model.set_color(temporary_id, 'ansiBrightYellow'), true);
  model.tabs[0].name_color = 'ansiBlack';
  model.open_profile(profiles[0]).name_color = 'ansiWhite';
  assert.equal(model.tabs[0].name_color, 'ansiBlue');
  assert.equal(model.tabs[1].name_color, 'ansiBrightYellow');
  assert.equal(Object.hasOwn(profiles[0], 'name_color'), false);

  const memory = model.remember();
  const restored = new sidebar_tabs(profiles, memory);
  assert.deepEqual(restored.tabs, model.tabs);
  memory.tabs[0].name_color = 'ansiGreen';
  assert.equal(model.tabs[0].name_color, 'ansiBlue');
  assert.equal(restored.tabs[0].name_color, 'ansiBlue');
  restored.tabs[1].name_color = 'ansiRed';
  assert.equal(restored.tabs[1].name_color, 'ansiBrightYellow');
});

test('color reset and invalid changes preserve tab identity, names, order, and startup settings', () => {
  const model = new sidebar_tabs([]);
  const first = model.add_tab();
  const second = model.add_tab();
  assert.equal(model.set_color(first.id, undefined), false);
  assert.equal(model.set_color('missing', 'ansiGreen'), false);
  assert.equal(model.set_color(first.id, 'ansiGreen'), true);
  assert.equal(model.set_color(first.id, 'ansiGreen'), false);
  const before = model.remember();
  assert.equal(model.set_color(first.id, 'red' as tab_color), false);
  assert.deepEqual(model.remember(), before);
  assert.equal(model.set_color(first.id, undefined), true);
  assert.equal(model.set_color(first.id, undefined), false);
  assert.equal(Object.hasOwn(model.tabs[0], 'name_color'), false);
  assert.equal(Object.hasOwn(model.remember().tabs[0], 'name_color'), false);
  assert.deepEqual(model.tabs, [first, second]);
  assert.deepEqual(new sidebar_tabs([], model.remember()).tabs, [first, second]);
});

test('each theme color survives workspace reload independently of other tabs', () => {
  const model = new sidebar_tabs([]);
  for (const color of tab_colors) assert.equal(model.set_color(model.add_tab().id, color), true);
  const restored = new sidebar_tabs([], model.remember());
  assert.deepEqual(restored.tabs.map(tab => tab.name_color), tab_colors);
  restored.set_color(restored.tabs[0].id, undefined);
  assert.deepEqual(restored.tabs.slice(1).map(tab => tab.name_color), tab_colors.slice(1));
});

const legacy_shapes = ['circle', 'triangle', 'triangle_right', 'triangle_down', 'triangle_left', 'diamond', 'square'];

function saved_tab(fields: Record<string, unknown> = {}) {
  return {
    version: 1, tabs: [{ id: 'saved', name: 'Original', ...fields }],
    active_id: 'saved', expanded_ids: ['saved'], next_number: 1,
  };
}

test('valid legacy markers migrate only their color and resetting cannot resurrect them', () => {
  for (const shape of legacy_shapes) {
    const memory = saved_tab({ marker: { shape, color: 'ansiBrightCyan' } });
    const model = new sidebar_tabs([], memory);
    assert.equal(model.tabs[0].name_color, 'ansiBrightCyan');
    assert.equal(Object.hasOwn(model.tabs[0], 'marker'), false);
    assert.equal(Object.hasOwn(model.remember().tabs[0], 'marker'), false);
    assert.deepEqual(new sidebar_tabs([], model.remember()).tabs, model.tabs);
    model.set_color('saved', undefined);
    assert.equal(new sidebar_tabs([], model.remember()).tabs[0].name_color, undefined);
    assert.deepEqual(memory, saved_tab({ marker: { shape, color: 'ansiBrightCyan' } }));
  }
});

test('explicit new color fields take precedence over legacy data even when invalid', () => {
  const marker = { shape: 'circle', color: 'ansiBlue' };
  for (const name_color of ['ansiGreen', undefined, null, false, '', '#ff0000', { color: 'ansiRed' }]) {
    const model = new sidebar_tabs([], saved_tab({ marker, name_color }));
    assert.equal(model.tabs[0].name_color, name_color === 'ansiGreen' ? 'ansiGreen' : undefined);
    assert.equal(Object.hasOwn(model.remember().tabs[0], 'marker'), false);
  }
});

test('older memory and malformed legacy marker fields retain otherwise valid tabs', () => {
  for (const marker of [undefined, null, false, 'ansiBlue', { shape: 'circle', color: 'invalid' },
    { shape: 'triangle', color: 'ansiBlue', extra: true },
    { shape: 'heart', color: 'ansiBlue' }, { shape: 'music_note', color: 'ansiBlue' },
    { shape: 'pentagon_right', color: 'ansiBlue' }, { shape: 'hexagon', color: 'ansiBlue' },
    Object.create({ shape: 'circle', color: 'ansiBlue' }),
  ]) {
    const model = new sidebar_tabs([], saved_tab({ marker }));
    assert.deepEqual(model.tabs, [{ id: 'saved', name: 'Original', command: '', shell: '' }]);
    assert.equal(model.active_id, 'saved');
    assert.deepEqual(model.expanded_ids, ['saved']);
    assert.equal(Object.hasOwn(model.remember().tabs[0], 'marker'), false);
  }
});
