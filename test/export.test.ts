import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import type { IBufferCell, Terminal } from '@xterm/xterm';
import { maximum_html_export, terminal_html, terminal_markdown } from '../webview/export';
import { palette_colour, pdf_cell_style, pdf_page_layout, snapshot_terminal, terminal_pdf } from '../webview/pdf_export';
import type { SerializeAddon } from '@xterm/addon-serialize';

function cell(overrides: Partial<IBufferCell> = {}): IBufferCell {
  return {
    getWidth: () => 1, getChars: () => 'a', getCode: () => 97,
    getFgColorMode: () => 0, getBgColorMode: () => 0, getFgColor: () => 0, getBgColor: () => 0,
    isBold: () => 0, isItalic: () => 0, isDim: () => 0, isUnderline: () => 0,
    isBlink: () => 0, isInverse: () => 0, isInvisible: () => 0, isStrikethrough: () => 0, isOverline: () => 0,
    isFgRGB: () => false, isBgRGB: () => false, isFgPalette: () => false, isBgPalette: () => false,
    isFgDefault: () => true, isBgDefault: () => true, isAttributeDefault: () => true,
    ...overrides,
  };
}

function terminal(rows: IBufferCell[][], columns = rows[0]?.length ?? 1): Terminal {
  return {
    cols: columns, options: { fontFamily: 'monospace', fontSize: 14, theme: { foreground: '#123456', background: '#eeeeee' } },
    buffer: { active: { length: rows.length, getLine: (index: number) => rows[index] && { getCell: (column: number) => rows[index]![column] } } },
  } as unknown as Terminal;
}

test('PDF palette honours terminal theme, true colour, extended palette and bright bold', () => {
  assert.equal(palette_colour(1, { red: '#abcdef' }), '#abcdef');
  assert.equal(palette_colour(16, { extendedAnsi: ['#112233'] }), '#112233');
  assert.equal(palette_colour(16, {}), '#000000');
  assert.equal(palette_colour(21, {}), '#0000ff');
  assert.equal(palette_colour(231, {}), '#ffffff');
  assert.equal(palette_colour(232, {}), '#080808');
  assert.equal(palette_colour(255, {}), '#eeeeee');
  const theme = { foreground: '#aaaaaa', background: '#222222', red: '#ff0000', brightRed: '#ff7777' };
  const bold_red = cell({ isBold: () => 1, isFgPalette: () => true, getFgColor: () => 1 });
  assert.equal(pdf_cell_style(bold_red, theme).foreground, theme.brightRed);
  assert.equal(pdf_cell_style(bold_red, theme, false).foreground, theme.red);
  const rgb = pdf_cell_style(cell({ isFgRGB: () => true, getFgColor: () => 0x12ab34, isInverse: () => 1 }), theme);
  assert.equal(rgb.foreground, theme.background);
  assert.equal(rgb.background, '#12ab34');
});

test('PDF snapshot retains wide/combined glyph positions and styled blank backgrounds', () => {
  const view = terminal([
    [cell({ getChars: () => '中', getWidth: () => 2 }), cell({ getChars: () => '', getWidth: () => 0 }), cell({ getChars: () => 'e\u0301' })],
    [cell({ getChars: () => '', isAttributeDefault: () => false, isBgRGB: () => true, getBgColor: () => 0x00ff00 })],
    [cell({ getChars: () => '' })],
  ]);
  const snapshot = snapshot_terminal(view, view.options.theme!);
  assert.equal(snapshot.rows.length, 2);
  assert.deepEqual(snapshot.rows[0]!.map(({ column, text, width }) => ({ column, text, width })), [
    { column: 0, text: '中', width: 2 }, { column: 2, text: 'e\u0301', width: 1 },
  ]);
  assert.equal(snapshot.styles[snapshot.rows[1]![0]!.style]!.background, '#00ff00');
  assert.equal(snapshot.styles.length, 2);
});

test('PDF layout and snapshot reject excessive work before allocating image pages', () => {
  assert.throws(() => snapshot_terminal(terminal([], 1001), {}), /cell limit/);
  const huge = { cols: 200, buffer: { active: { length: 10000 } } } as Terminal;
  assert.throws(() => snapshot_terminal(huge, {}), /cell limit/);
  const layout = pdf_page_layout(80, 200, 8, 18);
  assert.ok(layout.pages > 1);
  assert.ok(layout.rows_per_page > 0);
  assert.ok(layout.page_height > layout.page_width);
  const wide = pdf_page_layout(160, 200, 8, 18);
  assert.ok(wide.page_width > wide.page_height);
  assert.throws(() => pdf_page_layout(80, 20000, 8, 18), /100-page/);
  assert.throws(() => pdf_page_layout(80, 20, NaN, 18), /dimensions/);
});

test('HTML and Markdown reject oversized source before constructing a DOM', () => {
  const serializer = { serializeAsHTML: () => 'x'.repeat(maximum_html_export + 1) } as SerializeAddon;
  assert.throws(() => terminal_html(serializer, 'large'), /8 MiB/);
  assert.throws(() => terminal_markdown(serializer, 'large'), /8 MiB/);
});

test('PDF output is a readable PDF with one raster image per page and a stable snapshot', async () => {
  const previous_document = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const calls: Array<{ text: string; x: number; y: number; colour: string }> = [];
  let glyph = '中';
  const context = {
    font: '', fillStyle: '', globalAlpha: 1,
    measureText: () => ({ width: 8, actualBoundingBoxAscent: 11, actualBoundingBoxDescent: 3 }),
    setTransform: () => {}, fillRect: () => {},
    fillText(text: string, x: number, y: number) { calls.push({ text, x, y, colour: this.fillStyle }); },
  };
  // A small PNG fixture keeps this a PDF-container regression test; actual font
  // and image rendering is verified in a real browser during UI acceptance.
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aAb8AAAAASUVORK5CYII=', 'base64'));
  const canvas = {
    width: 0, height: 0, getContext: () => context,
    toBlob(callback: (blob: { arrayBuffer: () => Promise<ArrayBuffer> }) => void) {
      callback({ arrayBuffer: async () => png.buffer });
    },
  };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: () => canvas,
    fonts: { load: async () => { glyph = 'changed after snapshot'; } },
  } });
  try {
    const rows = Array.from({ length: 100 }, () => [cell({ getChars: () => glyph, getWidth: () => 2 }), cell({ getWidth: () => 0 })]);
    const encoded = await terminal_pdf(terminal(rows, 80), '中文 terminal');
    const bytes = Buffer.from(encoded, 'base64');
    assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
    const pdf = await PDFDocument.load(bytes);
    assert.equal(pdf.getTitle(), '中文 terminal');
    assert.ok(pdf.getPageCount() >= 2);
    assert.equal(calls.length, 100);
    assert.ok(calls.every(call => call.text === '中' && call.x === 0 && call.colour === '#123456'));
    assert.equal(canvas.width, 0);
    assert.equal(canvas.height, 0);
  } finally {
    if (previous_document) Object.defineProperty(globalThis, 'document', previous_document);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
