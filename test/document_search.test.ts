import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as next_turn } from 'node:timers/promises';
import { document_search, normalize_search_text, search_source_range, type document_match, type document_search_status } from '../webview/document_search';
import { find_document_matches, type document_search_request } from '../webview/document_search_worker';

function match(text: string, query: string, options: Partial<document_search_request> = {}) {
  return find_document_matches({ text, query, case_sensitive: false, whole_word: false, regex: false, limit: 100, ...options });
}

test('document find handles escaped literals, Unicode whole words, regex and zero-length patterns', () => {
  assert.deepEqual(match('a.b a?b A.B', 'a.b').matches, [{ start: 0, end: 3 }, { start: 8, end: 11 }]);
  assert.deepEqual(match('École école préécole école2', 'école', { whole_word: true }).matches,
    [{ start: 0, end: 5 }, { start: 6, end: 11 }]);
  assert.equal(match('École école', 'école', { case_sensitive: true }).matches.length, 1);
  assert.deepEqual(match('row 12, row 34', 'row \\d+', { regex: true }).matches,
    [{ start: 0, end: 6 }, { start: 8, end: 14 }]);
  assert.deepEqual(match('😀 hello', '(?=.)', { regex: true }).matches, []);
  assert.equal(match('anything', '[', { regex: true }).message, 'Invalid regular expression');
  assert.equal(match('a a a', 'a', { limit: 2 }).truncated, true);
});

test('cross-line document matches map back to original text without shifting Unicode offsets', () => {
  const source = '  😀 alpha\n\t beta  gamma';
  const normalized = normalize_search_text(source);
  assert.equal(normalized, ' 😀 alpha beta gamma');
  const hit = match(normalized, 'alpha beta').matches[0];
  const range = search_source_range(source, hit.start, hit.end);
  assert.equal(source.slice(range.start, range.end), 'alpha\n\t beta');
  const emoji = match(normalized, '😀').matches[0];
  const emoji_range = search_source_range(source, emoji.start, emoji.end);
  assert.equal(source.slice(emoji_range.start, emoji_range.end), '😀');
});

class fake_worker {
  onmessage: Worker['onmessage'] = null;
  onerror: Worker['onerror'] = null;
  terminated = false;
  postMessage(request: document_search_request): void {
    queueMicrotask(() => {
      if (!this.terminated) this.onmessage?.call(this as unknown as Worker,
        { data: find_document_matches(request) } as MessageEvent);
    });
  }
  terminate(): void { this.terminated = true; }
}

test('document search indexes every page, wraps both ways and reindexes after refresh', async () => {
  let pages = ['First needle.', 'No match here.', 'Last needle then needle.'];
  const reads: number[] = [];
  const selected: Array<document_match | undefined> = [];
  const results: document_search_status[] = [];
  const search = new document_search({
    page_count: () => pages.length,
    read_page: async page => { reads.push(page); return pages[page]; },
    select_match: match => selected.push(match),
  }, () => new fake_worker());
  search.onDidChangeResults(result => results.push(result));
  assert.equal(search.findNext('needle'), true);
  await next_turn();
  assert.deepEqual(reads, [0, 1, 2]);
  assert.equal(results.at(-1)?.resultCount, 3);
  assert.equal(selected.at(-1)?.page, 0);
  search.findPrevious('needle');
  assert.equal(results.at(-1)?.resultIndex, 2);
  search.findNext('needle');
  assert.equal(results.at(-1)?.resultIndex, 0);
  search.findNext('NEEDLE', { caseSensitive: true });
  await next_turn();
  assert.equal(results.at(-1)?.resultCount, 0);
  assert.deepEqual(reads, [0, 1, 2], 'repeat queries reuse extracted text');
  pages = ['NEW NEEDLE'];
  search.reset();
  await next_turn();
  assert.equal(results.at(-1)?.resultCount, 1);
  assert.deepEqual(reads, [0, 1, 2, 0]);
  search.dispose();
});

test('stale page extraction cannot emit results or highlights after cancellation', async () => {
  let finish!: (text: string) => void;
  let calls = 0;
  const results: document_search_status[] = [];
  const selected: Array<document_match | undefined> = [];
  const search = new document_search({
    page_count: () => 1,
    read_page: () => ++calls === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve('new text'),
    select_match: match => selected.push(match),
  }, () => new fake_worker());
  search.onDidChangeResults(result => results.push(result));
  search.findNext('old');
  await next_turn();
  search.findNext('new');
  await next_turn();
  finish('old old old');
  await next_turn();
  assert.equal(results.at(-1)?.resultCount, 1);
  assert.deepEqual(selected.at(-1), { page: 0, start: 0, end: 3 });
  search.dispose();
});

test('a pathological search worker is terminated while the UI remains responsive', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = new fake_worker();
  worker.postMessage = () => undefined;
  const results: document_search_status[] = [];
  const search = new document_search({
    page_count: () => 1, read_page: async () => 'a'.repeat(1000), select_match: () => undefined,
  }, () => worker);
  search.onDidChangeResults(result => results.push(result));
  search.findNext('(a+)+$', { regex: true });
  await next_turn();
  context.mock.timers.tick(1500);
  await next_turn();
  assert.equal(worker.terminated, true);
  assert.match(results.at(-1)?.message ?? '', /too long/);
  search.dispose();
});

test('a worker fetched after its search is cancelled is immediately terminated', async () => {
  const worker = new fake_worker();
  let finish!: (worker: fake_worker) => void;
  let reads = 0;
  const search = new document_search({
    page_count: () => 1, read_page: async () => { reads++; return 'example'; }, select_match: () => undefined,
  }, () => new Promise(resolve => { finish = resolve; }));
  search.findNext('example');
  search.dispose();
  finish(worker);
  await next_turn();
  assert.equal(worker.terminated, true);
  assert.equal(reads, 0);
});

test('automatic reindex preserves the selected hit and does not request reader navigation', async () => {
  const selections: Array<{ match?: document_match; reveal: boolean }> = [];
  const search = new document_search({
    page_count: () => 3, read_page: async () => 'needle',
    select_match: (match, _matches, reveal) => selections.push({ match, reveal }),
  }, () => new fake_worker());
  search.findNext('needle');
  await next_turn();
  search.findNext('needle');
  search.findNext('needle');
  assert.equal(selections.at(-1)?.match?.page, 2);
  assert.equal(selections.at(-1)?.reveal, true);
  search.reset();
  await next_turn();
  assert.equal(selections.at(-1)?.match?.page, 2);
  assert.equal(selections.at(-1)?.reveal, false);
  search.findNext('needle');
  assert.equal(selections.at(-1)?.match?.page, 0);
  assert.equal(selections.at(-1)?.reveal, true);
  search.dispose();
});
