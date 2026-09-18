import assert from 'node:assert/strict';
import test from 'node:test';
import { is_export_payload, maximum_pdf_base64 } from '../src/export_format';
import { export_filename } from '../src/terminal_actions';

test('export boundary separates text, markup and bounded PDF base64', () => {
  assert.equal(is_export_payload(undefined, 'plain'), true);
  assert.equal(is_export_payload('markdown', '# Title'), true);
  assert.equal(is_export_payload('pdf', Buffer.from('%PDF-1.7\n%%EOF').toString('base64')), true);
  for (const text of ['JVBERi0=', 'JVBERi0 ', 'JVBERi0=AAAA', 'data:application/pdf;base64,JVBERi0=', 'JVBERi0' + 'A'.repeat(maximum_pdf_base64)]) {
    assert.equal(is_export_payload('pdf', text), false, text.slice(0, 30));
  }
  assert.equal(is_export_payload('svg', '<svg/>'), false);
  assert.equal(is_export_payload('html', 'x'.repeat(8 * 1024 * 1024 + 1)), false);
  assert.equal(export_filename('build', 'pdf'), 'build.pdf');
  assert.equal(export_filename('build', 'markdown'), 'build.md');
});
