import type { Terminal } from '@xterm/xterm';
import type { terminal_snapshot, search_location } from '../src/global_search_protocol';

/** Preserve wrapped rows without inserting a newline into a logical terminal line. */
export function snapshot_terminal(terminal: Terminal): terminal_snapshot {
  const buffer = terminal.buffer.active;
  let text = '';
  const rows: terminal_snapshot['rows'] = [];
  for (let row = 0; row < buffer.length; row++) {
    const line = buffer.getLine(row)!;
    if (row && !line.isWrapped) text += '\n';
    rows.push({ offset: text.length, row });
    text += line.translateToString(true);
    if (text.length > 4 * 1024 * 1024) throw new Error('Terminal buffer is too large to search');
  }
  return { text, rows };
}

/** Match offsets are UTF-16; xterm selections use display cells (including wide glyphs). */
export function reveal_terminal(terminal: Terminal, location: search_location): void {
  const buffer = terminal.buffer.active;
  let characters = 0;
  let start: number | undefined;
  let end: number | undefined;
  for (let row = location.page; row < buffer.length && characters < location.end; row++) {
    const line = buffer.getLine(row);
    if (!line) break;
    if (row > location.page && !line.isWrapped) characters++;
    const text_length = line.translateToString(true).length;
    let line_characters = 0;
    for (let column = 0; column < line.length && line_characters < text_length; column++) {
      const cell = line.getCell(column);
      if (!cell || cell.getWidth() === 0) continue;
      const length = cell.getChars().length || 1;
      const position = row * terminal.cols + column;
      if (start === undefined && characters + length > location.start) start = position;
      if (start !== undefined) end = position + cell.getWidth();
      characters += length;
      line_characters += length;
      if (characters >= location.end) break;
    }
  }
  if (start === undefined || end === undefined) return;
  terminal.select(start % terminal.cols, Math.floor(start / terminal.cols), Math.max(1, end - start));
  terminal.scrollToLine(Math.max(0, location.page - 3));
}
