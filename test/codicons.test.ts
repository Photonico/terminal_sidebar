import assert from 'node:assert/strict';
import { readFileSync as read_file } from 'node:fs';
import test from 'node:test';
import { codicon_names, is_codicon_name } from '../src/codicons';

test('Codicon allowlist includes exactly the glyph names in the bundled package CSS', () => {
  const css = read_file('node_modules/@vscode/codicons/dist/codicon.css', 'utf8');
  const shipped_names = [...new Set([...css.matchAll(/\.codicon-([a-z0-9-]+):before\s*\{/g)].map(match => match[1]))].sort();
  assert.deepEqual(codicon_names, shipped_names);
  assert.equal(Object.isFrozen(codicon_names), true);
  for (const name of codicon_names) assert.equal(is_codicon_name(name), true);
  for (const name of ['bookmark', 'tag', 'flag', 'star', 'star-full', 'ask', 'fish1-happy']) {
    assert.equal(is_codicon_name(name), true);
  }
});

test('Codicon validation rejects arbitrary names, modifiers, markup and non-string values', () => {
  for (const name of [undefined, null, false, 1, {}, [], new String('bookmark'), '', 'BOOKMARK',
    'codicon-bookmark', 'bookmark codicon-modifier-spin', 'bookmark:hover', 'bookmark; color:red',
    '<svg onload=alert(1)>', 'modifier-spin', '__proto__', 'constructor']) {
    assert.equal(is_codicon_name(name), false);
  }
});
