import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse_profiles, parse_configuration, read_configuration, is_client_message } from '../src/profiles';

const profile = { id: 'a', name: 'Terminal', command: '', shell: '' };

test('profile IDs retain startup identity when names and order change', () => {
  const profiles = parse_profiles([{ id: 'b', name: ' CLI B ' }, { id: 'a', name: 'CLI A', command: 'nvim', shell: ' zsh ' }]);
  assert.deepEqual(profiles, [{ id: 'b', name: 'CLI B', command: '', shell: '' }, { id: 'a', name: 'CLI A', command: 'nvim', shell: 'zsh' }]);
});

test('rejects duplicate IDs, invalid shells, NUL commands, and malformed profiles atomically', () => {
  for (const value of [null, {}, [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }], [{ id: 'a', name: 'A', shell: 'zsh\nother' }], [{ id: 'a', name: 'A', command: 'a\0b' }], [{ id: '../a', name: 'A' }]]) {
    assert.throws(() => parse_profiles(value));
  }
  assert.deepEqual(parse_profiles([]), []);
});

test('both sides validate atomically while allowing independent repeated profile IDs', () => {
  const result = parse_configuration({ left: [profile], right: [profile] });
  assert.notEqual(result.left[0], result.right[0]);
  assert.throws(() => parse_configuration({ left: [profile], right: [{ id: 'invalid' }] }));
  assert.throws(() => parse_configuration({ left: [] }));
  assert.throws(() => parse_configuration({ left: [], right: new Array(33).fill(profile) }));
});

test('new settings take precedence, legacy migration stays on the right, and explicit empty arrays survive', () => {
  assert.deepEqual(read_configuration(undefined, [profile]), { left: [], right: [profile] });
  assert.deepEqual(read_configuration(undefined, []), { left: [], right: [] });
  assert.deepEqual(read_configuration({ left: [], right: [] }, [profile]), { left: [], right: [] });
  assert.throws(() => read_configuration(null, [profile]));
  const defaults = read_configuration(undefined);
  defaults.right[0].name = 'Changed locally';
  assert.equal(read_configuration(undefined).right[0].name, 'Terminal');
});

test('webview boundary rejects unbounded data, malformed saves, and invalid terminal operations', () => {
  assert.equal(is_client_message({ type: 'activate', id: 'a', cols: 80, rows: 24 }), true);
  assert.equal(is_client_message({ type: 'save', configuration: { left: [], right: [profile] }, base_configuration: { left: [], right: [] } }), true);
  assert.equal(is_client_message({ type: 'rename_tab', id: 'a', name: 'Term 1' }), true);
  assert.equal(is_client_message({ type: 'request_rename', id: 'a' }), true);
  assert.equal(is_client_message({ type: 'open_other_sidebar' }), true);
  for (const value of [
    { type: 'execute', command: 'x' },
    { type: 'resize', id: 'a', cols: Infinity, rows: 24 },
    { type: 'resize', id: 'a', cols: 80.1, rows: 24 },
    { type: 'input', id: 'a', data: 'x'.repeat(1024 * 1024 + 1) },
    { type: 'save', configuration: { left: [], right: [] } },
    { type: 'save', configuration: { left: [], right: [{ id: 'a' }] }, base_configuration: { left: [], right: [] } },
    { type: 'rename_tab', id: 'a', name: '\u001b[0m' },
    { type: 'request_rename' },
    { type: 'request_rename', id: '../a' },
    { type: 'expanded', id: 'a', expanded: 'yes' },
    { type: 'close_tab', id: '../a' },
    { type: 'draft_state', configuring: true, can_undo: true },
  ]) assert.equal(is_client_message(value), false, JSON.stringify(value).slice(0, 120));
});

test('tab moves require two distinct valid identifiers and an explicit placement', () => {
  for (const placement of ['before', 'after']) {
    assert.equal(is_client_message({ type: 'move_tab', id: 'tab_0', target_id: 'tab_1', placement }), true);
  }
  for (const value of [
    { id: 'tab_0', target_id: 'tab_1' },
    { id: 'tab_0', target_id: 'tab_1', placement: 'middle' },
    { id: 'tab_0', target_id: 'tab_1', placement: true },
    { id: 'tab_0', placement: 'before' },
    { id: 'tab_0', target_id: '../tab_1', placement: 'before' },
    { id: '../tab_0', target_id: 'tab_1', placement: 'before' },
    { id: 'tab_0', target_id: 'tab_0', placement: 'after' },
    { id: 'tab_0', target_id: 1, placement: 'after' },
  ]) assert.equal(is_client_message({ type: 'move_tab', ...value }), false, JSON.stringify(value));
});
