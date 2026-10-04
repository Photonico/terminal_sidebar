import assert from 'node:assert/strict';
import * as path from 'node:path';
import { runInNewContext as run_in_new_context } from 'node:vm';
import { setImmediate as next_turn } from 'node:timers/promises';
import test from 'node:test';
import { build } from 'esbuild';
import type { postscript_watch } from '../src/postscript_watch';
import type { postscript_preview, postscript_options } from '../src/postscript_preview';

const bundled_watch = build({ entryPoints: [path.resolve(__dirname, '../src/postscript_watch.ts')], bundle: true,
  write: false, platform: 'node', format: 'cjs', external: ['vscode', './postscript_preview'],
}).then(result => result.outputFiles[0].text);

async function harness() {
  const module = { exports: {} as { postscript_watch: typeof postscript_watch } };
  let metadata = { dev: 1, ino: 1, size: 20, mtimeMs: 1, ctimeMs: 1, isFile: () => true };
  const timers = new Map<number, () => void>();
  let next_timer = 0;
  let disposed = false;
  const listeners: Record<string, (uri: unknown) => void> = {};
  const requests: { signal: AbortSignal; resolve(result: postscript_preview): void; reject(reason: Error): void }[] = [];
  const changed: string[] = [];
  const errors: string[] = [];
  const removed: string[] = [];
  let stat: () => Promise<typeof metadata> = async () => metadata;
  const uri = (file: string): unknown => ({ path: file, fsPath: file, toString: () => `file://${file}`,
    with: ({ path: next }: { path: string }) => uri(next) });
  run_in_new_context(await bundled_watch, { module, exports: module.exports, AbortController, Error,
    setTimeout: (callback: () => void) => { const id = ++next_timer; timers.set(id, callback); return id; },
    clearTimeout: (id: number) => timers.delete(id),
    require: (name: string) => {
      if (name === 'node:path') return path;
      if (name === 'node:fs/promises') return { stat: () => stat() };
      if (name === './postscript_preview') return { maximum_postscript_bytes: 32 * 1024 * 1024,
        convert_postscript: (_source: string, _cache: string, options: postscript_options) =>
          new Promise<postscript_preview>((resolve, reject) => requests.push({ signal: options.signal!, resolve, reject })) };
      if (name === 'vscode') return { RelativePattern: class {}, workspace: { createFileSystemWatcher: () => ({
        onDidChange: (listener: (uri: unknown) => void) => { listeners.change = listener; },
        onDidCreate: (listener: (uri: unknown) => void) => { listeners.create = listener; },
        onDidDelete: (listener: (uri: unknown) => void) => { listeners.delete = listener; },
        dispose: () => { disposed = true; },
      }) } };
      throw new Error(`Unexpected boundary ${name}`);
    },
  });
  const watcher = new module.exports.postscript_watch(uri('/work/vector.eps') as ConstructorParameters<typeof postscript_watch>[0],
    '/cache', value => changed.push(value), value => errors.push(value));
  return { watcher, timers, requests, changed, errors, removed,
    event: (name = 'change', file = '/work/vector.eps') => listeners[name](uri(file)),
    modify: () => { metadata = { ...metadata, mtimeMs: metadata.mtimeMs + 1 }; },
    set_stat: (next: typeof stat) => { stat = next; }, metadata: () => metadata, disposed: () => disposed,
    resolve: async (index: number, name = `/cache/${index}.pdf`) => {
      requests[index].resolve({ pdf_path: name, dispose: async () => { removed.push(name); } });
      await next_turn();
    },
    tick: async () => {
      const timer = [...timers][0];
      assert.ok(timer, 'a debounced refresh is scheduled');
      timers.delete(timer[0]); timer[1](); await next_turn();
    },
  };
}

test('vector watch debounces saves, ignores neighbouring files and reuses the current converted PDF', async () => {
  const h = await harness();
  h.event('change', '/work/neighbour.eps');
  assert.equal(h.timers.size, 0);
  h.event(); h.event('create');
  assert.equal(h.timers.size, 1);
  await h.tick();
  await h.resolve(0);
  h.watcher.refresh(); await h.tick();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.changed, ['/cache/0.pdf', '/cache/0.pdf']);
  h.watcher.dispose();
  assert.deepEqual(h.removed, ['/cache/0.pdf']);
  assert.equal(h.disposed(), true);
});

test('a superseded conversion is aborted and a late result is removed instead of displayed', async () => {
  const h = await harness();
  h.watcher.refresh(); await h.tick();
  h.modify(); h.event();
  assert.equal(h.requests[0].signal.aborted, true);
  await h.tick();
  await h.resolve(1);
  await h.resolve(0);
  assert.deepEqual(h.changed, ['/cache/1.pdf']);
  assert.deepEqual(h.removed, ['/cache/0.pdf']);
  assert.deepEqual(h.errors, []);
  h.watcher.dispose();
});

test('source disappearance and failed conversion retain the last good result and recover after recreation', async () => {
  const h = await harness();
  h.watcher.refresh(); await h.tick(); await h.resolve(0);
  h.set_stat(async () => { throw new Error('ENOENT'); });
  h.event('delete'); await h.tick();
  assert.match(h.errors[0], /unavailable/i);
  assert.deepEqual(h.removed, []);
  h.set_stat(async () => h.metadata()); h.modify();
  h.event('create'); await h.tick();
  h.requests[1].reject(new Error('Ghostscript could not convert this file within 15 seconds.'));
  await next_turn();
  assert.deepEqual(h.changed, ['/cache/0.pdf']);
  assert.deepEqual(h.removed, []);
  h.watcher.refresh(); await h.tick(); await h.resolve(2);
  assert.deepEqual(h.changed, ['/cache/0.pdf', '/cache/2.pdf']);
  assert.deepEqual(h.removed, [], 'previous PDF remains available for in-flight range reads');
  h.watcher.dispose();
  assert.deepEqual(h.removed.sort(), ['/cache/0.pdf', '/cache/2.pdf']);
});

test('old stat completions cannot launch a conversion after a newer refresh', async () => {
  const h = await harness();
  let complete!: (metadata: ReturnType<typeof h.metadata>) => void;
  h.set_stat(() => new Promise(resolve => { complete = resolve; }));
  h.watcher.refresh(); await h.tick();
  h.watcher.refresh(); complete(h.metadata()); await next_turn();
  assert.equal(h.requests.length, 0);
  assert.equal(h.timers.size, 1);
  h.watcher.dispose();
});

test('closing a preview aborts conversion and disposes any late result without notifying the view', async () => {
  const h = await harness();
  h.watcher.refresh(); await h.tick();
  h.watcher.dispose();
  assert.equal(h.requests[0].signal.aborted, true);
  await h.resolve(0);
  assert.deepEqual(h.changed, []);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.removed, ['/cache/0.pdf']);
  h.watcher.refresh();
  assert.equal(h.timers.size, 0);
});

test('repeated successful refreshes keep at most the current and previous converted result', async () => {
  const h = await harness();
  for (let index = 0; index < 3; index++) {
    h.modify(); h.watcher.refresh(); await h.tick(); await h.resolve(index);
  }
  assert.deepEqual(h.changed, ['/cache/0.pdf', '/cache/1.pdf', '/cache/2.pdf']);
  assert.deepEqual(h.removed, ['/cache/0.pdf']);
  h.watcher.dispose();
  assert.deepEqual(h.removed.sort(), ['/cache/0.pdf', '/cache/1.pdf', '/cache/2.pdf']);
});
