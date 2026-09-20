import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as next_turn } from 'node:timers/promises';
import { format_document } from '../webview/document_format_worker';
import { source_formatter } from '../webview/document_render';
import { max_format_input_bytes, type document_format_request } from '../webview/document_format_protocol';

test('CSS formatting keeps strings, comments, custom properties and nested rules', async () => {
  const result = await format_document({ format: 'css', text: '/* note */\n:root{--gap:1rem;} .card{padding:var(--gap);content:"a;b{c}";&:hover{color:red}}' });
  assert.equal(result.error, undefined);
  assert.match(result.text, /\/\* note \*\//);
  assert.match(result.text, /--gap: 1rem;/);
  assert.match(result.text, /content: "a;b\{c\}";/);
  assert.match(result.text, /&:hover \{\n\s+color: red;/);
});

test('JSON and JSONC formatting preserves comments, literal numbers and duplicate keys', async () => {
  const json = await format_document({ format: 'json', text: '{"large":9007199254740993,"unicode":"中文😀","same":1,"same":2}' });
  assert.equal(json.error, undefined);
  assert.match(json.text, /\n  "large": 9007199254740993,/);
  assert.match(json.text, /"unicode": "中文😀"/);
  assert.equal((json.text.match(/"same"/g) ?? []).length, 2);
  const jsonc = await format_document({ format: 'jsonc', text: '{// line comment\n"url":"https://example.com/a//b",/* block */"a":[1,2,],}' });
  assert.equal(jsonc.error, undefined);
  assert.match(jsonc.text, /\/\/ line comment/);
  assert.match(jsonc.text, /\/\* block \*\//);
  assert.match(jsonc.text, /https:\/\/example.com\/a\/\/b/);
  assert.match(jsonc.text, /2,\n\s+\]/);
});

test('invalid or deeply nested source returns its exact original text', async () => {
  for (const [format, text] of [
    ['css', 'body { color:'], ['json', '{"value":1,}'], ['json', '{/* comment */"value":1}'],
    ['jsonc', '{unquoted:1}'], ['jsonc', '{"value":undefined}'], ['jsonc', '{"value":'],
    ['json', '['.repeat(257) + '0' + ']'.repeat(257)],
  ] as const) {
    const result = await format_document({ format, text });
    assert.equal(result.text, text);
    assert.match(result.error ?? '', /could not be formatted/);
  }
});

test('source formatting enforces UTF-8 byte limits before launching a worker', async () => {
  let created = 0;
  const formatter = new source_formatter(() => { created++; return new fake_worker(); });
  for (const text of ['x'.repeat(max_format_input_bytes + 1), '中'.repeat(Math.ceil(max_format_input_bytes / 3))]) {
    const result = await formatter.format(text, 'css');
    assert.equal(result.text, text);
    assert.match(result.error ?? '', /4 MiB/);
  }
  assert.equal(created, 0);
  formatter.dispose();
});

class fake_worker {
  onmessage: Worker['onmessage'] = null;
  onerror: Worker['onerror'] = null;
  terminated = false;
  request?: document_format_request;
  postMessage(request: document_format_request): void { this.request = request; }
  terminate(): void { this.terminated = true; }
  reply(data: unknown): void { this.onmessage?.call(this as unknown as Worker, { data } as MessageEvent); }
}

test('a newer formatting request cancels stale work and releases both workers', async () => {
  const first = new fake_worker();
  const second = new fake_worker();
  const workers = [first, second];
  const formatter = new source_formatter(() => workers.shift()!);
  const old = formatter.format('old', 'css');
  await next_turn();
  const newer = formatter.format('new', 'css');
  await next_turn();
  assert.deepEqual(await old, { text: 'old', cancelled: true });
  assert.equal(first.terminated, true);
  second.reply({ text: 'new formatted' });
  assert.deepEqual(await newer, { text: 'new formatted' });
  assert.equal(second.terminated, true);
  formatter.dispose();
});

test('disposing while worker assets load settles the request and kills a late worker', async () => {
  const worker = new fake_worker();
  let finish!: (worker: fake_worker) => void;
  const formatter = new source_formatter(() => new Promise(resolve => { finish = resolve; }));
  const result = formatter.format('old', 'css');
  formatter.dispose();
  assert.deepEqual(await result, { text: 'old', cancelled: true });
  finish(worker);
  await next_turn();
  assert.equal(worker.terminated, true);
  assert.equal(worker.request, undefined);
  assert.deepEqual(await formatter.format('late', 'css'), { text: 'late', cancelled: true });
});

test('a pathological formatter times out without blocking the preview', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = new fake_worker();
  const formatter = new source_formatter(() => worker);
  const result = formatter.format('original', 'css');
  await next_turn();
  context.mock.timers.tick(5_000);
  assert.deepEqual(await result, { text: 'original', error: 'Formatting took too long. Showing the original source.' });
  assert.equal(worker.terminated, true);
  formatter.dispose();
});

test('malformed worker responses or unavailable assets keep the original source', async () => {
  const worker = new fake_worker();
  const formatter = new source_formatter(() => worker);
  const result = formatter.format('original', 'css');
  await next_turn();
  worker.reply({ text: null });
  assert.equal((await result).text, 'original');
  assert.match((await result).error ?? '', /invalid result/);
  assert.equal(worker.terminated, true);
  const failing = new source_formatter(() => { throw new Error('missing assets'); });
  assert.equal((await failing.format('original', 'css')).text, 'original');
  formatter.dispose();
  failing.dispose();
});
