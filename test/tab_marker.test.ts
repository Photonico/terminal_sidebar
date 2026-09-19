import assert from 'node:assert/strict';
import test from 'node:test';
import { codicon_names } from '../src/codicons';
import { is_client_message } from '../src/profiles';
import { is_tab_color, tab_colors } from '../src/tab_color';
import { copy_tab_marker, is_tab_marker, type tab_marker } from '../src/tab_marker';
import { sidebar_tabs } from '../src/tabs';

test('markers accept every bundled Codicon and only the declared terminal theme color tokens', () => {
  for (const icon of codicon_names) {
    const marker = { icon, color: 'ansiBlue' };
    assert.equal(is_tab_marker(marker), true, icon);
    assert.equal(is_client_message({ type: 'set_tab_marker', id: 'tab_0', marker }), true, icon);
  }
  for (const color of tab_colors) {
    assert.equal(is_tab_color(color), true);
    assert.equal(is_tab_marker({ icon: 'bookmark', color }), true);
  }
  assert.equal(is_client_message({ type: 'set_tab_marker', id: 'tab_0' }), true);
  assert.equal(is_client_message({ type: 'set_tab_marker', id: '../tab' }), false);
  assert.equal(is_client_message({ type: 'set_tab_color', id: 'tab_0', color: 'ansiBlue' }), false);
});

const invalid_markers: unknown[] = [
  null, [], '', 1, {},
  { icon: 'bookmark' }, { color: 'ansiBlue' },
  { icon: 'bookmark', color: 'ansiBlue', extra: true },
  { icon: 'bookmark', color: 'ansiBlue', shape: 'circle' },
  { icon: 'not_a_codicon', color: 'ansiBlue' },
  { icon: 'bookmark extra_class', color: 'ansiBlue' },
  { icon: 'bookmark; background: url(x)', color: 'ansiBlue' },
  { icon: '<svg onload=alert(1)>', color: 'ansiBlue' },
  { icon: new String('bookmark'), color: 'ansiBlue' },
  ...[undefined, null, [], '', 1, {}, '#ff0000', 'red', 'ansiRed; background: url(x)', new String('ansiBlue')]
    .map(color => ({ icon: 'bookmark', color })),
  Object.create({ icon: 'bookmark', color: 'ansiBlue' }),
];

test('marker validation rejects malformed preferences and CSS or markup injection', () => {
  for (const marker of invalid_markers) {
    assert.equal(is_tab_marker(marker), false);
    assert.equal(is_client_message({ type: 'set_tab_marker', id: 'tab_0', marker }), false);
  }
});

test('startup and temporary tab markers persist locally with isolated nested snapshots', () => {
  const profiles = [{ id: 'profile', name: 'Shell', command: '', shell: '' }];
  const model = new sidebar_tabs(profiles);
  const startup_id = model.tabs[0].id;
  const temporary_id = model.add_tab().id;
  const preference: tab_marker = { icon: 'bookmark', color: 'ansiBlue' };
  assert.equal(model.set_marker(startup_id, preference), true);
  assert.equal(model.set_marker(temporary_id, { icon: 'tag', color: 'ansiBrightYellow' }), true);
  preference.icon = 'flag';
  model.tabs[0].marker!.color = 'ansiBlack';
  model.open_profile(profiles[0]).marker!.icon = 'ask';
  assert.deepEqual(model.tabs[0].marker, { icon: 'bookmark', color: 'ansiBlue' });
  assert.deepEqual(model.tabs[1].marker, { icon: 'tag', color: 'ansiBrightYellow' });
  assert.equal(Object.hasOwn(profiles[0], 'marker'), false);

  const memory = model.remember();
  const restored = new sidebar_tabs(profiles, memory);
  assert.deepEqual(restored.tabs, model.tabs);
  memory.tabs[0].marker!.color = 'ansiGreen';
  assert.equal(model.tabs[0].marker!.color, 'ansiBlue');
  assert.equal(restored.tabs[0].marker!.color, 'ansiBlue');
  const copied = copy_tab_marker(restored.tabs[1].marker!);
  copied.icon = 'star-full';
  assert.equal(restored.tabs[1].marker!.icon, 'tag');
});

test('marker reset and invalid changes preserve tab identity, names, order, and startup settings', () => {
  const model = new sidebar_tabs([]);
  const first = model.add_tab();
  const second = model.add_tab();
  const marker: tab_marker = { icon: 'flag', color: 'ansiGreen' };
  assert.equal(model.set_marker(first.id, undefined), false);
  assert.equal(model.set_marker('missing', marker), false);
  assert.equal(model.set_marker(first.id, marker), true);
  assert.equal(model.set_marker(first.id, { ...marker }), false);
  const before = model.remember();
  for (const invalid of invalid_markers) assert.equal(model.set_marker(first.id, invalid as tab_marker), false);
  assert.deepEqual(model.remember(), before);
  assert.equal(model.set_marker(first.id, undefined), true);
  assert.equal(model.set_marker(first.id, undefined), false);
  assert.equal(Object.hasOwn(model.tabs[0], 'marker'), false);
  assert.equal(Object.hasOwn(model.remember().tabs[0], 'marker'), false);
  assert.deepEqual(model.tabs, [first, second]);
  assert.deepEqual(new sidebar_tabs([], model.remember()).tabs, [first, second]);
});

