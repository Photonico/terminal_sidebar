import assert from 'node:assert/strict';
import test from 'node:test';
import { sidebar_tabs } from '../src/tabs';
import type { terminal_profile } from '../src/types';

function startup_profiles(): terminal_profile[] {
  return [
    { id: 'grok', name: 'Grok', command: 'grok', shell: '/bin/zsh' },
    { id: 'shell', name: 'Shell', command: '', shell: '' },
  ];
}

test('closing, renaming, and reopening runtime tabs never changes startup settings', () => {
  const profiles = startup_profiles();
  const model = new sidebar_tabs(profiles);
  const grok = model.tabs[0];
  assert.equal(model.rename_tab(grok.id, 'My conversation'), true);
  assert.equal(profiles[0].name, 'Grok');
  assert.equal(model.open_profile(profiles[0]).id, grok.id);
  assert.equal(model.tabs.length, 2);
  assert.equal(model.close_tab(grok.id), true);
  assert.equal(model.tabs.length, 1);
  assert.deepEqual(profiles, startup_profiles());
  const reopened = model.open_profile(profiles[0]);
  assert.notEqual(reopened.id, grok.id);
  assert.equal(reopened.command, 'grok');
  assert.equal(reopened.name, 'Grok');
});

test('temporary names advance while ordinary tabs remain, avoiding collisions and startup commands', () => {
  const model = new sidebar_tabs([{ id: 'occupied', name: 'Term 0', command: 'anything', shell: 'bash' }]);
  const first = model.add_tab();
  assert.equal(first.name, 'Term 1');
  assert.equal(first.command, '');
  assert.equal(first.shell, '');
  assert.equal(first.profile_id, undefined);
  assert.equal(model.add_tab().name, 'Term 2');
  model.close_tab(first.id);
  assert.equal(model.add_tab().name, 'Term 3');
  const next_window = new sidebar_tabs([], model.remember());
  assert.equal(next_window.add_tab().name, 'Term 4');
});

test('closing every temporary tab resets numbering even while startup profiles remain', () => {
  const profiles = startup_profiles();
  const model = new sidebar_tabs(profiles);
  const first = model.add_tab();
  const second = model.add_tab();
  model.rename_tab(second.id, 'Scratch');
  model.close_tab(first.id);
  assert.equal(model.remember().next_number, 2);
  model.close_tab(second.id);
  assert.deepEqual(model.tabs.map(tab => tab.profile_id), ['grok', 'shell']);
  assert.equal(model.remember().next_number, 0);
  assert.equal(new sidebar_tabs(profiles, model.remember()).add_tab().name, 'Term 0');
  assert.equal(model.add_tab().name, 'Term 0');
});

test('restarting temporary numbering skips names occupied by startup profiles', () => {
  const model = new sidebar_tabs([
    { id: 'first', name: 'Term 0', command: '', shell: '' },
    { id: 'second', name: 'Term 1', command: '', shell: '' },
  ]);
  const temporary = model.add_tab();
  assert.equal(temporary.name, 'Term 2');
  model.close_tab(temporary.id);
  assert.equal(model.remember().next_number, 0);
  assert.equal(model.add_tab().name, 'Term 2');
});

test('stale remembered numbering resets when no temporary tabs can be restored', () => {
  for (const tabs of [
    [],
    [{ id: 'grok_tab', name: 'Grok', profile_id: 'grok' }],
    [{ id: '../invalid', name: 'Term 5' }, { id: 'removed', name: 'Old profile', profile_id: 'deleted' }],
  ]) {
    const restored = new sidebar_tabs(startup_profiles(), {
      version: 1,
      tabs,
      expanded_ids: [],
      next_number: 6,
    });
    assert.equal(restored.remember().next_number, 0);
    assert.equal(restored.add_tab().name, 'Term 0');
  }
});

test('the two sidebar models keep their selections, closures, and numbering independent', () => {
  const left = new sidebar_tabs(startup_profiles());
  const right = new sidebar_tabs(startup_profiles());
  const left_temporary = left.add_tab();
  assert.equal(left_temporary.name, 'Term 0');
  assert.equal(right.active_id, right.tabs[0].id);
  left.close_tab(left.tabs[0].id);
  assert.equal(right.tabs.length, 2);
  assert.equal(right.add_tab().name, 'Term 0');
  left.close_tab(left_temporary.id);
  assert.equal(left.add_tab().name, 'Term 0');
  assert.equal(right.add_tab().name, 'Term 1');
  left.tabs[0].name = 'External mutation';
  assert.equal(left.tabs[0].name, 'Shell');
});

