import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import type * as vscode from 'vscode';
import type { ClientMessage, HostMessage, Profile } from '../src/types';
import type { PtyProcess, PtySpawnOptions } from '../src/sessions';

const ROOT = path.resolve(__dirname, '..');
const requireBuiltin = createRequire(path.join(ROOT, 'package.json'));
const VIEW_IDS = { left: 'terminalSidebar.left', right: 'terminalSidebar.terminals' } as const;
type Side = keyof typeof VIEW_IDS;
type Disposable = { dispose(): void };

// Exercise the real extension and SessionManager together. Only the VS Code host,
// OS shell lookup, and native process boundary are replaced; no CLI is executed.
const bundledHost = build({
  entryPoints: [path.join(ROOT, 'src/extension.ts')],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['vscode', 'node-pty'],
  plugins: [{
    name: 'host-test-operating-system-boundaries',
    setup(builder) {
      builder.onResolve({ filter: /^\.\/(discovery|shell)$/ }, args => ({ path: args.path, namespace: 'host-test' }));
      builder.onLoad({ filter: /.*/, namespace: 'host-test' }, args => ({ contents: args.path === './discovery'
        ? 'exports.discoverShells = async () => [];'
        : 'exports.resolveShell = (_selection, options) => ({ file: "test-shell", args: [], env: options.env });'
      }));
    }
  }]
}).then(result => result.outputFiles[0].text);

class Event<T> {
  readonly listeners = new Set<(value: T) => void>();
  readonly subscribe = (listener: (value: T) => void): Disposable => {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  };
  fire(value: T): void { for (const listener of [...this.listeners]) listener(value); }
}

class FakePty implements PtyProcess {
  readonly writes: string[] = [];
  readonly sizes: Array<[number, number]> = [];
  readonly data = new Event<string>();
  readonly exit = new Event<{ exitCode: number }>();
  readonly onData = this.data.subscribe;
  readonly onExit = this.exit.subscribe;
  killed = 0;
  write(value: string): void { this.writes.push(value); }
  resize(cols: number, rows: number): void { this.sizes.push([cols, rows]); }
  kill(): void { this.killed++; }
}

class FakeView {
  visible = true;
  title?: string;
  readonly messages: HostMessage[] = [];
  readonly incoming = new Event<unknown>();
  readonly visibility = new Event<void>();
  readonly disposal = new Event<void>();
  readonly onDidChangeVisibility = this.visibility.subscribe;
  readonly onDidDispose = this.disposal.subscribe;
  readonly webview = {
    options: {}, html: '', cspSource: 'vscode-webview://host-test',
    asWebviewUri: (uri: unknown) => uri,
    onDidReceiveMessage: this.incoming.subscribe,
    postMessage: async (message: HostMessage) => { this.messages.push(structuredClone(message)); return true; }
  };
  async send(message: ClientMessage): Promise<void> {
    this.incoming.fire(message);
    // The public message callback returns void and starts an async host handler.
    // Flush its promise continuations without waiting for terminal-output timers.
    await nextTurn();
  }
  hide(): void { this.visible = false; this.visibility.fire(); }
  dispose(): void { this.visible = false; this.disposal.fire(); }
  state(): Extract<HostMessage, { type: 'state' }> {
    const state = [...this.messages].reverse().find(message => message.type === 'state');
    assert.ok(state?.type === 'state', 'view has received a state snapshot');
    return state;
  }
}

const initialProfiles: Profile[] = [
  { id: 'one', name: 'One', command: 'echo FIRST_START', shell: '' },
  { id: 'two', name: 'Two', command: 'echo SECOND_START', shell: '' }
];

