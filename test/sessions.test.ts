import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { SessionManager, type PtyProcess, type PtySpawnOptions } from '../src/sessions';
import { resolveShell } from '../src/shell';
import type { Profile, SessionInfo } from '../src/types';

class FakePty implements PtyProcess {
  readonly writes: string[] = [];
  readonly sizes: Array<[number, number]> = [];
  readonly dataListeners: Array<(data: string) => void> = [];
  readonly exitListeners: Array<(event: { exitCode: number }) => void> = [];
  killed = false;
  failIo = false;
  disposedListeners = 0;
  onData(listener: (data: string) => void) {
    this.dataListeners.push(listener);
    return { dispose: () => { this.disposedListeners++; } };
  }
  onExit(listener: (event: { exitCode: number }) => void) {
    this.exitListeners.push(listener);
    return { dispose: () => { this.disposedListeners++; } };
  }
  write(data: string) { if (this.failIo) throw new Error('already exited'); this.writes.push(data); }
  resize(cols: number, rows: number) { if (this.failIo) throw new Error('already exited'); this.sizes.push([cols, rows]); }
  kill() { this.killed = true; }
  data(value: string) { for (const listener of this.dataListeners) listener(value); }
  exit(exitCode: number) { for (const listener of this.exitListeners) listener({ exitCode }); }
}

const profile: Profile = { id: 'one', name: 'One', command: 'printf hello', shell: '' };
function harness(platform: NodeJS.Platform = process.platform, onState?: (info: SessionInfo) => void) {
  const processes: FakePty[] = [];
  const states: SessionInfo[] = [];
  const outputs: Array<[string, string]> = [];
  const spawns: PtySpawnOptions[] = [];
  const manager = new SessionManager({
    resolve: () => ({ file: '/bin/sh', args: [], env: { TERM: 'xterm-256color' }, cwd: '/tmp' }),
    onOutput: (id, data) => outputs.push([id, data]),
    onState: (state) => { states.push(state); onState?.(state); },
    platform,
    factory: { spawn: (_file, _args, options) => {
      spawns.push(options);
      const pty = new FakePty(); processes.push(pty); return pty;
    } },
  });
  return { manager, processes, states, outputs, spawns };
}

test('profiles keep independent PTYs and startup commands run exactly once per start', () => {
  const h = harness();
  h.manager.start(profile, 80, 24);
  h.manager.start({ ...profile, id: 'two', command: '' }, 100, 30);
  h.manager.start(profile, 80, 24);
  assert.equal(h.processes.length, 2);
  assert.deepEqual(h.processes[0].writes, ['printf hello\r']);
  assert.deepEqual(h.processes[1].writes, []);
  h.manager.input('one', 'typed\r');
  h.processes[1].data('second terminal');
  assert.deepEqual(h.outputs, [['two', 'second terminal']]);
  assert.deepEqual(h.processes[0].writes, ['printf hello\r', 'typed\r']);
  const info = h.manager.get('one')!;
  info.status = 'error';
  assert.equal(h.manager.get('one')?.status, 'running', 'callers cannot mutate stored state');
  h.manager.dispose();
  assert.ok(h.processes.every((pty) => pty.killed));
  assert.deepEqual(h.manager.list(), []);
});

test('exit stays exited, stop publishes immediately, and old events cannot corrupt a restarted session', () => {
  const h = harness();
  h.manager.start(profile, 80, 24);
  const first = h.processes[0];
  first.exit(9);
  assert.deepEqual(h.manager.get('one'), { id: 'one', status: 'exited', exitCode: 9 });
  assert.equal(h.processes.length, 1, 'process exit never automatically respawns');
  h.manager.input('one', 'ignored');
  assert.deepEqual(first.writes, ['printf hello\r']);
  h.manager.start(profile, 80, 24);
  const second = h.processes[1];
  second.kill = () => {
    assert.equal(h.states.at(-1)?.status, 'exited', 'stop state arrives before the potentially asynchronous kill');
    second.killed = true;
  };
  h.manager.stop('one');
  assert.equal(h.manager.get('one')?.status, 'exited');
  assert.ok(second.killed);
  h.manager.start(profile, 80, 24);
  first.data('stale one'); first.exit(42);
  second.data('stale two'); second.exit(43);
  assert.equal(h.manager.get('one')?.status, 'running');
  assert.deepEqual(h.outputs, []);
  h.processes[2].data('current');
  assert.deepEqual(h.outputs, [['one', 'current']]);
  h.manager.remove('one');
  assert.equal(h.manager.get('one'), undefined);
  assert.ok(h.processes[2].killed);
});

test('invalid dimensions are clamped and I/O races do not crash the extension host', () => {
  const h = harness();
  h.manager.start(profile, -10, Number.NaN);
  assert.equal(h.spawns[0].cols, 1);
  assert.equal(h.spawns[0].rows, 24);
  h.manager.resize('one', 999999, 27.7);
  assert.deepEqual(h.processes[0].sizes, [[1000, 27]]);
  h.processes[0].failIo = true;
  assert.doesNotThrow(() => h.manager.input('one', 'late input'));
  assert.doesNotThrow(() => h.manager.resize('one', 80, 24));
  h.processes[0].exit(0);
  h.manager.dispose();
  assert.equal(h.manager.start(profile, 80, 24).status, 'error');
  assert.equal(h.processes.length, 1);
});

