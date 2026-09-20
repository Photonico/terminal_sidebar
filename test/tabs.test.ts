import assert from 'node:assert/strict';
import test from 'node:test';
import { sidebar_tabs } from '../src/tabs';
import { is_terminal_tab, type terminal_profile, type terminal_tab } from '../src/types';

function terminal_tabs(model: sidebar_tabs): terminal_tab[] {
  const tabs = model.tabs;
  assert.ok(tabs.every(is_terminal_tab), 'this fixture contains only terminal tabs');
  return tabs;
}

function startup_profiles(): terminal_profile[] {
  return [
    { id: 'nvim', name: 'Neovim', command: 'nvim', shell: '/bin/zsh' },
    { id: 'shell', name: 'Shell', command: '', shell: '' },
  ];
}

test('closing, renaming, and reopening runtime tabs never changes startup settings', () => {
  const profiles = startup_profiles();
  const model = new sidebar_tabs(profiles);
  const nvim = terminal_tabs(model)[0];
  assert.equal(model.rename_tab(nvim.id, 'My editor'), true);
  assert.equal(profiles[0].name, 'Neovim');
  assert.equal(model.open_profile(profiles[0]).id, nvim.id);
  assert.equal(terminal_tabs(model).length, 2);
  assert.equal(model.close_tab(nvim.id), true);
  assert.equal(terminal_tabs(model).length, 1);
  assert.deepEqual(profiles, startup_profiles());
  const reopened = model.open_profile(profiles[0]);
  assert.notEqual(reopened.id, nvim.id);
  assert.equal(reopened.command, 'nvim');
  assert.equal(reopened.name, 'Neovim');
});

test('runtime snapshots and reopened profiles isolate nested arguments and environment overrides', () => {
  const profile = { ...startup_profiles()[0], args: ['--login'], env: { MODE: 'original', REMOVE: null } };
  const model = new sidebar_tabs([profile]);
  const first = terminal_tabs(model)[0];
  first.args!.push('snapshot mutation');
  first.env!.MODE = 'snapshot mutation';
  assert.deepEqual(terminal_tabs(model)[0].args, ['--login']);
  assert.equal(terminal_tabs(model)[0].env!.MODE, 'original');
  assert.deepEqual(profile.args, ['--login']);
  assert.equal(profile.env.MODE, 'original');

  for (const close_first of [false, true]) {
    if (close_first) model.close_tab(terminal_tabs(model)[0].id);
    const opened = model.open_profile(profile);
    opened.args![0] = 'opened mutation';
    delete opened.env!.REMOVE;
    assert.deepEqual(terminal_tabs(model)[0].args, ['--login']);
    assert.equal(terminal_tabs(model)[0].env!.REMOVE, null);
  }
  profile.args.push('source mutation');
  profile.env.MODE = 'source mutation';
  assert.deepEqual(terminal_tabs(model)[0].args, ['--login']);
  assert.equal(terminal_tabs(model)[0].env!.MODE, 'original');
  assert.doesNotMatch(JSON.stringify(model.remember()), /"args"|"env"/);

  const restored = new sidebar_tabs([profile], model.remember());
  const snapshot = terminal_tabs(restored)[0];
  snapshot.args!.pop();
  snapshot.env!.MODE = 'restored mutation';
  assert.deepEqual(terminal_tabs(restored)[0].args, profile.args);
  assert.equal(terminal_tabs(restored)[0].env!.MODE, 'source mutation');
});

test('workspace memory preserves cwd for startup and temporary tabs without copying commands or shell state', () => {
  const profiles = startup_profiles();
  const model = new sidebar_tabs(profiles);
  const startup = terminal_tabs(model)[0];
  const temporary = model.add_tab();
  const startup_cwd = process.platform === 'win32' ? 'C:\\workspace\\startup' : '/workspace/startup';
  const temporary_cwd = process.platform === 'win32' ? 'D:\\temporary workspace' : '/temporary workspace';
  assert.equal(model.set_cwd(startup.id, startup_cwd), true);
  assert.equal(model.set_cwd(temporary.id, temporary_cwd), true);
  assert.equal(model.set_cwd(startup.id, startup_cwd), false);
  assert.equal(model.set_cwd('absent', startup_cwd), false);
  model.rename_tab(startup.id, 'Renamed');
  model.move_tab(temporary.id, startup.id, 'before');
  const memory = model.remember();
  assert.deepEqual(Object.keys(memory.tabs[0]).sort(), ['cwd', 'id', 'name']);
  assert.deepEqual(Object.keys(memory.tabs[1]).sort(), ['cwd', 'id', 'name', 'profile_id', 'renamed']);
  assert.deepEqual(new sidebar_tabs(profiles, memory).tabs, terminal_tabs(model));
  assert.deepEqual(profiles, startup_profiles());
  const snapshot = terminal_tabs(model)[0];
  snapshot.cwd = startup_cwd;
  assert.equal(terminal_tabs(model)[0].cwd, temporary_cwd);
});

