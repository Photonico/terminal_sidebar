import assert from 'node:assert/strict';
import { randomUUID as random_uuid } from 'node:crypto';
import { test } from 'node:test';
import { stripVTControlCharacters as strip_terminal_controls } from 'node:util';
import { session_manager, type pty_process, type pty_spawn_options } from '../src/sessions';
import { resolve_shell } from '../src/shell';
import type { shell_state } from '../src/shell_state';
import type { terminal_profile, session_info } from '../src/types';

class fake_terminal_process implements pty_process {
  process?: string;
  readonly writes: string[] = [];
  readonly sizes: Array<[number, number]> = [];
  readonly data_listeners: Array<(data: string) => void> = [];
  readonly exit_listeners: Array<(event: { exitCode: number }) => void> = [];
  killed = false;
  fail_input_output = false;
  disposed_listeners = 0;
  onData(listener: (data: string) => void) {
    this.data_listeners.push(listener);
    return { dispose: () => { this.disposed_listeners++; } };
  }
  onExit(listener: (event: { exitCode: number }) => void) {
    this.exit_listeners.push(listener);
    return { dispose: () => { this.disposed_listeners++; } };
  }
  write(data: string) {
    if (this.fail_input_output) throw new Error('already exited');
    this.writes.push(data);
  }
  resize(columns: number, rows: number) {
    if (this.fail_input_output) throw new Error('already exited');
    this.sizes.push([columns, rows]);
  }
  kill() {
    this.killed = true;
  }
  data(value: string) {
    for (const listener of this.data_listeners) listener(value);
  }
  exit(exit_code: number) {
    for (const listener of this.exit_listeners) listener({ exitCode: exit_code });
  }
}

const profile: terminal_profile = { id: 'one', name: 'One', command: 'printf hello', shell: '' };
function harness(platform: NodeJS.Platform = process.platform, on_state?: (info: session_info) => void) {
  const processes: fake_terminal_process[] = [];
  const states: session_info[] = [];
  const outputs: Array<[string, string]> = [];
  const spawns: pty_spawn_options[] = [];
  const shell_states: Array<[string, shell_state]> = [];
  const manager = new session_manager({
    resolve: () => ({ file: '/bin/sh', args: [], env: { TERM: 'xterm-256color' }, cwd: '/tmp' }),
    on_output: (id, data) => outputs.push([id, data]),
    on_state: (state) => {
      states.push(state);
      on_state?.(state);
    },
    platform,
    on_shell_state: (id, state) => shell_states.push([id, state]),
    factory: { spawn: (_file, _args, options) => {
      spawns.push(options);
      const terminal_process = new fake_terminal_process();
      processes.push(terminal_process);
      return terminal_process;
    } },
  });
  return { manager, processes, states, outputs, spawns, shell_states };
}

test('host tracks shell state and cwd independently of output consumers and ignores stale processes', () => {
  const runtime = harness('linux');
  runtime.manager.start({ ...profile, command: '' }, 80, 24);
  assert.deepEqual(runtime.manager.shell_state('one'), { cwd: '/tmp', command_state: 'unknown' });
  runtime.processes[0].data('\x1b]7;file:///tmp/a%20b\x1b');
  runtime.processes[0].data('\\\x1b]133;A\x07');
  assert.deepEqual(runtime.manager.shell_state('one'), { cwd: '/tmp/a b', command_state: 'idle' });
  assert.deepEqual(runtime.shell_states.at(-1), ['one', { cwd: '/tmp/a b', command_state: 'idle' }]);
  const last_notification = runtime.shell_states.length;
  runtime.processes[0].data('ordinary output');
  assert.equal(runtime.shell_states.length, last_notification, 'ordinary output does not persist redundant state');
  runtime.manager.input('one', 'typed\r');
  assert.equal(runtime.manager.shell_state('one')?.command_state, 'unknown');
  runtime.processes[0].data('\x1b]633;C\x07');
  assert.equal(runtime.manager.shell_state('one')?.command_state, 'running');
  runtime.manager.stop('one');
  assert.deepEqual(runtime.manager.shell_state('one'), { cwd: '/tmp/a b', command_state: 'idle' });
  runtime.manager.start({ ...profile, command: '' }, 80, 24);
  runtime.processes[0].data('\x1b]633;P;Cwd=/stale\x07\x1b]633;C\x07');
  assert.deepEqual(runtime.manager.shell_state('one'), { cwd: '/tmp', command_state: 'unknown' });
  runtime.manager.remove('one');
  assert.equal(runtime.manager.shell_state('one'), undefined);
});

