import assert from 'node:assert/strict';
import test from 'node:test';
import { is_client_message } from '../src/profiles';

test('global search validates sides, request IDs, bounded snapshots and result coordinates', () => {
  assert.equal(is_client_message({ type: 'search_snapshot', request: 'r', snapshot: { text: 'test', rows: [null] } }), false);
  assert.equal(is_client_message({ type: 'search_catalog', request: 'request_1' }), true);
  assert.equal(is_client_message({ type: 'search_read', request: 'r', side: 'right', id: 'pdf' }), true);
  assert.equal(is_client_message({ type: 'search_read', request: 'r', side: '../outside', id: 'pdf' }), false);
  assert.equal(is_client_message({ type: 'search_read', request: 'r', side: 'right', id: '../../file' }), false);
  assert.equal(is_client_message({ type: 'search_snapshot', request: 'r', snapshot: { text: 'test', rows: [{ row: 0, offset: 5 }] } }), false);
  assert.equal(is_client_message({ type: 'search_snapshot', request: 'r', snapshot: { text: 'x'.repeat(4 * 1024 * 1024 + 1), rows: [] } }), false);
  assert.equal(is_client_message({ type: 'search_reveal', side: 'left', id: 't', query: 'test', location: { page: 0, start: 5, end: 2 } }), false);
});
