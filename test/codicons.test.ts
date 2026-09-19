import assert from 'node:assert/strict';
import { readFileSync as read_file, writeFileSync as write_file, mkdirSync as make_directory, mkdtempSync as make_temporary_directory, rmSync as remove } from 'node:fs';
import { spawnSync as spawn_sync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

test('catalog validation accepts native checkout line endings but rejects stale glyphs', t => {
  const root = make_temporary_directory(path.join(tmpdir(), 'terminal_sidebar_codicons_'));
  t.after(() => remove(root, { recursive: true, force: true }));
  for (const relative of ['scripts/generate_codicons.mjs', 'src/codicons.ts',
    'node_modules/@vscode/codicons/package.json', 'node_modules/@vscode/codicons/dist/codicon.css']) {
    const target = path.join(root, relative);
    make_directory(path.dirname(target), { recursive: true });
    write_file(target, read_file(relative));
  }
  const target = path.join(root, 'src/codicons.ts');
  const source = read_file(target, 'utf8').replace(/\r\n/g, '\n');
  const validate = () => spawn_sync(process.execPath, [path.join(root, 'scripts/generate_codicons.mjs')], { encoding: 'utf8' });
  for (const line_ending of ['\n', '\r\n']) {
    write_file(target, source.replace(/\n/g, line_ending));
    const result = validate();
    assert.equal(result.status, 0, result.stderr);
  }
  write_file(target, source.replace("'bookmark'", "'not_a_codicon'"));
  const stale = validate();
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /Codicon catalog differs/);
});