test('startup commands and foreground names are conservative, advisory command evidence', () => {
  const runtime = harness('linux');
  runtime.manager.start(profile, 80, 24);
  const terminal_process = runtime.processes[0];
  terminal_process.process = 'sh';
  assert.equal(runtime.manager.shell_state('one')?.command_state, 'running');
  terminal_process.data('\x1b]133;D;0\x07');
  assert.equal(runtime.manager.shell_state('one')?.command_state, 'idle');
  terminal_process.process = '/usr/bin/vim';
  assert.equal(runtime.manager.shell_state('one')?.command_state, 'running');
  terminal_process.process = '-sh';
  assert.equal(runtime.manager.shell_state('one')?.command_state, 'idle');
  runtime.manager.input('one', 'read builtin\r');
  assert.equal(runtime.manager.shell_state('one')?.command_state, 'unknown', 'a shell foreground does not prove an idle prompt');
  Object.defineProperty(terminal_process, 'process', { get() { throw new Error('process ended'); } });
  assert.equal(runtime.manager.shell_state('one')?.command_state, 'unknown');
  runtime.manager.dispose();
});

test('command results reach session observers and a fresh process clears the old result', () => {
  const runtime = harness('linux');
  runtime.manager.start({ ...profile, command: '' }, 80, 24);
  const first = runtime.processes[0];
  first.data('\x1b]633;C\x07');
  assert.deepEqual(runtime.manager.get('one'), { id: 'one', status: 'running', command_status: 'running', command_revision: 1 });
  first.data('\x1b]633;D;2\x07');
  const failed: session_info = { id: 'one', status: 'running', command_status: 'error', command_exit_code: 2, command_revision: 1 };
  assert.deepEqual(runtime.manager.get('one'), failed);
  assert.deepEqual(runtime.states.at(-1), failed);
  const count = runtime.states.length;
  first.data('\x1b]633;A\x07\x1b]633;B\x07ordinary output');
  assert.equal(runtime.states.length, count, 'prompt and ordinary output do not repeat an unchanged result');
  assert.deepEqual(runtime.manager.list(), [failed]);

  first.data('\x1b]633;C\x07');
  assert.deepEqual(runtime.manager.get('one'), { id: 'one', status: 'running', command_status: 'running', command_revision: 2 });
  first.data('\x1b]633;D;0\x07');
  assert.deepEqual(runtime.states.at(-1), { id: 'one', status: 'running', command_status: 'completed', command_exit_code: 0, command_revision: 2 });
  runtime.manager.stop('one');
  assert.deepEqual(runtime.manager.get('one'), { id: 'one', status: 'exited', message: 'Stopped.' });
  runtime.manager.start({ ...profile, command: '' }, 80, 24);
  assert.deepEqual(runtime.manager.get('one'), { id: 'one', status: 'running' });
  first.data('\x1b]633;D;17\x07');
  assert.deepEqual(runtime.manager.get('one'), { id: 'one', status: 'running' }, 'retired process cannot restore stale command status');
  runtime.processes[1].data('\x1b]633;C\x07\x1b]633;D\x07');
  assert.deepEqual(runtime.manager.get('one'), { id: 'one', status: 'running' }, 'completion without a code stays unknown');
  runtime.manager.dispose();
});

test('consecutive fast commands publish distinct results even when each start and finish share a PTY chunk', () => {
  const runtime = harness('linux');
  runtime.manager.start({ ...profile, command: '' }, 80, 24);
  const process = runtime.processes[0];
  for (const command_revision of [1, 2, 3]) {
    const count = runtime.states.length;
    process.data('\x1b]633;C\x07\x1b]633;D;0\x07\x1b]633;A\x07');
    assert.equal(runtime.states.length, count + 1);
    assert.deepEqual(runtime.states.at(-1), {
      id: 'one', status: 'running', command_status: 'completed', command_exit_code: 0, command_revision,
    });
    process.data('\x1b]633;D;0\x07\x1b]633;A\x07unchanged prompt');
    assert.equal(runtime.states.length, count + 1, 'redrawing a prompt is not another completion');
  }
  runtime.manager.dispose();
});

