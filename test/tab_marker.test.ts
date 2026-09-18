import assert from 'node:assert/strict';
import test from 'node:test';
import { copy_tab_marker, is_tab_marker, tab_marker_colors, tab_marker_shapes, type tab_marker } from '../src/tab_marker';
import { sidebar_tabs } from '../src/tabs';

test('tab markers accept only declared shapes and terminal theme color tokens', () => {
  for (const shape of tab_marker_shapes) {
    for (const color of tab_marker_colors) assert.equal(is_tab_marker({ shape, color }), true);
  }
  for (const marker of [undefined, null, [], '', 1, {}, { shape: 'circle' }, { color: 'ansiRed' },
    { shape: 'star', color: 'ansiBlue' }, { shape: 'circle', color: '#ff0000' },
    { shape: 'circle', color: 'red' }, { shape: 'circle', color: 'ansiRed', command: 'unsafe' },
    { shape: 'circle', color: 'ansiRed; background: url(x)' }, Object.create({ shape: 'circle', color: 'ansiRed' }),
  ]) assert.equal(is_tab_marker(marker), false);
  const original: tab_marker = { shape: 'hexagon', color: 'ansiBrightCyan' };
  const copy = copy_tab_marker(original);
  copy.shape = 'square';
  assert.equal(original.shape, 'hexagon');
});

test('startup and temporary tab markers persist locally and remain isolated from every caller', () => {
  const profiles = [{ id: 'profile', name: 'Shell', command: '', shell: '' }];
  const model = new sidebar_tabs(profiles);
  const startup_id = model.tabs[0].id;
  const temporary_id = model.add_tab().id;
  const startup_marker: tab_marker = { shape: 'circle', color: 'ansiBlue' };
  const temporary_marker: tab_marker = { shape: 'diamond', color: 'ansiBrightYellow' };
  assert.equal(model.set_marker(startup_id, startup_marker), true);
  assert.equal(model.set_marker(temporary_id, temporary_marker), true);
  startup_marker.shape = 'hexagon';
  temporary_marker.color = 'ansiRed';
  model.tabs[0].marker!.color = 'ansiBlack';
  model.open_profile(profiles[0]).marker!.color = 'ansiWhite';
  assert.deepEqual(model.tabs[0].marker, { shape: 'circle', color: 'ansiBlue' });
  assert.deepEqual(model.tabs[1].marker, { shape: 'diamond', color: 'ansiBrightYellow' });
  assert.equal(Object.hasOwn(profiles[0], 'marker'), false);

  const memory = model.remember();
  const restored = new sidebar_tabs(profiles, memory);
  assert.deepEqual(restored.tabs, model.tabs);
  memory.tabs[0].marker!.shape = 'triangle';
  assert.deepEqual(model.tabs[0].marker, { shape: 'circle', color: 'ansiBlue' });
  assert.deepEqual(restored.tabs[0].marker, { shape: 'circle', color: 'ansiBlue' });
  restored.tabs[1].marker!.shape = 'square';
  assert.deepEqual(restored.tabs[1].marker, { shape: 'diamond', color: 'ansiBrightYellow' });
});

test('marker reset and no-op changes do not affect tab identity, names, order, or startup settings', () => {
  const model = new sidebar_tabs([]);
  const first = model.add_tab();
  const second = model.add_tab();
  const marker: tab_marker = { shape: 'square', color: 'ansiGreen' };
  assert.equal(model.set_marker(first.id, undefined), false);
  assert.equal(model.set_marker('missing', marker), false);
  assert.equal(model.set_marker(first.id, marker), true);
  assert.equal(model.set_marker(first.id, { ...marker }), false);
  const before = model.remember();
  assert.equal(model.set_marker(first.id, { shape: 'star', color: 'ansiRed' } as unknown as tab_marker), false);
  assert.deepEqual(model.remember(), before);
  assert.equal(model.set_marker(first.id, undefined), true);
  assert.equal(model.set_marker(first.id, undefined), false);
  assert.equal(Object.hasOwn(model.tabs[0], 'marker'), false);
  assert.equal(Object.hasOwn(model.remember().tabs[0], 'marker'), false);
  assert.deepEqual(model.tabs, [first, second]);
  assert.deepEqual(new sidebar_tabs([], model.remember()).tabs, [first, second]);
});

test('additional marker shapes retain their shape and theme color after restoring workspace memory', () => {
  for (const shape of ['triangle_down', 'triangle_left', 'triangle_right', 'heart'] as const) {
    const model = new sidebar_tabs([]);
    const tab = model.add_tab();
    const marker: tab_marker = { shape, color: 'ansiBrightCyan' };
    assert.equal(model.set_marker(tab.id, marker), true);
    const restored = new sidebar_tabs([], model.remember());
    assert.deepEqual(restored.tabs[0].marker, marker);
  }
});

test('older memory and malformed marker fields retain otherwise valid tabs', () => {
  for (const marker of [undefined, null, false, 'ansiBlue', { shape: 'circle', color: 'invalid' },
    { shape: 'triangle', color: 'ansiBlue', extra: true },
  ]) {
    const model = new sidebar_tabs([], {
      version: 1, tabs: [{ id: 'saved', name: 'Original', ...(marker === undefined ? {} : { marker }) }],
      active_id: 'saved', expanded_ids: ['saved'], next_number: 1,
    });
    assert.deepEqual(model.tabs, [{ id: 'saved', name: 'Original', command: '', shell: '' }]);
    assert.equal(model.active_id, 'saved');
    assert.deepEqual(model.expanded_ids, ['saved']);
    assert.equal(Object.hasOwn(model.remember().tabs[0], 'marker'), false);
  }
});