test('Windows natural exit releases PTY resources once after publishing its original exit code', () => {
  const h = harness('win32');
  h.manager.start(profile, 80, 24);
  const pty = h.processes[0];
  let cleanupCalls = 0;
  let stateAtCleanup: SessionInfo | undefined;
  let disposedAtCleanup = 0;
  pty.kill = () => {
    cleanupCalls++;
    stateAtCleanup = h.states.at(-1);
    disposedAtCleanup = pty.disposedListeners;
    pty.data('late cleanup output');
    pty.exit(99);
  };
  pty.exit(7);
  assert.equal(cleanupCalls, 1);
  assert.deepEqual(stateAtCleanup, { id: 'one', status: 'exited', exitCode: 7 });
  assert.equal(disposedAtCleanup, 2);
  assert.deepEqual(h.manager.get('one'), stateAtCleanup);
  assert.deepEqual(h.outputs, []);
  assert.equal(h.states.length, 2, 'cleanup cannot publish another exit');
  h.manager.remove('one');
  h.manager.dispose();
  assert.equal(cleanupCalls, 1, 'later removal does not release the same PTY twice');
});

test('Windows natural-exit cleanup cannot kill a replacement started by an exit observer', () => {
  let restartOnExit = false;
  const h = harness('win32', state => {
    if (restartOnExit && state.status === 'exited') {
      restartOnExit = false;
      h.manager.start(profile, 80, 24);
    }
  });
  h.manager.start(profile, 80, 24);
  const first = h.processes[0];
  first.kill = () => { first.killed = true; first.data('stale'); first.exit(99); };
  restartOnExit = true;
  first.exit(7);
  assert.equal(h.processes.length, 2);
  assert.ok(first.killed);
  assert.equal(h.processes[1].killed, false);
  assert.deepEqual(h.manager.get('one'), { id: 'one', status: 'running' });
  assert.deepEqual(h.states.map(state => [state.status, state.exitCode]), [['running', undefined], ['exited', 7], ['running', undefined]]);
  assert.deepEqual(h.outputs, []);
  h.manager.dispose();
});

test('cleanup failures preserve natural exits, and POSIX exited processes are never signalled', () => {
  const windows = harness('win32');
  windows.manager.start(profile, 80, 24);
  windows.processes[0].kill = () => { throw new Error('native resource already released'); };
  assert.doesNotThrow(() => windows.processes[0].exit(7));
  assert.deepEqual(windows.manager.get('one'), { id: 'one', status: 'exited', exitCode: 7 });
  windows.manager.dispose();

  const posix = harness('linux');
  posix.manager.start(profile, 80, 24);
  posix.processes[0].exit(7);
  posix.manager.dispose();
  assert.equal(posix.processes[0].killed, false, 'a recycled POSIX PID must not receive a signal');
});

test('output is delivered synchronously in bounded chunks without host scrollback storage', () => {
  const h = harness();
  h.manager.start(profile, 80, 24);
  const data = 'x'.repeat(65535) + '😀' + 'x'.repeat(140_000);
  h.processes[0].data(data);
  assert.equal(h.outputs.map(([, chunk]) => chunk).join(''), data);
  assert.ok(h.outputs.every(([, chunk]) => chunk.length <= 65536));
  assert.ok(h.outputs.every(([, chunk]) => !/[\ud800-\udbff]$/.test(chunk)), 'surrogate pairs are not split across messages');
  assert.deepEqual(h.manager.list(), [{ id: 'one', status: 'running' }]);
  h.manager.dispose();
});

test('spawn failures emit an error state without exposing command, environment, or raw exceptions', () => {
  const states: SessionInfo[] = [];
  const manager = new SessionManager({
    resolve: () => ({ file: '/missing', args: [], env: { TOKEN: 'env-secret' }, cwd: '/tmp' }),
    onOutput: () => {}, onState: (info) => states.push(info),
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
  const input = `hello-${randomUUID()}`;
  let output = '';
  let sentInput = false;
  let complete!: (info: SessionInfo) => void;
  const ended = new Promise<SessionInfo>((resolve) => { complete = resolve; });
  const manager = new SessionManager({
    resolve: () => ({ ...resolveShell(shell), args: windows ? ['/d', '/q', '/v:on'] : [], cwd: process.cwd() }),
    onOutput: (_id, data) => {
      output += data;
      const plainOutput = stripVTControlCharacters(output);
      // ConPTY can redraw the current line instead of emitting a POSIX-style newline.
      // The random input marker below is absent from the command and must come from set /p.
      const ready = windows ? plainOutput.includes('__TS_PTY_READY__') : /(?:\r?\n)__TS_PTY_READY__\r?\n/.test(plainOutput);
      if (!sentInput && ready) {
        sentInput = true;
        manager.resize('native', 120, 40);
        manager.input('native', input + '\r');
      }
    },
    onState: (state) => { if (state.status === 'error' || state.status === 'exited') complete(state); },
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
  assert.equal(state.exitCode, 7);
  assert.ok(sentInput, 'the native terminal requested and received interactive input');
  assert.ok(stripVTControlCharacters(output).includes(`__TS_INPUT__:${input}`), 'the shell read and printed the actual interactive input');
  assert.equal(manager.get('native')?.status, 'exited');
});