test('a startup state observer cannot redirect the old command into a replacement process', () => {
  let replaced = false;
  const runtime = harness('linux', info => {
    if (!replaced && info.command_status === 'running') {
      replaced = true;
      runtime.manager.stop('one');
      runtime.manager.start({ ...profile, command: 'new command' }, 80, 24);
    }
  });
  runtime.manager.start({ ...profile, command: 'old command' }, 80, 24);
  assert.equal(runtime.processes.length, 2);
  assert.deepEqual(runtime.processes[0].writes, []);
  assert.deepEqual(runtime.processes[1].writes, ['new command\r']);
  runtime.manager.dispose();
});

test('a command state observer cannot publish stale shell metadata after replacing the process', () => {
  let replaced = false;
  const runtime = harness('linux', info => {
    if (!replaced && info.command_status === 'running') {
      replaced = true;
      runtime.manager.stop('one');
      runtime.manager.start({ ...profile, command: '' }, 80, 24);
    }
  });
  runtime.manager.start({ ...profile, command: '' }, 80, 24);
  runtime.processes[0].data('\x1b]7;file:///old-process-cwd\x07\x1b]633;C\x07old process output');
  assert.equal(runtime.processes.length, 2);
  assert.deepEqual(runtime.shell_states.at(-1), ['one', { cwd: '/tmp', command_state: 'unknown' }]);
  assert.deepEqual(runtime.manager.shell_state('one'), { cwd: '/tmp', command_state: 'unknown' });
  assert.deepEqual(runtime.outputs, [], 'the replaced process cannot deliver its remaining output');
  runtime.manager.dispose();
});

test('detached views and failed memory observers cannot prevent host cwd tracking or output delivery', () => {
  const terminal_process = new fake_terminal_process();
  const manager = new session_manager({
    resolve: () => ({ file: '/bin/sh', args: [], env: {}, cwd: '/tmp' }),
    platform: 'linux',
    on_output: () => { throw new Error('view detached'); },
    on_state: () => {},
    on_shell_state: () => { throw new Error('memory update failed'); },
    factory: { spawn: () => terminal_process },
  });
  manager.start({ ...profile, command: '' }, 80, 24);
  assert.doesNotThrow(() => terminal_process.data('\x1b]633;P;Cwd=/new\x07\x1b]633;A\x07'));
  assert.deepEqual(manager.shell_state('one'), { cwd: '/new', command_state: 'idle' });
  const snapshot = manager.shell_state('one')!;
  snapshot.cwd = '/external';
  assert.equal(manager.shell_state('one')?.cwd, '/new');
  manager.dispose();
});

test('profiles keep independent PTYs and startup commands run exactly once per start', () => {
  const runtime = harness();
  runtime.manager.start(profile, 80, 24);
  runtime.manager.start({ ...profile, id: 'two', command: '' }, 100, 30);
  runtime.manager.start(profile, 80, 24);
  assert.equal(runtime.processes.length, 2);
  assert.deepEqual(runtime.processes[0].writes, ['printf hello\r']);
  assert.deepEqual(runtime.processes[1].writes, []);
  runtime.manager.input('one', 'typed\r');
  runtime.processes[1].data('second terminal');
  assert.deepEqual(runtime.outputs, [['two', 'second terminal']]);
  assert.deepEqual(runtime.processes[0].writes, ['printf hello\r', 'typed\r']);
  const info = runtime.manager.get('one')!;
  info.status = 'error';
  assert.equal(runtime.manager.get('one')?.status, 'running', 'callers cannot mutate stored state');
  runtime.manager.dispose();
  assert.ok(runtime.processes.every((terminal_process) => terminal_process.killed));
  assert.deepEqual(runtime.manager.list(), []);
});

