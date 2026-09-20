import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire as create_require } from 'node:module';
import { snapshot_terminal, reveal_terminal } from '../webview/terminal_text';
const { Terminal } = create_require(__filename)('@xterm/xterm') as typeof import('@xterm/xterm');

test('global terminal results select across soft wraps, hard newlines and wide characters', async () => {
  for (const [text, expected] of [['hello world', 'hello world'], ['hello\r\nworld', 'hello\nworld'], ['你好世界', '你好世界']]) {
    const terminal = new Terminal({ cols: 6, rows: 10, allowProposedApi: true });
    await new Promise<void>(resolve => terminal.write(text, resolve));
    const snapshot = snapshot_terminal(terminal);
    assert.ok(snapshot.text.startsWith(expected));
    const selections: number[][] = [];
    terminal.select = (column, row, length) => { selections.push([column, row, length]); };
    terminal.scrollToLine = () => {};
    reveal_terminal(terminal, { page: 0, start: 0, end: expected.length });
    assert.deepEqual(selections, [[0, 0, text === '你好世界' ? 8 : 11]]);
    terminal.dispose();
  }
});
