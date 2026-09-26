import assert from 'node:assert/strict';
import test from 'node:test';
import { terminal_indicator, show_tab_indicator, tab_completion_tracker, version_label } from '../webview/status';

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

test('viewing a completion hides only that tab result and leaves the footer and new bells intact', () => {
  const tracker = new tab_completion_tracker();
  const completed = { id: 'one', status: 'running' as const, command_status: 'completed' as const, command_revision: 1 };
  tracker.observe(completed);
  assert.equal(tracker.is_viewed(completed), false);
  tracker.view(completed);
  assert.equal(show_tab_indicator(completed, false, tracker.is_viewed(completed)), false);
  assert.equal(show_tab_indicator(completed, true, tracker.is_viewed(completed)), true);
  assert.equal(terminal_indicator(completed), 'completed');
  tracker.observe({ ...completed });
  assert.equal(tracker.is_viewed({ ...completed }), true, 'a full state redraw does not restore the dot');
  assert.equal(tracker.is_viewed({ ...completed, id: 'two' }), false, 'other tabs are independent');
  assert.equal(tracker.is_viewed({ ...completed, command_revision: 2 }), false, 'a later fast completion is new');
});

test('viewing running or failed commands never dismisses their status and resets older acknowledgements', () => {
  const tracker = new tab_completion_tracker();
  const completed = { id: 'one', status: 'running' as const, command_status: 'completed' as const };
  for (const command_status of ['running', 'error'] as const) {
    tracker.view(completed);
    const session = { ...completed, command_status };
    tracker.observe(session);
    tracker.view(session);
    assert.equal(show_tab_indicator(session, false, tracker.is_viewed(session)), true);
    assert.equal(tracker.is_viewed(completed), false);
  }
});

test('successful process exits can be acknowledged and resets forget old completions', () => {
  const tracker = new tab_completion_tracker();
  const completed = { id: 'one', status: 'exited' as const, exit_code: 0 };
  tracker.view(completed);
  assert.equal(show_tab_indicator(completed, false, tracker.is_viewed(completed)), false);
  assert.equal(tracker.is_viewed({ ...completed, exit_code: 1 }), false);
  tracker.delete('one');
  assert.equal(tracker.is_viewed(completed), false);
  tracker.view(completed);
  tracker.observe({ id: 'one', status: 'running' });
  assert.equal(tracker.is_viewed(completed), false);
});

test('the footer badge shows only a plain package version', () => {
  assert.equal(version_label('0.11.0'), 'v0.11.0');
  assert.equal(version_label(' 1.2.3-beta.1 '), 'v1.2.3-beta.1');
  for (const value of [undefined, '', 'Unknown', '0.11', '0.11.0<script>', 'v0.11.0']) {
    assert.equal(version_label(value), undefined, `rejects ${String(value)}`);
  }
});
