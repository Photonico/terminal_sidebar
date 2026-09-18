import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse_profiles, parse_configuration, read_configuration, is_client_message } from '../src/profiles';

const profile = { id: 'a', name: 'Terminal', command: '', shell: '' };

test('profile IDs retain startup identity when names and order change', () => {
  const profiles = parse_profiles([{ id: 'b', name: ' CLI B ' }, { id: 'a', name: 'CLI A', command: 'nvim', shell: ' zsh ' }]);
  assert.deepEqual(profiles, [{ id: 'b', name: 'CLI B', command: '', shell: '' }, { id: 'a', name: 'CLI A', command: 'nvim', shell: 'zsh' }]);
});

test('startup launch options preserve literal values and copy nested configuration', () => {
  const args = ['--flag', 'two words', '', 'echo first\necho second\t# literal script'];
  const env = { KEEP: 'literal $HOME', REMOVE: null, EMPTY: '', MULTILINE: 'one\ntwo' };
  const [result] = parse_profiles([{ ...profile, args, env }]);
  assert.deepEqual(result, { ...profile, args, env });
  assert.notEqual(result.args, args);
  assert.notEqual(result.env, env);
  result.args!.push('changed');
  result.env!.KEEP = 'changed';
  assert.equal(args.length, 4);
  assert.equal(env.KEEP, 'literal $HOME');
  assert.deepEqual(parse_profiles([{ ...profile, args: [], env: {} }]), [{ ...profile, args: [], env: {} }]);
  assert.deepEqual(parse_profiles([profile]), [profile], 'legacy profiles gain no optional properties');
});

test('startup arguments reject malformed arrays, NUL, sparse entries, and UTF-8 size limits', () => {
  for (const args of [null, '--login', {}, [true], ['a\0b'], new Array(1), new Array(129).fill(''),
    ['x'.repeat(8193)], ['界'.repeat(2731)], new Array(5).fill('x'.repeat(8192))]) {
    assert.throws(() => parse_profiles([{ ...profile, args }]));
  }
  assert.deepEqual(parse_profiles([{ ...profile, args: ['x'.repeat(8192)] }])[0].args, ['x'.repeat(8192)]);
});

test('startup environments reject invalid keys, values, prototypes, and UTF-8 size limits', () => {
  for (const env of [null, [], 'KEY=value', new Date(), { VALID: undefined }, { VALID: 7 }, { VALID: 'a\0b' },
    { '': 'empty name' }, { 'BAD=NAME': 'value' }, { 'BAD\nNAME': 'value' }, { 'BAD\u007fNAME': 'value' },
    { ['x'.repeat(257)]: 'value' }, { ['界'.repeat(86)]: 'value' }, { LONG: '界'.repeat(2731) },
    Object.fromEntries(new Array(129).fill(0).map((_, index) => [`KEY_${index}`, ''])),
    Object.fromEntries(new Array(5).fill(0).map((_, index) => [`KEY_${index}`, 'x'.repeat(8192)])),
    JSON.parse('{"__proto__":"value"}'), { constructor: 'value' }, { PROTOTYPE: 'value' },
    Object.create({ inherited: 'value' })]) {
    assert.throws(() => parse_profiles([{ ...profile, env }]));
  }
  const null_prototype = Object.assign(Object.create(null), { SAFE: 'value' });
  assert.deepEqual(parse_profiles([{ ...profile, env: null_prototype }])[0].env, { SAFE: 'value' });
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
    { type: 'replace_copy', id: 'a', text: 'output' },
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

test('webview link requests accept only bounded absolute HTTP URLs and file positions', () => {
  for (const uri of ['https://example.test/a?b=1#c', 'http://localhost:3000', 'HTTPS://example.test']) {
    assert.equal(is_client_message({ type: 'open_link', id: 'tab_0', uri }), true);
  }
  for (const uri of ['javascript:alert(1)', 'command:workbench.action.closeWindow', 'file:///tmp/a',
    'https:example.test', '//example.test', 'https://', 'https://example.test/\n', 'https://example.test/' + 'a'.repeat(8192)]) {
    assert.equal(is_client_message({ type: 'open_link', id: 'tab_0', uri }), false);
  }
  assert.equal(is_client_message({ type: 'open_link', id: '../tab', uri: 'https://example.test' }), false);
  assert.equal(is_client_message({ type: 'open_file', id: 'tab_0', path: '/tmp/source file.ts', line: 1 }), true);
  assert.equal(is_client_message({ type: 'open_file', id: 'tab_0', path: 'src/file.ts', line: 10_000_000, column: 7 }), true);
  for (const overrides of [{ path: '' }, { path: '   ' }, { path: 'x'.repeat(4097) }, { path: 'file\0.ts' },
    { path: 'file\n.ts' }, { line: 0 }, { line: 1.5 }, { line: 10_000_001 }, { line: '1' },
    { column: 0 }, { column: Infinity }, { column: null }, { id: '../tab' }]) {
    assert.equal(is_client_message({ type: 'open_file', id: 'tab_0', path: 'file.ts', line: 1, ...overrides }), false);
  }
});

test('webview exports validate their format and separate plain text and HTML size limits', () => {
  const text = 'x'.repeat(1024 * 1024);
  assert.equal(is_client_message({ type: 'export', id: 'tab_0', text }), true);
  assert.equal(is_client_message({ type: 'export', id: 'tab_0', text, format: 'text' }), true);
  assert.equal(is_client_message({ type: 'export', id: 'tab_0', text: text + 'x' }), false);
  assert.equal(is_client_message({ type: 'export', id: 'tab_0', text: text + 'x', format: 'text' }), false);
  assert.equal(is_client_message({ type: 'export', id: 'tab_0', text: text.repeat(8), format: 'html' }), true);
  assert.equal(is_client_message({ type: 'export', id: 'tab_0', text: text.repeat(8) + 'x', format: 'html' }), false);
  for (const format of ['json', '', null, false]) {
    assert.equal(is_client_message({ type: 'export', id: 'tab_0', text: 'output', format }), false);
  }
});
