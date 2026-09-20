import assert from 'node:assert/strict';
import * as path from 'node:path';
import { runInNewContext as run_in_new_context } from 'node:vm';
import test from 'node:test';
import { build } from 'esbuild';
import type { replace_file } from '../src/atomic_file';

const bundled = build({
  entryPoints: [path.resolve(__dirname, '../src/atomic_file.ts')], bundle: true,
  write: false, platform: 'node', format: 'cjs',
}).then(result => result.outputFiles[0].text);

async function harness(platform: string, failures: string[]) {
  const calls: string[][] = [];
  const waits: number[] = [];
  const module = { exports: {} as { replace_file: typeof replace_file } };
  run_in_new_context(await bundled, {
    module, exports: module.exports, process: { platform },
    require: (name: string) => {
      if (name === 'node:fs/promises') return { rename: async (...paths: string[]) => {
        calls.push(paths);
        const code = failures.shift();
        if (code) throw Object.assign(new Error(code), { code });
      } };
      if (name === 'node:timers/promises') return { setTimeout: async (milliseconds: number) => { waits.push(milliseconds); } };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return { replace: module.exports.replace_file, calls, waits };
}

test('Windows transient file locks retry atomic replacement without deleting the existing record', async () => {
  const h = await harness('win32', ['EPERM', 'EACCES', 'EBUSY']);
  await h.replace('complete.tmp', 'existing.json');
  assert.equal(h.calls.length, 4);
  for (const call of h.calls) assert.deepEqual(call, ['complete.tmp', 'existing.json']);
  assert.equal(h.waits.length, 3);
});

test('permanent file locks have a bounded retry and preserve the original failure', async () => {
  const h = await harness('win32', Array(20).fill('EPERM'));
  await assert.rejects(h.replace('complete.tmp', 'existing.json'), { code: 'EPERM' });
  assert.ok(h.calls.length <= 10);
  assert.ok(h.waits.reduce((sum, milliseconds) => sum + milliseconds, 0) <= 1000);
});

test('missing files and non-Windows permission errors fail immediately', async () => {
  for (const [platform, code] of [['win32', 'ENOENT'], ['linux', 'EACCES'], ['darwin', 'EPERM']]) {
    const h = await harness(platform, [code]);
    await assert.rejects(h.replace('missing.tmp', 'existing.json'), { code });
    assert.equal(h.calls.length, 1);
    assert.equal(h.waits.length, 0);
  }
});