test('exit stays exited, stop publishes immediately, and old events cannot corrupt a restarted session', () => {
  const runtime = harness();
  runtime.manager.start(profile, 80, 24);
  const first = runtime.processes[0];
  first.exit(9);
  assert.deepEqual(runtime.manager.get('one'), { id: 'one', status: 'exited', exit_code: 9 });
  assert.equal(runtime.processes.length, 1, 'process exit never automatically respawns');
  runtime.manager.input('one', 'ignored');
  assert.deepEqual(first.writes, ['printf hello\r']);
  runtime.manager.start(profile, 80, 24);
  const second = runtime.processes[1];
  second.kill = () => {
    assert.equal(runtime.states.at(-1)?.status, 'exited', 'stop state arrives before the potentially asynchronous kill');
    second.killed = true;
  };
  runtime.manager.stop('one');
  assert.equal(runtime.manager.get('one')?.status, 'exited');
  assert.ok(second.killed);
  runtime.manager.start(profile, 80, 24);
  first.data('stale one');
  first.exit(42);
  second.data('stale two');
  second.exit(43);
  assert.equal(runtime.manager.get('one')?.status, 'running');
  assert.deepEqual(runtime.outputs, []);
  runtime.processes[2].data('current');
  assert.deepEqual(runtime.outputs, [['one', 'current']]);
  runtime.manager.remove('one');
  assert.equal(runtime.manager.get('one'), undefined);
  assert.ok(runtime.processes[2].killed);
});

test('invalid dimensions are clamped and I/O races do not crash the extension host', () => {
  const runtime = harness();
  runtime.manager.start(profile, -10, Number.NaN);
  assert.equal(runtime.spawns[0].cols, 1);
  assert.equal(runtime.spawns[0].rows, 24);
  runtime.manager.resize('one', 999999, 27.7);
  assert.deepEqual(runtime.processes[0].sizes, [[1000, 27]]);
  runtime.processes[0].fail_input_output = true;
  assert.doesNotThrow(() => runtime.manager.input('one', 'late input'));
  assert.doesNotThrow(() => runtime.manager.resize('one', 80, 24));
  runtime.processes[0].exit(0);
  runtime.manager.dispose();
  assert.equal(runtime.manager.start(profile, 80, 24).status, 'error');
  assert.equal(runtime.processes.length, 1);
});

test('Windows natural exit releases PTY resources once after publishing its original exit code', () => {
  const runtime = harness('win32');
  runtime.manager.start(profile, 80, 24);
  const terminal_process = runtime.processes[0];
  let cleanup_calls = 0;
  let state_at_cleanup: session_info | undefined;
  let disposed_at_cleanup = 0;
  terminal_process.kill = () => {
    cleanup_calls++;
    state_at_cleanup = runtime.states.at(-1);
    disposed_at_cleanup = terminal_process.disposed_listeners;
    terminal_process.data('late cleanup output');
    terminal_process.exit(99);
  };
  const states_before_exit = runtime.states.length;
  terminal_process.exit(7);
  assert.equal(cleanup_calls, 1);
  assert.deepEqual(state_at_cleanup, { id: 'one', status: 'exited', exit_code: 7 });
  assert.equal(disposed_at_cleanup, 2);
  assert.deepEqual(runtime.manager.get('one'), state_at_cleanup);
  assert.deepEqual(runtime.outputs, []);
  assert.equal(runtime.states.length, states_before_exit + 1, 'cleanup cannot publish another exit');
  runtime.manager.remove('one');
  runtime.manager.dispose();
  assert.equal(cleanup_calls, 1, 'later removal does not release the same PTY twice');
});

test('Windows natural-exit cleanup cannot kill a replacement started by an exit observer', () => {
  let restart_on_exit = false;
  const runtime = harness('win32', state => {
    if (restart_on_exit && state.status === 'exited') {
      restart_on_exit = false;
      runtime.manager.start(profile, 80, 24);
    }
  });
  runtime.manager.start(profile, 80, 24);
  const first = runtime.processes[0];
  first.kill = () => {
    first.killed = true;
    first.data('stale');
    first.exit(99);
  };
  restart_on_exit = true;
  first.exit(7);
  assert.equal(runtime.processes.length, 2);
  assert.ok(first.killed);
  assert.equal(runtime.processes[1].killed, false);
  assert.deepEqual(runtime.manager.get('one'), { id: 'one', status: 'running', command_status: 'running', command_revision: 1 });
  assert.deepEqual(runtime.states.map(state => [state.status, state.command_status, state.exit_code]), [
    ['running', undefined, undefined], ['running', 'running', undefined], ['exited', undefined, 7],
    ['running', undefined, undefined], ['running', 'running', undefined],
  ]);
  assert.deepEqual(runtime.outputs, []);
  runtime.manager.dispose();
});