test('memory restores order, runtime names, selection, and expansion, and reopens closed startup tabs', () => {
  const profiles = startup_profiles();
  const model = new sidebar_tabs(profiles);
  const temporary = model.add_tab();
  const shell = model.tabs[1];
  model.rename_tab(temporary.id, 'Scratch');
  model.set_expanded(shell.id, false);
  model.close_tab(model.tabs[0].id);
  model.select_tab(temporary.id);
  const restored = new sidebar_tabs(profiles, model.remember());
  assert.deepEqual(restored.tabs.map(tab => tab.name), ['Shell', 'Scratch', 'Grok']);
  assert.equal(restored.active_id, temporary.id);
  assert.equal(restored.expanded_ids.includes(shell.id), false);
  assert.equal(restored.expanded_ids.includes(temporary.id), true);
  assert.equal(restored.tabs[2].command, 'grok');
});

test('persisted memory excludes credentials, commands, shells, and arbitrary injected fields', () => {
  const restored = new sidebar_tabs(startup_profiles(), {
    version: 1,
    tabs: [
      { id: 'first', name: 'Grok', profile_id: 'grok', command: 'stale secret', shell: 'wrong shell' },
      { id: 'scratch', name: 'Scratch', command: 'injected command', shell: '/malicious/program', output: 'private text' },
      { id: 'removed', name: 'Removed', profile_id: 'deleted', command: 'old command' },
    ],
    expanded_ids: ['first', 'scratch'],
    active_id: 'scratch',
    next_number: 8,
    history: 'private history',
  });
  assert.equal(restored.tabs[0].command, 'grok');
  assert.equal(restored.tabs[0].shell, '/bin/zsh');
  assert.equal(restored.tabs[1].command, '');
  assert.equal(restored.tabs[1].shell, '');
  assert.equal(restored.tabs.some(tab => tab.id === 'removed'), false);
  const memory = restored.remember();
  for (const descriptor of memory.tabs) assert.deepEqual(Object.keys(descriptor).sort(), descriptor.profile_id ? ['id', 'name', 'profile_id'] : ['id', 'name']);
  assert.doesNotMatch(JSON.stringify(memory), /"command":|"shell":|private|secret|malicious/);
});

test('new startup names take effect next window while deliberate runtime renames remain remembered', () => {
  const profiles = startup_profiles();
  const model = new sidebar_tabs(profiles);
  model.rename_tab(model.tabs[0].id, 'Personal name');
  profiles[0].name = 'New Grok default';
  profiles[1].name = 'New Shell default';
  const restored = new sidebar_tabs(profiles, model.remember());
  assert.equal(restored.tabs[0].name, 'Personal name');
  assert.equal(restored.tabs[1].name, 'New Shell default');
  assert.equal(restored.remember().tabs[0].renamed, true);
  assert.equal(restored.remember().tabs[1].renamed, undefined);
});

test('invalid memory entries are ignored and capacity leaves room for every startup profile', () => {
  const profiles = Array.from({ length: 32 }, (_, index) => ({ id: `profile_${index}`, name: `Profile ${index}`, command: '', shell: '' }));
  const memory = {
    version: 1,
    tabs: [
      { id: '../bad', name: 'Bad' },
      { id: 'blank', name: '' },
      { id: 'duplicate', name: 'First' },
      { id: 'duplicate', name: 'Duplicate' },
      ...Array.from({ length: 64 }, (_, index) => ({ id: `temporary_${index}`, name: `Temporary ${index}` })),
    ],
    active_id: 'does_not_exist',
    expanded_ids: ['unknown'],
    next_number: Infinity,
  };
  const restored = new sidebar_tabs(profiles, memory);
  assert.equal(restored.tabs.length, 64);
  assert.equal(new Set(restored.tabs.map(tab => tab.id)).size, 64);
  assert.equal(restored.tabs.filter(tab => tab.profile_id !== undefined).length, 32);
  assert.equal(restored.active_id, 'duplicate');
  assert.throws(() => restored.add_tab(), /at most 64/);
  assert.deepEqual(new sidebar_tabs([], { version: 999, tabs: [{ id: 'a', name: 'Old' }] }).tabs, []);
});

test('closing selects a neighbour, closing all remains empty, and unknown operations are harmless', () => {
  const model = new sidebar_tabs([]);
  const first = model.add_tab();
  const second = model.add_tab();
  const third = model.add_tab();
  model.select_tab(second.id);
  model.close_tab(second.id);
  assert.equal(model.active_id, third.id);
  model.close_tab(third.id);
  assert.equal(model.active_id, first.id);
  model.close_tab(first.id);
  assert.equal(model.active_id, undefined);
  assert.deepEqual(model.expanded_ids, []);
  assert.equal(model.close_tab('absent'), false);
  assert.equal(model.select_tab('absent'), false);
  assert.equal(model.rename_tab('absent', 'Name'), false);
  assert.equal(model.set_expanded('absent', true), false);
  assert.deepEqual(new sidebar_tabs([], model.remember()).tabs, []);
  assert.equal(model.remember().next_number, 0);
  assert.equal(model.add_tab().name, 'Term 0');
});
