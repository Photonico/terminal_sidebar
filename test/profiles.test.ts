import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProfiles, isClientMessage } from '../src/profiles';

test('profile IDs retain session identity when names and order change', () => {
  const profiles = parseProfiles([{ id: 'b', name: ' CLI B ' }, { id: 'a', name: 'CLI A', command: 'grok', shell: ' zsh ' }]);
  assert.deepEqual(profiles, [{ id: 'b', name: 'CLI B', command: '', shell: '' }, { id: 'a', name: 'CLI A', command: 'grok', shell: 'zsh' }]);
});

test('rejects duplicate IDs, invalid shells, NUL commands, and malformed profiles atomically', () => {
  for (const value of [null, {}, [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }], [{ id: 'a', name: 'A', shell: 'zsh\nother' }], [{ id: 'a', name: 'A', command: 'a\0b' }], [{ id: '../a', name: 'A' }]]) {
    assert.throws(() => parseProfiles(value));
  }
  assert.deepEqual(parseProfiles([]), []);
});

test('webview boundary rejects unbounded data, untrusted message kinds, and invalid PTY dimensions', () => {
  assert.equal(isClientMessage({ type: 'activate', id: 'a', cols: 80, rows: 24 }), true);
  for (const value of [{ type: 'execute', command: 'x' }, { type: 'resize', id: 'a', cols: Infinity, rows: 24 }, { type: 'resize', id: 'a', cols: 80.1, rows: 24 }, { type: 'input', id: 'a', data: 'x'.repeat(1024 * 1024 + 1) }, { type: 'save', profiles: new Array(33) }]) {
    assert.equal(isClientMessage(value), false);
  }
});