test('cleanup failures preserve natural exits, and POSIX exited processes are never signalled', () => {
  const windows = harness('win32');
  windows.manager.start(profile, 80, 24);
  windows.processes[0].kill = () => { throw new Error('native resource already released'); };
  assert.doesNotThrow(() => windows.processes[0].exit(7));
  assert.deepEqual(windows.manager.get('one'), { id: 'one', status: 'exited', exit_code: 7 });
  windows.manager.dispose();

  const posix = harness('linux');
  posix.manager.start(profile, 80, 24);
  posix.processes[0].exit(7);
  posix.manager.dispose();
  assert.equal(posix.processes[0].killed, false, 'a recycled POSIX PID must not receive a signal');
});

test('output is delivered synchronously in bounded chunks without host scrollback storage', () => {
  const runtime = harness();
  runtime.manager.start(profile, 80, 24);
  const data = 'x'.repeat(65535) + '😀' + 'x'.repeat(140_000);
  runtime.processes[0].data(data);
  assert.equal(runtime.outputs.map(([, chunk]) => chunk).join(''), data);
  assert.ok(runtime.outputs.every(([, chunk]) => chunk.length <= 65536));
  assert.ok(runtime.outputs.every(([, chunk]) => !/[\ud800-\udbff]$/.test(chunk)), 'surrogate pairs are not split across messages');
  assert.deepEqual(runtime.manager.list(), [{ id: 'one', status: 'running', command_status: 'running', command_revision: 1 }]);
  runtime.manager.dispose();
});

test('spawn failures emit an error state without exposing command, environment, or raw exceptions', () => {
  const states: session_info[] = [];
  const manager = new session_manager({
    resolve: () => ({ file: '/missing', args: [], env: { TOKEN: 'env-secret' }, cwd: '/tmp' }),
    on_output: () => {},
    on_state: (info) => states.push(info),
    factory: { spawn: () => { throw Object.assign(new Error('env-secret command-secret'), { code: 'ENOENT' }); } },
  });
  const result = manager.start({ ...profile, command: 'command-secret' }, 80, 24);
  assert.equal(result.status, 'error');
  assert.match(result.message ?? '', /ENOENT/);
  assert.doesNotMatch(JSON.stringify(states), /env-secret|command-secret/);
  manager.dispose();
});

test('real node-pty supports interactive input and records natural exit', { timeout: 20_000 }, async (t) => {
  const windows = process.platform === 'win32';
  const shell = windows ? 'cmd' : '/bin/sh';
  const input = `hello-${random_uuid()}`;
  let output = '';
  let sent_input = false;
  let complete!: (info: session_info) => void;
  const ended = new Promise<session_info>((resolve) => { complete = resolve; });
  const manager = new session_manager({
    resolve: () => ({ ...resolve_shell(shell), args: windows ? ['/d', '/q', '/v:on'] : [], cwd: process.cwd() }),
    on_output: (_id, data) => {
      output += data;
      const plain_output = strip_terminal_controls(output);
      // ConPTY can redraw the current line instead of emitting a POSIX-style newline.
      // The random input marker below is absent from the command and must come from set /p.
      const ready = windows ? plain_output.includes('__TS_PTY_READY__') : /(?:\r?\n)__TS_PTY_READY__\r?\n/.test(plain_output);
      if (!sent_input && ready) {
        sent_input = true;
        manager.resize('native', 120, 40);
        manager.input('native', input + '\r');
      }
    },
    on_state: (state) => { if (state.status === 'error' || state.status === 'exited') complete(state); },
  });
  t.after(() => manager.dispose());
  manager.start({
    id: 'native', name: 'Native', shell,
    command: windows
      ? 'set "line="&echo __TS_PTY_READY__&set /p line=&echo __TS_INPUT__:!line!&exit 7'
      : `stty -echo; printf '\\n__TS_PTY_READY__\\n'; IFS= read -r line; printf '\\n__TS_INPUT__:%s\\n' "$line"; exit 7`,
  }, 80, 24);
  const state = await ended;
  assert.equal(state.status, 'exited', state.message);
  assert.equal(state.exit_code, 7);
  assert.ok(sent_input, 'the native terminal requested and received interactive input');
  assert.ok(strip_terminal_controls(output).includes(`__TS_INPUT__:${input}`), 'the shell read and printed the actual interactive input');
  assert.equal(manager.get('native')?.status, 'exited');
});