test('invalid remembered cwd is discarded independently without losing a valid tab or metadata', () => {
  const valid = process.platform === 'win32' ? 'C:\\work' : '/work';
  for (const cwd of [null, 42, '', 'relative/path', 'file:///work', '//server/share', '\\\\server\\share', '/bad\x00', '/'.repeat(5000)]) {
    const model = new sidebar_tabs([], {
      version: 1, tabs: [{ id: 'restored', name: 'Scratch', cwd, command: 'must not restore', shell: '/evil' }],
      active_id: 'restored', expanded_ids: ['restored'], next_number: 1,
    });
    assert.deepEqual(terminal_tabs(model), [{ id: 'restored', name: 'Scratch', command: '', shell: '' }]);
    assert.equal(model.set_cwd('restored', cwd as string), false);
    assert.equal(model.active_id, 'restored');
    assert.equal(model.set_cwd('restored', valid), true);
    assert.equal(model.remember().tabs[0].cwd, valid);
  }
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
  assert.deepEqual(terminal_tabs(model).map(tab => tab.profile_id), ['nvim', 'shell']);
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
    [{ id: 'nvim_tab', name: 'Neovim', profile_id: 'nvim' }],
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
  assert.equal(right.active_id, terminal_tabs(right)[0].id);
  left.close_tab(terminal_tabs(left)[0].id);
  assert.equal(terminal_tabs(right).length, 2);
  assert.equal(right.add_tab().name, 'Term 0');
  left.close_tab(left_temporary.id);
  assert.equal(left.add_tab().name, 'Term 0');
  assert.equal(right.add_tab().name, 'Term 1');
  terminal_tabs(left)[0].name = 'External mutation';
  assert.equal(terminal_tabs(left)[0].name, 'Shell');
});

test('memory restores order, runtime names, selection, and expansion, and reopens closed startup tabs', () => {
  const profiles = startup_profiles();
  const model = new sidebar_tabs(profiles);
  const temporary = model.add_tab();
  const shell = terminal_tabs(model)[1];
  model.rename_tab(temporary.id, 'Scratch');
  model.set_expanded(shell.id, false);
  model.close_tab(terminal_tabs(model)[0].id);
  model.select_tab(temporary.id);
  const restored = new sidebar_tabs(profiles, model.remember());
  assert.deepEqual(terminal_tabs(restored).map(tab => tab.name), ['Shell', 'Scratch', 'Neovim']);
  assert.equal(restored.active_id, temporary.id);
  assert.equal(restored.expanded_ids.includes(shell.id), false);
  assert.equal(restored.expanded_ids.includes(temporary.id), true);
  assert.equal(terminal_tabs(restored)[2].command, 'nvim');
});

test('tab moves handle both directions and adjacency without changing names, selection, or expansion', () => {
  const cases: Array<[number, number, 'before' | 'after', number[], boolean]> = [
    [0, 3, 'after', [1, 2, 3, 0], true],
    [0, 3, 'before', [1, 2, 0, 3], true],
    [3, 0, 'before', [3, 0, 1, 2], true],
    [3, 0, 'after', [0, 3, 1, 2], true],
    [1, 2, 'after', [0, 2, 1, 3], true],
    [2, 1, 'before', [0, 2, 1, 3], true],
    [1, 2, 'before', [0, 1, 2, 3], false],
    [2, 1, 'after', [0, 1, 2, 3], false],
    [1, 1, 'after', [0, 1, 2, 3], false],
  ];
  for (const [source, target, placement, order, changed] of cases) {
    const model = new sidebar_tabs(startup_profiles());
    model.add_tab();
    model.add_tab();
    const original_tabs = terminal_tabs(model);
    model.select_tab(original_tabs[1].id);
    model.set_expanded(original_tabs[0].id, false);
    const expanded = new Set(model.expanded_ids);
    const next_number = model.remember().next_number;
    assert.equal(model.move_tab(original_tabs[source].id, original_tabs[target].id, placement), changed);
    assert.deepEqual(terminal_tabs(model), order.map(index => original_tabs[index]));
    assert.equal(model.active_id, original_tabs[1].id);
    assert.deepEqual(new Set(model.expanded_ids), expanded);
    assert.equal(model.remember().next_number, next_number);
  }
});

