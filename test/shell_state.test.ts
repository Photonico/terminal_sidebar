import assert from 'node:assert/strict';
import test from 'node:test';
import { is_local_cwd, shell_state_tracker } from '../src/shell_state';

function osc(value: string, ending = '\x07'): string {
  return `\x1b]${value}${ending}`;
}

test('OSC 7 and shell lifecycle notifications survive every chunk boundary and both terminators', () => {
  for (const ending of ['\x07', '\x1b\\']) {
    const output = `plain\x1b[32m${osc('7;file://work.local/tmp/hello%20world', ending)}${osc('633;C', ending)}`;
    for (let split = 0; split <= output.length; split++) {
      const tracker = new shell_state_tracker({ cwd: '/initial', hostname: 'work.local', platform: 'linux' });
      tracker.consume(output.slice(0, split));
      tracker.consume(output.slice(split));
      assert.deepEqual(tracker.state, { cwd: '/tmp/hello world', command_state: 'running', command_status: 'running' });
      tracker.consume(osc('633;D;0', ending));
      assert.equal(tracker.state.command_state, 'idle');
    }
  }
});

test('both lifecycle protocols track prompts and pre-execution without retaining command text', () => {
  for (const protocol of ['133', '633']) {
    const tracker = new shell_state_tracker();
    assert.equal(tracker.state.command_state, 'unknown');
    for (const [notification, expected] of [
      ['A', 'idle'], ['B', 'idle'], ['C', 'running'], ['D;1', 'idle'], ['C', 'running'], ['D', 'idle'],
    ]) {
      tracker.consume(osc(`${protocol};${notification}`));
      assert.equal(tracker.state.command_state, expected);
    }
    tracker.consume(osc('633;E;SECRET_COMMAND;nonce'));
    tracker.consume(osc('633;P;Unrelated=property'));
    assert.deepEqual(tracker.state, { command_state: 'idle' });
    const snapshot = tracker.state;
    snapshot.command_state = 'running';
    assert.equal(tracker.state.command_state, 'idle');
  }
});

test('input never proves completion, invalidates stale idle, and startup commands need a lifecycle update', () => {
  const tracker = new shell_state_tracker();
  tracker.input();
  assert.equal(tracker.state.command_state, 'unknown');
  tracker.consume(osc('133;A'));
  tracker.input();
  assert.equal(tracker.state.command_state, 'unknown');
  tracker.started_command();
  tracker.input();
  tracker.consume('a prompt-looking string $ ');
  assert.equal(tracker.state.command_state, 'running');
  tracker.consume(osc('133;D'));
  assert.equal(tracker.state.command_state, 'idle');
});

test('reported command results survive the next prompt and reset when the next command begins', () => {
  for (const protocol of ['133', '633']) {
    const tracker = new shell_state_tracker();
    tracker.consume(osc(`${protocol};A`));
    assert.deepEqual(tracker.state, { command_state: 'idle' });
    for (const exit_code of [0, 23, -1]) {
      tracker.consume(osc(`${protocol};C`));
      assert.deepEqual(tracker.state, { command_state: 'running', command_status: 'running' });
      tracker.consume(osc(`${protocol};D;${exit_code}`));
      const completed = {
        command_state: 'idle', command_status: exit_code === 0 ? 'completed' : 'error', command_exit_code: exit_code,
      };
      assert.deepEqual(tracker.state, completed);
      tracker.consume(osc(`${protocol};A`) + osc(`${protocol};B`));
      assert.deepEqual(tracker.state, completed, 'prompt output does not erase an observed command result');
      tracker.input();
      assert.deepEqual(tracker.state, { ...completed, command_state: 'unknown' });
    }
    tracker.started_command();
    assert.deepEqual(tracker.state, { command_state: 'running', command_status: 'running' });
  }
});

test('missing or unusable completion codes never invent command success', () => {
  for (const protocol of ['133', '633']) {
    for (const notification of ['D', 'D;9007199254740992', 'A', 'B']) {
      const tracker = new shell_state_tracker();
      tracker.consume(osc(`${protocol};C`));
      tracker.consume(osc(`${protocol};D;19`));
      tracker.consume(osc(`${protocol};C`));
      tracker.consume(osc(`${protocol};${notification}`));
      assert.deepEqual(tracker.state, { command_state: 'idle' });
    }
  }
});

test('initial and repeated prompt completion notifications cannot invent a command result', () => {
  for (const protocol of ['133', '633']) {
    const tracker = new shell_state_tracker();
    tracker.consume(osc(`${protocol};D;0`) + osc(`${protocol};A`) + osc(`${protocol};B`));
    tracker.consume(osc(`${protocol};D;1`) + osc(`${protocol};D;0`) + osc(`${protocol};A`));
    assert.deepEqual(tracker.state, { command_state: 'idle' }, 'a never-run terminal stays undecorated');

    tracker.consume(osc(`${protocol};C`) + osc(`${protocol};D;12`));
    const failed = { command_state: 'idle', command_status: 'error', command_exit_code: 12 };
    assert.deepEqual(tracker.state, failed);
    tracker.consume(osc(`${protocol};A`) + osc(`${protocol};B`) + osc(`${protocol};D;0`));
    tracker.consume(osc(`${protocol};D`));
    assert.deepEqual(tracker.state, failed, 'an unrelated prompt cannot overwrite the last observed failure');

    tracker.consume(osc(`${protocol};C`) + osc(`${protocol};A`) + osc(`${protocol};D;0`));
    assert.deepEqual(tracker.state, { command_state: 'idle' }, 'a prompt that ended an unknown run invalidates its pending completion');
    tracker.started_command();
    tracker.consume(osc(`${protocol};D;0`));
    assert.deepEqual(tracker.state, { command_state: 'idle', command_status: 'completed', command_exit_code: 0 },
      'an explicitly sent startup command provides command-start evidence');
  }
});