async function harness() {
  let profiles = structuredClone(initialProfiles);
  const updates: Profile[][] = [];
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const providers = new Map<string, vscode.WebviewViewProvider>();
  const executions: Array<{ id: string; args: unknown[] }> = [];
  const processes: FakePty[] = [];
  const spawns: PtySpawnOptions[] = [];
  const subscriptions: Disposable[] = [];
  const configuration = new Event<{ affectsConfiguration(section: string): boolean }>();
  const trust = new Event<void>();
  const state = new Map<string, unknown>();
  const api = {
    ConfigurationTarget: { Global: 1 },
    Uri: {
      joinPath: (base: string, ...parts: string[]) => [base, ...parts].join('/'),
      file: (fsPath: string) => ({ fsPath })
    },
    workspace: {
      isTrusted: true,
      workspaceFolders: [],
      onDidChangeConfiguration: configuration.subscribe,
      onDidGrantWorkspaceTrust: trust.subscribe,
      getConfiguration: (section: string) => ({
        get: (_key: string, fallback?: unknown) => fallback,
        inspect: (key: string) => section === 'terminalSidebar' && key === 'profiles' ? { globalValue: profiles } : undefined,
        update: async (key: string, value: Profile[], target: number) => {
          assert.equal(section, 'terminalSidebar'); assert.equal(key, 'profiles'); assert.equal(target, 1);
          profiles = structuredClone(value);
          updates.push(structuredClone(value));
          configuration.fire({ affectsConfiguration: item => item === 'terminalSidebar.profiles' });
        }
      })
    },
    commands: {
      registerCommand: (id: string, callback: (...args: unknown[]) => unknown) => {
        assert.ok(!commands.has(id), `command ${id} is registered once`);
        commands.set(id, callback);
        return { dispose: () => { commands.delete(id); } };
      },
      executeCommand: async (id: string, ...args: unknown[]) => {
        executions.push({ id, args });
        return commands.get(id)?.(...args);
      }
    },
    window: {
      registerWebviewViewProvider: (id: string, provider: vscode.WebviewViewProvider) => {
        assert.ok(!providers.has(id), `view ${id} is registered once`);
        providers.set(id, provider);
        return { dispose: () => { providers.delete(id); } };
      },
      showErrorMessage: async (message: string) => { throw new Error(message); },
      showWarningMessage: async (_message: string, _options: unknown, first: string) => first,
      showQuickPick: async () => undefined
    }
  };
  const context = {
    subscriptions,
    extensionUri: 'vscode-extension://terminal-sidebar',
    workspaceState: { get: (key: string) => state.get(key), update: async (key: string, value: unknown) => { state.set(key, value); } }
  };
  const module = { exports: {} as { activate(context: vscode.ExtensionContext): void } };
  runInNewContext(await bundledHost, {
    module, exports: module.exports, Buffer, process, setTimeout, clearTimeout,
    require: (id: string) => {
      if (id === 'vscode') return api;
      if (id === 'node-pty') return { spawn: (_file: string, _args: string[], options: PtySpawnOptions) => {
        spawns.push(structuredClone(options));
        const pty = new FakePty(); processes.push(pty); return pty;
      } };
      assert.ok(id.startsWith('node:'), `unexpected host dependency ${id}`);
      return requireBuiltin(id);
    }
  }, { filename: 'terminal-sidebar-host-test.cjs' });
  module.exports.activate(context as unknown as vscode.ExtensionContext);
  await nextTurn();
  return {
    api, commands, providers, executions, processes, spawns, updates, state,
    profiles: () => structuredClone(profiles),
    replaceProfiles: (next: Profile[]) => {
      profiles = structuredClone(next);
      configuration.fire({ affectsConfiguration: item => item === 'terminalSidebar.profiles' });
    },
    async view(side: Side) {
      const provider = providers.get(VIEW_IDS[side]);
      assert.ok(provider, `${side} provider registered`);
      const view = new FakeView();
      await provider.resolveWebviewView(view as unknown as vscode.WebviewView, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
      await view.send({ type: 'ready' });
      return view;
    },
    async command(id: string, ...args: unknown[]) {
      const command = commands.get(id); assert.ok(command, `command ${id} is registered`);
      await command(...args); await nextTurn();
    },
    dispose() { for (const disposable of subscriptions.splice(0).reverse()) disposable.dispose(); }
  };
}

test('both sidebars share one PTY per profile and run the startup command only once', async t => {
  const h = await harness(); t.after(() => h.dispose());
  assert.deepEqual([...h.providers.keys()].sort(), Object.values(VIEW_IDS).sort());
  const left = await h.view('left');
  await left.send({ type: 'activate', id: 'one', cols: 80, rows: 24 });
  const right = await h.view('right');
  await right.send({ type: 'activate', id: 'one', cols: 100, rows: 30 });
  await right.send({ type: 'activate', id: 'one', cols: 100, rows: 30 });
  assert.equal(h.processes.length, 1);
  assert.deepEqual(h.processes[0].writes, ['echo FIRST_START\r']);
  assert.equal(left.state().sessions[0].status, 'running');
  assert.equal(right.state().sessions[0].status, 'running');
  // A newly resolved surface gets prior output once while the existing surface
  // receives its pending batch once. This catches cross-view replay duplication.
  right.dispose();
  h.processes[0].data.fire('shared output');
  const reopened = await h.view('right');
  for (const view of [left, reopened])
    assert.deepEqual(view.messages.filter(message => message.type === 'output'), [{ type: 'output', id: 'one', data: 'shared output' }]);
});

test('profile selection is independent on each surface and name/id opening retains sessions', async t => {
  const h = await harness(); t.after(() => h.dispose());
  const left = await h.view('left'); const right = await h.view('right');
  await left.send({ type: 'activate', id: 'one', cols: 80, rows: 24 });
  await right.send({ type: 'activate', id: 'two', cols: 100, rows: 30 });
  assert.equal(left.state().activeId, 'one'); assert.equal(right.state().activeId, 'two');
  assert.equal(h.state.get('activeProfile.left'), 'one'); assert.equal(h.state.get('activeProfile.right'), 'two');
  assert.equal(h.processes.length, 2);
  await h.command('terminalSidebar.openProfile', 'One');
  assert.equal(right.state().activeId, 'one'); assert.equal(left.state().activeId, 'one');
  await h.command('terminalSidebar.openProfile', { id: 'two', side: 'left' });
  assert.equal(left.state().activeId, 'two'); assert.equal(right.state().activeId, 'one');
  assert.equal(h.processes.length, 2, 'selecting an existing profile does not restart either process');
  assert.deepEqual(h.processes.map(pty => pty.writes), [['echo FIRST_START\r'], ['echo SECOND_START\r']]);
});

test('the focused visible surface owns resize and hidden surfaces cannot steal it', async t => {
  const h = await harness(); t.after(() => h.dispose());
  const left = await h.view('left'); const right = await h.view('right');
  await left.send({ type: 'activate', id: 'one', cols: 80, rows: 24 });
  await right.send({ type: 'activate', id: 'one', cols: 100, rows: 30 });
  const pty = h.processes[0];
  assert.deepEqual(pty.sizes, [], 'showing another surface does not override the current size owner');
  await right.send({ type: 'resize', id: 'one', cols: 101, rows: 31 });
  assert.deepEqual(pty.sizes, []);
  await right.send({ type: 'focus', id: 'one' });
  assert.deepEqual(pty.sizes, [[101, 31]], 'focus applies the stored dimensions of that surface');
  await left.send({ type: 'resize', id: 'one', cols: 81, rows: 25 });
  assert.deepEqual(pty.sizes, [[101, 31]]);
  right.hide();
  await right.send({ type: 'resize', id: 'one', cols: 5, rows: 2 });
  await left.send({ type: 'focus', id: 'one' });
  assert.deepEqual(pty.sizes, [[101, 31], [81, 25]]);
  await right.send({ type: 'focus', id: 'one' });
  await right.send({ type: 'resize', id: 'one', cols: 6, rows: 3 });
  await left.send({ type: 'resize', id: 'one', cols: 82, rows: 26 });
  assert.deepEqual(pty.sizes, [[101, 31], [81, 25], [82, 26]], 'a queued focus from the hidden view cannot take ownership');
});

test('both configuration gears open the left editor, and draft actions target that editor', async t => {
  const h = await harness(); t.after(() => h.dispose());
  const left = await h.view('left'); const right = await h.view('right');
  for (const side of ['left', 'right'] as const) {
    await h.command(`terminalSidebar.${side}.configure`);
    assert.equal(h.executions.at(-1)?.id, 'terminalSidebar.left.focus');
  }
  assert.equal(left.messages.filter(message => message.type === 'configure').length, 2);
  assert.equal(right.messages.filter(message => message.type === 'configure').length, 0);
  await right.send({ type: 'configure' });
  assert.equal(left.messages.filter(message => message.type === 'configure').length, 3);
  await left.send({ type: 'draftState', configuring: true, canUndo: true, canRedo: false });
  assert.deepEqual(h.executions.slice(-3).map(item => item.args), [
    ['terminalSidebar.left.configuring', true], ['terminalSidebar.left.canUndo', true], ['terminalSidebar.left.canRedo', false]
  ]);
  for (const action of ['save', 'undo', 'redo', 'close']) await h.command(`terminalSidebar.left.${action}`);
  assert.deepEqual(left.messages.filter(message => message.type === 'action'), ['save', 'undo', 'redo', 'close'].map(action => ({ type: 'action', action })));
});

test('stale configuration drafts cannot overwrite changes from another settings surface', async t => {
  const h = await harness(); t.after(() => h.dispose());
  const left = await h.view('left');
  const baseline = h.profiles();
  const elsewhere = baseline.map(profile => ({ ...profile, name: `${profile.name} elsewhere` }));
  h.replaceProfiles(elsewhere);
  const draft = baseline.map(profile => ({ ...profile, name: `${profile.name} draft` }));
  await left.send({ type: 'save', profiles: draft, baseProfiles: baseline });
  assert.deepEqual(h.updates, []);
  assert.deepEqual(h.profiles(), elsewhere);
  assert.ok(left.messages.some(message => message.type === 'error' && message.message.includes('Profiles changed elsewhere')));
  assert.ok(!left.messages.some(message => message.type === 'saved'));
  await left.send({ type: 'save', profiles: draft, baseProfiles: elsewhere });
  assert.deepEqual(h.updates, [draft]);
  assert.deepEqual(h.profiles(), draft);
  assert.ok(left.messages.some(message => message.type === 'saved'));
});

test('untrusted workspaces cannot start a PTY, and extension disposal cleans both views and processes', async t => {
  const h = await harness(); t.after(() => h.dispose());
  const left = await h.view('left'); const right = await h.view('right');
  h.api.workspace.isTrusted = false;
  await left.send({ type: 'activate', id: 'one', cols: 80, rows: 24 });
  assert.equal(h.processes.length, 0);
  assert.ok(left.messages.some(message => message.type === 'error' && message.message.includes('Trust')));
  h.api.workspace.isTrusted = true;
  await left.send({ type: 'activate', id: 'one', cols: 80, rows: 24 });
  await right.send({ type: 'activate', id: 'two', cols: 100, rows: 30 });
  assert.equal(h.processes.length, 2);
  h.dispose();
  assert.ok(h.processes.every(pty => pty.killed === 1));
  assert.ok(h.processes.every(pty => pty.data.listeners.size === 0 && pty.exit.listeners.size === 0));
  assert.equal(left.incoming.listeners.size, 0); assert.equal(right.incoming.listeners.size, 0);
  assert.equal(h.commands.size, 0); assert.equal(h.providers.size, 0);
});
