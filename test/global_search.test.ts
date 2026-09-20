import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import * as path from 'node:path';
import { runInNewContext as run_in_new_context } from 'node:vm';
import { randomUUID as random_uuid } from 'node:crypto';
import { setImmediate as next_turn } from 'node:timers/promises';
import type { global_search } from '../webview/global_search';
import type { client_message } from '../src/types';
import type { search_tab } from '../src/global_search_protocol';
import { find_document_matches, type document_search_request } from '../webview/document_search_worker';
import type { document_search_status } from '../webview/document_search';

const bundle = build({ entryPoints: [path.resolve(__dirname, '../webview/global_search.ts')],
  bundle: true, write: false, platform: 'browser', format: 'cjs', loader: { '.css': 'empty' },
}).then(result => result.outputFiles[0].text);
class element {
  hidden = false;
  textContent = '';
  children: element[] = [];
  listeners = new Map<string, () => void>();
  setAttribute() {}
  append(...children: element[]) { this.children.push(...children); }
  replaceChildren(...children: element[]) { this.children = children; }
  addEventListener(type: string, callback: () => void) { this.listeners.set(type, callback); }
  remove() {}
}
class worker {
  onmessage: Worker['onmessage'] = null;
  onerror: Worker['onerror'] = null;
  terminated = false;
  postMessage(request: document_search_request) {
    queueMicrotask(() => { if (!this.terminated) this.onmessage?.call(this as unknown as Worker, { data: find_document_matches(request) } as MessageEvent); });
  }
  terminate() { this.terminated = true; }
}
async function harness(tabs: search_tab[]) {
  const module = { exports: {} as { global_search: typeof global_search } };
  run_in_new_context(await bundle, { module, exports: module.exports, setTimeout, clearTimeout,
    crypto: { randomUUID: random_uuid }, document: { querySelector: () => null, createElement: () => new element() },
  });
  const messages: client_message[] = [];
  const search = new module.exports.global_search(message => { messages.push(message); }, () => new worker());
  const states: document_search_status[] = [];
  search.onDidChangeResults(state => states.push(state));
  const prepare = search.prepare();
  const catalog = messages.pop();
  assert.ok(catalog?.type === 'search_catalog');
  search.receive({ type: 'search_catalog', request: catalog.request, tabs });
  await prepare;
  const source = (request: Extract<client_message, { type: 'search_read' }>, text: string) => search.receive({
    type: 'search_source', request: request.request, source: { kind: 'terminal', snapshot: { text, rows: [{ row: 0, offset: 0 }] } },
  });
  return { search, messages, states, source };
}

test('global results distinguish identical runtime IDs on both sides and clicked matches update navigation', async () => {
  const h = await harness([{ side: 'left', id: 'same', name: 'Primary', kind: 'terminal' },
    { side: 'right', id: 'same', name: 'Secondary', kind: 'terminal' }]);
  h.search.findNext('needle', { incremental: true });
  await next_turn();
  const first = h.messages.at(-1);
  assert.ok(first?.type === 'search_read' && first.side === 'left');
  h.source(first, 'needle');
  await next_turn();
  const second = h.messages.at(-1);
  assert.ok(second?.type === 'search_read' && second.side === 'right');
  h.source(second, 'needle then needle');
  await next_turn();
  assert.equal(h.states.at(-1)?.resultCount, 3);
  assert.ok(!h.messages.some(message => message.type === 'search_reveal'), 'typing does not steal focus');
  const results = h.search.root as unknown as element;
  results.children[3].listeners.get('click')!();
  assert.equal(h.states.at(-1)?.resultIndex, 2);
  const reveal = h.messages.at(-1);
  assert.ok(reveal?.type === 'search_reveal' && reveal.side === 'right');
  assert.deepEqual(JSON.parse(JSON.stringify(reveal.location)), { page: 0, start: 12, end: 18 });
  h.search.findNext('needle');
  const next = h.messages.at(-1);
  assert.ok(next?.type === 'search_reveal' && next.side === 'left', 'next wraps after the clicked result');
  h.search.dispose();
});

test('query changes reuse an in-flight source and closing ignores its late reply', async () => {
  const h = await harness([{ side: 'left', id: 't', name: 'Terminal', kind: 'terminal' }]);
  h.search.findNext('old', { incremental: true });
  await next_turn();
  h.search.findNext('new', { incremental: true });
  await next_turn();
  assert.equal(h.messages.filter(message => message.type === 'search_read').length, 1);
  const request = h.messages.at(-1);
  assert.ok(request?.type === 'search_read');
  h.source(request, 'new');
  await next_turn();
  assert.equal(h.states.at(-1)?.resultCount, 1);
  h.search.end();
  h.source(request, 'old old old');
  await next_turn();
  assert.equal(h.search.root.hidden, true);
  assert.equal(h.states.at(-1)?.resultCount, 0);
  h.search.dispose();
});