test('reordered collapsed tabs return in the same order and absent startup tabs append on reopening', () => {
  const profiles = startup_profiles();
  const model = new sidebar_tabs(profiles);
  const [nvim, shell] = terminal_tabs(model);
  const temporary = model.add_tab();
  model.rename_tab(nvim.id, 'My Neovim');
  model.move_tab(temporary.id, nvim.id, 'before');
  model.move_tab(shell.id, nvim.id, 'before');
  for (const tab of terminal_tabs(model)) model.set_expanded(tab.id, false);
  model.select_tab(shell.id);
  const reopened = new sidebar_tabs(profiles, model.remember());
  assert.deepEqual(terminal_tabs(reopened), terminal_tabs(model));
  assert.equal(reopened.active_id, shell.id);
  assert.deepEqual(reopened.expanded_ids, []);
  assert.equal(reopened.remember().tabs.at(-1)?.renamed, true);

  reopened.close_tab(shell.id);
  const next_window = new sidebar_tabs(profiles, reopened.remember());
  assert.deepEqual(terminal_tabs(next_window).map(tab => tab.name), ['Term 0', 'My Neovim', 'Shell']);
  assert.deepEqual(next_window.expanded_ids, [terminal_tabs(next_window)[2].id]);
});

test('stale tab moves cannot remove or duplicate any remaining tab', () => {
  const model = new sidebar_tabs(startup_profiles());
  const closed = model.add_tab();
  model.close_tab(closed.id);
  const before = model.remember();
  for (const [source, target] of [
    [closed.id, terminal_tabs(model)[0].id],
    [terminal_tabs(model)[0].id, closed.id],
    ['absent', 'also_absent'],
  ]) {
    assert.equal(model.move_tab(source, target, 'before'), false);
    assert.equal(model.move_tab(source, target, 'after'), false);
    assert.deepEqual(model.remember(), before);
  }
});

test('persisted memory excludes credentials, commands, shells, and arbitrary injected fields', () => {
  const restored = new sidebar_tabs(startup_profiles(), {
    version: 1,
    tabs: [
      { id: 'first', name: 'Neovim', profile_id: 'nvim', command: 'stale secret', shell: 'wrong shell' },
      { id: 'scratch', name: 'Scratch', command: 'injected command', shell: '/malicious/program', output: 'private text' },
      { id: 'removed', name: 'Removed', profile_id: 'deleted', command: 'old command' },
    ],
    expanded_ids: ['first', 'scratch'],
    active_id: 'scratch',
    next_number: 8,
    history: 'private history',
  });
  assert.equal(terminal_tabs(restored)[0].command, 'nvim');
  assert.equal(terminal_tabs(restored)[0].shell, '/bin/zsh');
  assert.equal(terminal_tabs(restored)[1].command, '');
  assert.equal(terminal_tabs(restored)[1].shell, '');
  assert.equal(terminal_tabs(restored).some(tab => tab.id === 'removed'), false);
  const memory = restored.remember();
  for (const descriptor of memory.tabs) assert.deepEqual(Object.keys(descriptor).sort(), descriptor.profile_id ? ['id', 'name', 'profile_id'] : ['id', 'name']);
  assert.doesNotMatch(JSON.stringify(memory), /"command":|"shell":|private|secret|malicious/);
});

test('new startup names take effect next window while deliberate runtime renames remain remembered', () => {
  const profiles = startup_profiles();
  const model = new sidebar_tabs(profiles);
  model.rename_tab(terminal_tabs(model)[0].id, 'Personal name');
  profiles[0].name = 'New Neovim default';
  profiles[1].name = 'New Shell default';
  const restored = new sidebar_tabs(profiles, model.remember());
  assert.equal(terminal_tabs(restored)[0].name, 'Personal name');
  assert.equal(terminal_tabs(restored)[1].name, 'New Shell default');
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
  assert.equal(terminal_tabs(restored).length, 64);
  assert.equal(new Set(terminal_tabs(restored).map(tab => tab.id)).size, 64);
  assert.equal(terminal_tabs(restored).filter(tab => tab.profile_id !== undefined).length, 32);
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
