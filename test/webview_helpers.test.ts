import test from 'node:test';
import assert from 'node:assert/strict';
import type { Terminal } from '@xterm/xterm';
import { find_file_links, link_modifier, read_link_line } from '../webview/terminal_links';
import { is_find_shortcut, is_replace_shortcut } from '../webview/search';
import { terminal_text } from '../webview/export';

test('file links parse diagnostic locations, Windows paths and paths with spaces', () => {
  const cases = [
    ['src/main.ts:12:3', 'src/main.ts', 12, 3],
    ['foo.ts:42', 'foo.ts', 42, undefined],
    ['Error /Users/me/My Project/main.ts:5:2 failure', '/Users/me/My Project/main.ts', 5, 2],
    ['"my folder/file.ts":9:4', 'my folder/file.ts', 9, 4],
    ["'my folder/file.ts:9:4'", 'my folder/file.ts', 9, 4],
    ['C:\\Work\\My Folder\\main.ts:25:2', 'C:\\Work\\My Folder\\main.ts', 25, 2],
    ['./folder/file.txt', './folder/file.txt', 1, undefined],
    ['../src/main.ts:3:4', '../src/main.ts', 3, 4],
  ] as const;
  for (const [source, path, line, column] of cases) {
    const links = find_file_links(source);
    assert.equal(links.length, 1, source);
    assert.equal(links[0]!.path, path, source);
    assert.equal(links[0]!.line, line, source);
    assert.equal(links[0]!.column, column, source);
  }
  assert.deepEqual(find_file_links('at /tmp/a.js:4 and /tmp/b.js:5').map(link => link.path), ['/tmp/a.js', '/tmp/b.js']);
});

test('file links avoid URLs, prose and invalid locations', () => {
  for (const text of ['https://example.com/src/main.ts:12', 'http://localhost:3000/path', 'unrelated prose', 'foo.ts:0', 'foo.ts:1:0', 'foo.ts:99999999999999999', 'a'.repeat(8193)]) {
    assert.deepEqual(find_file_links(text), [], text.slice(0, 80));
  }
});

test('terminal links and find require platform modifiers without competing modifiers', () => {
  const plain = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
  assert.equal(link_modifier(plain, true), false);
  assert.equal(link_modifier({ ...plain, metaKey: true }, true), true);
  assert.equal(link_modifier({ ...plain, ctrlKey: true }, false), true);
  assert.equal(link_modifier({ ...plain, metaKey: true, altKey: true }, true), false);
  assert.equal(link_modifier({ ...plain, ctrlKey: true, shiftKey: true }, false), false);
  const find = { ...plain, key: 'f', isComposing: false };
  assert.equal(is_find_shortcut({ ...find, metaKey: true }, true), true);
  assert.equal(is_find_shortcut({ ...find, ctrlKey: true }, false), true);
  assert.equal(is_find_shortcut({ ...find, ctrlKey: true, isComposing: true }, false), false);
  assert.equal(is_find_shortcut({ ...find, ctrlKey: true, shiftKey: true }, false), false);
  assert.equal(is_replace_shortcut({ ...find, metaKey: true, altKey: true }, true), true);
  assert.equal(is_replace_shortcut({ ...find, key: 'ƒ', code: 'KeyF', metaKey: true, altKey: true }, true), true);
  assert.equal(is_replace_shortcut({ ...find, key: 'h', code: 'KeyH', metaKey: true }, true), false);
  assert.equal(is_replace_shortcut({ ...find, key: 'h', ctrlKey: true }, false), true);
  assert.equal(is_replace_shortcut({ ...find, key: 'h', ctrlKey: true }, true), false);
  assert.equal(is_replace_shortcut({ ...find, metaKey: true, altKey: true, isComposing: true }, true), false);
});

test('file link offsets follow wide, combined and wrapped terminal cells', () => {
  const cell = (chars: string, width = 1) => ({ getChars: () => chars, getWidth: () => width });
  const rows = [
    { isWrapped: false, cells: [cell('中', 2), cell('', 0), cell('e\u0301'), cell(' '), cell('a'), cell('.')] },
    { isWrapped: true, cells: [cell('t'), cell('s'), cell(':'), cell('1'), cell('2'), cell(' ')] },
  ];
  const terminal = { buffer: { active: { getLine: (index: number) => {
    const row = rows[index];
    return row && { isWrapped: row.isWrapped, length: row.cells.length, getCell: (column: number) => row.cells[column] };
  } } } } as unknown as Terminal;
  const logical_line = read_link_line(terminal, 2)!;
  assert.equal(logical_line.text, '中e\u0301 a.ts:12 ');
  const link = find_file_links(logical_line.text)[0]!;
  assert.equal(link.path, 'a.ts');
  assert.deepEqual(logical_line.starts[link.start], { x: 5, y: 1 });
  assert.deepEqual(logical_line.ends[link.end - 1], { x: 5, y: 2 });
  assert.deepEqual(logical_line.starts[2], { x: 3, y: 1 });
});

test('plain export joins wrapped rows and preserves real line breaks', () => {
  const rows = [
    { isWrapped: false, translateToString: () => 'long command ' },
    { isWrapped: true, translateToString: () => 'continued' },
    { isWrapped: false, translateToString: () => 'result' },
    { isWrapped: false, translateToString: () => '' },
  ];
  const terminal = { buffer: { active: { length: rows.length, getLine: (index: number) => rows[index] } } } as unknown as Terminal;
  assert.equal(terminal_text(terminal), 'long command continued\nresult\n');
});
