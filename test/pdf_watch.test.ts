import assert from 'node:assert/strict';
import * as path from 'node:path';
import { runInNewContext as run_in_new_context } from 'node:vm';
import { setImmediate as next_turn } from 'node:timers/promises';
import test from 'node:test';
import { build } from 'esbuild';
import type { pdf_watch } from '../src/pdf_watch';

const bundled_watch = build({
  entryPoints: [path.resolve(__dirname, '../src/pdf_watch.ts')], bundle: true,
  write: false, platform: 'node', format: 'cjs', external: ['vscode'],
}).then(result => result.outputFiles[0].text);

async function harness() {
  const module = { exports: {} as { pdf_watch: typeof pdf_watch } };
  const bytes = Buffer.from('%PDF-1.7\nTest fixture\n%%EOF\n');
  const metadata = { size: bytes.length, mtimeMs: 1, isFile: () => true };
  const timers = new Map<number, { delay: number; callback: () => void }>();
  let next_timer = 0;
  let file_listener: (uri: unknown) => void = () => undefined;
  let stat: () => Promise<typeof metadata> = async () => metadata;
  let final_stat = metadata;
  let disposed = false;
  let changed = 0;
  let closed = 0;
  const errors: string[] = [];
  const reads: number[] = [];
  const uri = (file: string): unknown => ({
    path: file, fsPath: file, toString: () => `file://${file}`,
    with: ({ path: next }: { path: string }) => uri(next),
  });
  run_in_new_context(await bundled_watch, {
    module, exports: module.exports, Buffer,
    setTimeout: (callback: () => void, delay: number) => {
      const id = ++next_timer;
      timers.set(id, { delay, callback });
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
    require: (name: string) => {
      if (name === 'node:path') return path;
      if (name === 'node:fs/promises') return {
        stat: () => stat(),
        open: async () => ({
          read: async (target: Buffer, offset: number, length: number, position: number) => {
            reads.push(length);
            bytes.copy(target, offset, position, position + length);
          },
          stat: async () => final_stat,
          close: async () => { closed++; },
        }),
      };
      if (name === 'vscode') return {
        RelativePattern: class {},
        workspace: { createFileSystemWatcher: () => ({
          onDidChange: (listener: typeof file_listener) => { file_listener = listener; },
          onDidCreate: () => undefined, onDidDelete: () => undefined,
          dispose: () => { disposed = true; },
        }) },
      };
      throw new Error(`Unexpected boundary ${name}`);
    },
  });
  const watcher = new module.exports.pdf_watch(uri('/work/test.pdf') as ConstructorParameters<typeof pdf_watch>[0],
    () => { changed++; }, message => errors.push(message));
  return {
    watcher, timers, metadata, errors, reads,
    changed: () => changed, closed: () => closed, disposed: () => disposed,
    set_stat: (next: typeof stat) => { stat = next; },
    set_final_stat: (next: typeof metadata) => { final_stat = next; },
    event: (file: string) => file_listener(uri(file)),
    tick: async (delay: number) => {
      const timer = [...timers].find(([, value]) => value.delay === delay);
      assert.ok(timer, `a ${delay}ms timer exists`);
      timers.delete(timer[0]);
      timer[1].callback();
      await next_turn();
    },
  };
}

test('PDF watch ignores neighbouring files and only reads a stable PDF envelope', async () => {
  const h = await harness();
  h.event('/work/other.pdf');
  assert.equal(h.timers.size, 0);
  h.event('/work/test.pdf');
  h.event('/work/test.pdf');
  assert.equal(h.timers.size, 1);
  await h.tick(700);
  await h.tick(400);
  assert.equal(h.changed(), 1);
  assert.equal(h.closed(), 1);
  assert.ok(h.reads.every(length => length <= 2048));
  assert.deepEqual(h.errors, []);
  h.watcher.dispose();
  assert.equal(h.disposed(), true);
});

test('an old stat completion cannot replace the newer generation stability timer', async () => {
  const h = await harness();
  let complete!: (metadata: typeof h.metadata) => void;
  h.set_stat(() => new Promise(resolve => { complete = resolve; }));
  h.watcher.refresh();
  await h.tick(700);
  h.watcher.refresh();
  complete(h.metadata);
  await next_turn();
  assert.deepEqual([...h.timers.values()].map(timer => timer.delay), [700]);
  h.watcher.dispose();
  assert.equal(h.timers.size, 0);
  assert.equal(h.changed(), 0);
});

test('PDF disappearance reports once and reappearance refreshes the same watcher', async () => {
  const h = await harness();
  h.set_stat(async () => { throw new Error('ENOENT'); });
  h.watcher.refresh();
  await h.tick(700);
  assert.match(h.errors[0], /unavailable/i);
  h.set_stat(async () => h.metadata);
  h.watcher.refresh();
  await h.tick(700);
  await h.tick(400);
  assert.equal(h.changed(), 1);
  h.watcher.dispose();
});

test('PDF writes during envelope inspection never notify a partial document', async () => {
  const h = await harness();
  h.set_final_stat({ ...h.metadata, size: h.metadata.size + 1 });
  h.watcher.refresh();
  await h.tick(700);
  await h.tick(400);
  assert.equal(h.changed(), 0);
  assert.equal(h.closed(), 1);
  assert.match(h.errors[0], /being written/i);
  h.watcher.dispose();
});
