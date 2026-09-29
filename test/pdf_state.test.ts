import assert from 'node:assert/strict';
import test from 'node:test';
import { copy_pdf_position, is_pdf_position, type pdf_mode } from '../src/pdf_state';

test('PDF reading modes survive workspace position serialization', () => {
  for (const mode of ['continuous', 'horizontal', 'single', 'spread'] satisfies pdf_mode[]) {
    const position = { page: 12, zoom: 'page-width' as const, mode, dark: true };
    const restored: unknown = JSON.parse(JSON.stringify(copy_pdf_position(position)));
    assert.ok(is_pdf_position(restored));
    assert.deepEqual(restored, position);
  }
  assert.equal(is_pdf_position({ page: 1, zoom: 1, mode: 'diagonal' }), false);
});

test('older PDF positions retain absent mode and dark preferences', () => {
  const position = { page: 3, zoom: 1 };
  assert.ok(is_pdf_position(position));
  assert.deepEqual(copy_pdf_position(position), position);
});