test('OSC 633 cwd values decode supported escapes and preserve native Windows paths', () => {
  const posix = new shell_state_tracker({ platform: 'linux' });
  posix.consume(osc('633;P;Cwd=/tmp/hello\\x20world\\x3bmore\\\\text'));
  assert.equal(posix.state.cwd, '/tmp/hello world;more\\text');
  posix.consume(osc('633;P;Cwd=/tmp/with-nonce;opaque-nonce'));
  assert.equal(posix.state.cwd, '/tmp/with-nonce');
  const windows = new shell_state_tracker({ platform: 'win32' });
  windows.consume(osc('633;P;Cwd=C:\\\\Users\\\\User\\x20Name'));
  assert.equal(windows.state.cwd, 'C:\\Users\\User Name');
  windows.consume(osc('7;file://localhost/D:/work/hello%20world'));
  assert.equal(windows.state.cwd, 'D:\\work\\hello world');
});

test('cwd accepts local hosts and rejects remote, malformed, relative, and network directory notifications', () => {
  const tracker = new shell_state_tracker({ cwd: '/initial', hostname: 'work.local', platform: 'linux' });
  for (const host of ['', 'localhost', 'WORK.LOCAL']) {
    tracker.consume(osc(`7;file://${host}/safe/${host || 'empty'}`));
    assert.equal(tracker.state.cwd, `/safe/${host || 'empty'}`);
  }
  const before = tracker.state;
  for (const sequence of [
    '7;file://remote.example/tmp', '7;https://localhost/tmp', '7;file:/tmp',
    '7;file://user@localhost/tmp', '7;file://localhost:123/tmp', '7;file:///tmp?query',
    '7;file:///tmp#fragment', '7;file:///bad%ZZ', '7;file:///bad%00', '7;file:////network/share',
    '7;file://localhost/%2Fnetwork', '7;file:///bad%5Cname', '7;file://localhost\\remote/tmp',
    '633;P;Cwd=relative/path', '633;P;Cwd=//network/share', '633;P;Cwd=/bad\\x0a',
    '633;P;Cwd=/bad;extra;parameters', '633;P;Cwd=ssh://host/tmp',
  ]) {
    tracker.consume(osc(sequence));
    assert.deepEqual(tracker.state, before, sequence);
  }
  const windows = new shell_state_tracker({ cwd: 'C:\\initial', platform: 'win32' });
  for (const value of ['\\\\server\\share', '\\\\?\\UNC\\server\\share', 'C:relative', '/posix', 'file:///C:/work']) {
    windows.consume(osc(`633;P;Cwd=${value}`));
    assert.equal(windows.state.cwd, 'C:\\initial');
  }
});

test('oversized, cancelled, unrelated, and malformed control strings cannot change state', () => {
  const tracker = new shell_state_tracker({ cwd: '/initial', platform: 'linux' });
  tracker.started_command();
  tracker.consume(osc(`633;P;Cwd=/${'x'.repeat(100_000)}`));
  tracker.consume(osc(`133;D;${'0'.repeat(100_000)}`));
  tracker.consume(osc('0;title 133;A'));
  tracker.consume(osc('133;ABC'));
  tracker.consume(osc('133;D;not-a-code'));
  tracker.consume(osc('633;P;Cwd=/bad\nline'));
  tracker.consume('\x1b]633;P;Cwd=/cancelled\x18\x07');
  tracker.consume(`\x1bP${osc('133;A')}\x1b\\`);
  tracker.consume(`\x1b_${osc('633;P;Cwd=/inside-apc')}\x1b\\`);
  assert.deepEqual(tracker.state, { cwd: '/initial', command_state: 'running', command_status: 'running' });
  tracker.consume('\x1b]malformed\x1b]133;A\x07');
  tracker.consume('\x9d7;file:///recovered\x9c');
  assert.deepEqual(tracker.state, { cwd: '/recovered', command_state: 'idle' });
});

test('cwd validation is bounded, native, and independent from filesystem existence', () => {
  for (const value of ['/path with spaces', '/nonexistent', '/']) assert.equal(is_local_cwd(value, 'linux'), true);
  for (const value of ['', null, 'relative', '//network', '/bad\x00', '/' + 'x'.repeat(4096)]) {
    assert.equal(is_local_cwd(value, 'linux'), false);
  }
  assert.equal(is_local_cwd('C:\\work', 'win32'), true);
  assert.equal(is_local_cwd('C:/work', 'win32'), true);
  assert.equal(is_local_cwd('C:work', 'win32'), false);
  assert.equal(is_local_cwd('\\\\host\\share', 'win32'), false);
});