test('each theme color survives workspace reload independently of other tabs', () => {
  const model = new sidebar_tabs([]);
  for (const color of tab_colors) {
    assert.equal(model.set_marker(model.add_tab().id, { icon: 'star-full', color }), true);
  }
  const restored = new sidebar_tabs([], model.remember());
  assert.deepEqual(restored.tabs.map(tab => tab.marker!.color), tab_colors);
  restored.set_marker(restored.tabs[0].id, undefined);
  assert.deepEqual(restored.tabs.slice(1).map(tab => tab.marker!.color), tab_colors.slice(1));
});

function saved_tab(fields: Record<string, unknown> = {}) {
  return {
    version: 1, tabs: [{ id: 'saved', name: 'Original', cwd: '/tmp', ...fields }],
    active_id: 'saved', expanded_ids: ['saved'], next_number: 1,
  };
}

test('legacy name colors and special character markers are discarded without losing tabs or cwd', () => {
  const legacy_shapes = ['circle', 'triangle', 'triangle_right', 'triangle_down', 'triangle_left',
    'diamond', 'square', 'pentagon_right', 'hexagon', 'heart', 'music_note'];
  for (const marker of [undefined, ...legacy_shapes.map(shape => ({ shape, color: 'ansiBrightCyan' }))]) {
    const memory = saved_tab({ name_color: 'ansiGreen', marker });
    const original_memory = structuredClone(memory);
    const model = new sidebar_tabs([], memory);
    assert.deepEqual(model.tabs, [{ id: 'saved', name: 'Original', cwd: '/tmp', command: '', shell: '' }]);
    assert.equal(model.active_id, 'saved');
    assert.deepEqual(model.expanded_ids, ['saved']);
    assert.equal(Object.hasOwn(model.remember().tabs[0], 'marker'), false);
    assert.equal(Object.hasOwn(model.remember().tabs[0], 'name_color'), false);
    assert.deepEqual(new sidebar_tabs([], model.remember()).tabs, model.tabs);
    assert.deepEqual(memory, original_memory);
  }
});

test('malformed markers retain otherwise valid remembered tabs', () => {
  for (const marker of invalid_markers) {
    const model = new sidebar_tabs([], saved_tab({ marker }));
    assert.deepEqual(model.tabs, [{ id: 'saved', name: 'Original', cwd: '/tmp', command: '', shell: '' }]);
    assert.equal(Object.hasOwn(model.remember().tabs[0], 'marker'), false);
  }
});

test('discarding old decorations preserves reordered startup profiles, runtime names, and expansion', () => {
  const profiles = [
    { id: 'one', name: 'First profile', command: 'echo one', shell: '' },
    { id: 'two', name: 'Second profile', command: 'echo two', shell: '' },
  ];
  const model = new sidebar_tabs(profiles, {
    version: 1,
    tabs: [
      { id: 'saved_two', profile_id: 'two', name: 'Renamed', renamed: true, cwd: '/tmp',
        name_color: 'ansiRed', marker: { shape: 'circle', color: 'ansiBlue' } },
      { id: 'saved_one', profile_id: 'one', name: 'Old setting name', name_color: 'ansiGreen' },
    ],
    active_id: 'saved_two', expanded_ids: ['saved_one'], next_number: 0,
  });
  assert.deepEqual(model.tabs, [
    { ...profiles[1], id: 'saved_two', profile_id: 'two', name: 'Renamed', cwd: '/tmp' },
    { ...profiles[0], id: 'saved_one', profile_id: 'one' },
  ]);
  assert.equal(model.active_id, 'saved_two');
  assert.deepEqual(model.expanded_ids, ['saved_one']);
  assert.deepEqual(new sidebar_tabs(profiles, model.remember()).tabs, model.tabs);
});

test('valid Codicons do not import legacy name colors and resetting cannot resurrect them', () => {
  const marker: tab_marker = { icon: 'ask', color: 'ansiBlue' };
  const model = new sidebar_tabs([], saved_tab({ marker, name_color: 'ansiRed' }));
  assert.deepEqual(model.tabs[0].marker, marker);
  assert.equal(Object.hasOwn(model.tabs[0], 'name_color'), false);
  assert.equal(Object.hasOwn(model.remember().tabs[0], 'name_color'), false);
  assert.equal(model.set_marker('saved', undefined), true);
  assert.equal(new sidebar_tabs([], model.remember()).tabs[0].marker, undefined);
});
