import assert from 'node:assert/strict';
import test from 'node:test';
import { terminal_indicator, show_tab_indicator } from '../webview/status';

test('tab and footer use the same command result without mistaking an idle shell for a command', () => {
  const shell = { id: 'one', status: 'running' as const };
  assert.equal(show_tab_indicator(shell, false), false);
  assert.equal(show_tab_indicator(shell, true), true);
  for (const status of ['running', 'completed', 'error'] as const) {
    const session = { ...shell, command_status: status };
    assert.equal(terminal_indicator(session), status);
    assert.equal(show_tab_indicator(session, false), true);
  }
  assert.equal(terminal_indicator({ id: 'one', status: 'exited', exit_code: 0 }), 'completed');
  assert.equal(terminal_indicator({ id: 'one', status: 'exited', exit_code: 2 }), 'error');
  assert.equal(terminal_indicator({ id: 'one', status: 'error', command_status: 'completed' }), 'error');
  assert.equal(show_tab_indicator({ id: 'one', status: 'exited' }, false), false);
});
