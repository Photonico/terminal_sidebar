import assert from 'node:assert/strict';
import { createRequire as create_require } from 'node:module';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { setImmediate as next_turn, setTimeout as delay } from 'node:timers/promises';
import { runInNewContext as run_in_new_context } from 'node:vm';
import { build } from 'esbuild';
import type * as vscode from 'vscode';
import type { client_message, host_message, sidebar_configuration, sidebar_side, terminal_profile } from '../src/types';
import type { pty_process, pty_spawn_options } from '../src/sessions';

const repository_root = path.resolve(__dirname, '..');
const require_builtin = create_require(path.join(repository_root, 'package.json'));
const view_ids = { left: 'terminalSidebar.left', right: 'terminalSidebar.terminals' } as const;
type disposable = { dispose(): void };

// Execute the real controller, tab model and process manager together. Replace only
// the VS Code host, shell lookup and native process boundary. No CLI runs here.
const bundled_host = build({
  entryPoints: [path.join(repository_root, 'src/extension.ts')],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['vscode', 'node-pty'],
  plugins: [{
    name: 'host-test-operating-system-boundaries',
    setup(builder) {
      builder.onResolve({ filter: /^\.\/(discovery|shell)$/ }, arguments_object => ({
        path: arguments_object.path,
        namespace: 'host-test',
      }));
      builder.onLoad({ filter: /.*/, namespace: 'host-test' }, arguments_object => ({
        contents: arguments_object.path === './discovery'
          ? 'exports.discover_shells = async () => [];'
          : 'exports.resolve_shell = (_selection, options) => ({ file: "test-shell", args: [], env: options.env });',
      }));
    },
  }],
}).then(result => result.outputFiles[0].text);

class event_source<value_type> {
  readonly listeners = new Set<(value: value_type) => void>();
  readonly subscribe = (listener: (value: value_type) => void): disposable => {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  };

  fire(value: value_type): void {
    for (const listener of [...this.listeners]) listener(value);
  }
}

class fake_terminal_process implements pty_process {
  readonly writes: string[] = [];
  readonly sizes: Array<[number, number]> = [];
  readonly data = new event_source<string>();
  readonly exit = new event_source<{ exitCode: number }>();
  readonly onData = this.data.subscribe;
  readonly onExit = this.exit.subscribe;
  killed = 0;

  write(value: string): void { this.writes.push(value); }
  resize(columns: number, rows: number): void { this.sizes.push([columns, rows]); }
  kill(): void { this.killed++; }
}

class fake_view {
  visible = true;
  title?: string;
  readonly messages: host_message[] = [];
  readonly incoming = new event_source<unknown>();
  readonly visibility = new event_source<void>();
  readonly disposal = new event_source<void>();
  readonly onDidChangeVisibility = this.visibility.subscribe;
  readonly onDidDispose = this.disposal.subscribe;
  readonly webview = {
    options: {},
    html: '',
    cspSource: 'vscode-webview://host-test',
    asWebviewUri: (uri: unknown) => uri,
    onDidReceiveMessage: this.incoming.subscribe,
    postMessage: async (message: host_message) => {
      this.messages.push(structuredClone(message));
      return true;
    },
  };

  async send(message: client_message): Promise<void> {
    this.incoming.fire(message);
    // The public event returns void. Flush its handler without advancing output timers.
    await next_turn();
  }

  hide(): void {
    this.visible = false;
    this.visibility.fire();
  }

  show(): void {
    this.visible = true;
    this.visibility.fire();
  }

  dispose(): void {
    this.visible = false;
    this.disposal.fire();
  }

  state(): Extract<host_message, { type: 'state' }> {
    const latest_state = [...this.messages].reverse().find(message => message.type === 'state');
    assert.ok(latest_state?.type === 'state', 'view has received a state snapshot');
    return latest_state;
  }

  output(): Extract<host_message, { type: 'output' }>[] {
    return this.messages.filter(message => message.type === 'output');
  }
}

const initial_configuration: sidebar_configuration = {
  left: [
    { id: 'one', name: 'Left One', command: 'echo LEFT_START', shell: '' },
    { id: 'two', name: 'Left Two', command: 'echo LEFT_SECOND', shell: '' },
  ],
  right: [
    { id: 'one', name: 'Right One', command: 'echo RIGHT_START', shell: '' },
    { id: 'two', name: 'Right Two', command: 'echo RIGHT_SECOND', shell: '' },
  ],
};

interface harness_options {
  configuration?: sidebar_configuration;
  legacy_profiles?: terminal_profile[];
  memory?: Map<string, unknown>;
  trusted?: boolean;
  settings?: Record<string, unknown>;
  input?: (options: vscode.InputBoxOptions) => string | undefined | Promise<string | undefined>;
  warning?: (message: string, first: string) => string | undefined | Promise<string | undefined>;
  save_destination?: string;
  workspace_uri?: { scheme: string; fsPath: string; with(change: { path: string }): unknown };
}

async function harness(options: harness_options = {}) {
  let configuration_value = options.legacy_profiles === undefined
    ? structuredClone(options.configuration ?? initial_configuration)
    : undefined;
  const legacy_profiles = structuredClone(options.legacy_profiles);
  const updates: sidebar_configuration[] = [];
  const commands = new Map<string, (...arguments_list: unknown[]) => unknown>();
  const providers = new Map<string, vscode.WebviewViewProvider>();
  const executions: Array<{ id: string; args: unknown[] }> = [];
  const processes: fake_terminal_process[] = [];
  const spawns: pty_spawn_options[] = [];
  const subscriptions: disposable[] = [];
  const configuration_changed = new event_source<{ affectsConfiguration(section: string): boolean }>();
  const trust_granted = new event_source<void>();
  const memory = new Map<string, unknown>(structuredClone(options.memory ?? new Map()));
  const settings = new Map(Object.entries(options.settings ?? {}));
  const errors: string[] = [];
  const input_boxes: vscode.InputBoxOptions[] = [];
  const warnings: string[] = [];
  const links: string[] = [];
  const opened_files: string[] = [];
  const editable_copies: Array<{ content: string; language: string }> = [];
  const saved_files: Array<{ path: string; text: string; bytes: Buffer }> = [];
  const save_dialogs: vscode.SaveDialogOptions[] = [];
  const api = {
    ConfigurationTarget: { Global: 1 },
    Uri: {
      joinPath: (base: string, ...parts: string[]) => [base, ...parts].join('/'),
      file: (fsPath: string) => ({ fsPath, path: decodeURIComponent(pathToFileURL(fsPath).pathname), scheme: 'file' }),
      parse: (value: string) => ({ toString: () => value }),
    },
    env: { openExternal: async (uri: { toString(): string }) => { links.push(uri.toString()); return true; } },
    Range: class { constructor(readonly startLine: number, readonly startCharacter: number, readonly endLine: number, readonly endCharacter: number) {} },
    workspace: {
      isTrusted: options.trusted ?? true,
      workspaceFolders: options.workspace_uri ? [{ uri: options.workspace_uri }] : [],
      fs: { writeFile: async (uri: { fsPath: string }, data: Uint8Array) => { saved_files.push({ path: uri.fsPath, text: Buffer.from(data).toString('utf8'), bytes: Buffer.from(data) }); } },
      openTextDocument: async (uri: { fsPath: string } | { content: string; language: string }) => {
        if ('content' in uri) editable_copies.push(structuredClone(uri));
        else opened_files.push(uri.fsPath);
        return { lineCount: 10, lineAt: () => ({ text: 'example source line' }) };
      },
      onDidChangeConfiguration: configuration_changed.subscribe,
      onDidGrantWorkspaceTrust: trust_granted.subscribe,
      getConfiguration: (section: string) => ({
        get: (key: string, fallback?: unknown) => settings.has(`${section}.${key}`)
          ? settings.get(`${section}.${key}`) : fallback,
        inspect: (key: string) => {
          if (section !== 'terminalSidebar') return undefined;
          if (key === 'sidebars') return { globalValue: configuration_value };
          if (key === 'profiles') return { globalValue: legacy_profiles };
          return undefined;
        },
        update: async (key: string, value: sidebar_configuration, target: number) => {
          assert.equal(section, 'terminalSidebar');
          assert.equal(key, 'sidebars');
          assert.equal(target, 1);
          configuration_value = structuredClone(value);
          updates.push(structuredClone(value));
          configuration_changed.fire({ affectsConfiguration: item => item === 'terminalSidebar.sidebars' });
        },
      }),
    },
    commands: {
      registerCommand: (id: string, callback: (...arguments_list: unknown[]) => unknown) => {
        assert.ok(!commands.has(id), `command ${id} is registered once`);
        commands.set(id, callback);
        return { dispose: () => { commands.delete(id); } };
      },
      executeCommand: async (id: string, ...arguments_list: unknown[]) => {
        executions.push({ id, args: arguments_list });
        return commands.get(id)?.(...arguments_list);
      },
    },
    window: {
      registerWebviewViewProvider: (id: string, provider: vscode.WebviewViewProvider) => {
        assert.ok(!providers.has(id), `view ${id} is registered once`);
        providers.set(id, provider);
        return { dispose: () => { providers.delete(id); } };
      },
      showErrorMessage: async (message: string) => { errors.push(message); },
      showWarningMessage: async (message: string, _options: unknown, first: string) => {
        warnings.push(message);
        return options.warning ? options.warning(message, first) : first;
      },
      showInformationMessage: async () => undefined,
      showTextDocument: async () => undefined,
      showSaveDialog: async (save_options: vscode.SaveDialogOptions) => {
        save_dialogs.push(structuredClone(save_options));
        return options.save_destination ? { fsPath: options.save_destination, scheme: 'file' } : undefined;
      },
      showQuickPick: async () => undefined,
      showInputBox: async (input_options: vscode.InputBoxOptions) => {
        input_boxes.push(input_options);
        return options.input?.(input_options);
      },
    },
  };
  const context = {
    subscriptions,
    extensionUri: 'vscode-extension://terminal-sidebar',
    workspaceState: {
      get: (key: string) => structuredClone(memory.get(key)),
      update: async (key: string, value: unknown) => { memory.set(key, structuredClone(value)); },
    },
  };
  const host_module = { exports: {} as { activate(context: vscode.ExtensionContext): void } };
  run_in_new_context(await bundled_host, {
    module: host_module,
    exports: host_module.exports,
    Buffer,
    URL,
    TextEncoder,
    process,
    setTimeout,
    clearTimeout,
    require: (id: string) => {
      if (id === 'vscode') return api;
      if (id === 'node-pty') {
        return { spawn: (_file: string, _arguments: string[], spawn_options: pty_spawn_options) => {
          spawns.push(structuredClone(spawn_options));
          const terminal_process = new fake_terminal_process();
          processes.push(terminal_process);
          return terminal_process;
        } };
      }
      assert.ok(id.startsWith('node:'), `unexpected host dependency ${id}`);
      return require_builtin(id);
    },
  }, { filename: 'terminal-sidebar-host-test.cjs' });
  host_module.exports.activate(context as unknown as vscode.ExtensionContext);
  await next_turn();

  return {
    api, commands, providers, executions, processes, spawns, updates, memory, errors, input_boxes,
    warnings, links, opened_files, editable_copies, saved_files, save_dialogs,
    configuration: () => structuredClone(configuration_value),
    change_setting: (name: string, value: unknown) => {
      if (value === undefined) settings.delete(name);
      else settings.set(name, value);
      configuration_changed.fire({
        affectsConfiguration: section => name === section || name.startsWith(`${section}.`),
      });
    },
    replace_configuration: (next_configuration: sidebar_configuration) => {
      configuration_value = structuredClone(next_configuration);
      configuration_changed.fire({ affectsConfiguration: item => item === 'terminalSidebar.sidebars' });
    },
    grant_trust: async () => {
      api.workspace.isTrusted = true;
      trust_granted.fire();
      await next_turn();
    },
    async view(side: sidebar_side) {
      const provider = providers.get(view_ids[side]);
      assert.ok(provider, `${side} provider registered`);
      const view = new fake_view();
      await provider.resolveWebviewView(view as unknown as vscode.WebviewView, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
      await view.send({ type: 'ready' });
      return view;
    },
    async command(id: string, ...arguments_list: unknown[]) {
      const command = commands.get(id);
      assert.ok(command, `command ${id} is registered`);
      await command(...arguments_list);
      await next_turn();
    },
    dispose() {
      for (const subscription of subscriptions.splice(0).reverse()) subscription.dispose();
    },
  };
}

test('sidebars own separate processes even with the same profile and runtime IDs; every startup tab starts once', async test_case => {
  const runtime = await harness();
  test_case.after(() => runtime.dispose());
  assert.deepEqual([...runtime.providers.keys()].sort(), Object.values(view_ids).sort());
  assert.equal(runtime.processes.length, 0, 'activation alone runs no shell');
  const left = await runtime.view('left');
  assert.deepEqual(runtime.processes.map(terminal => terminal.writes), [['echo LEFT_START\r'], ['echo LEFT_SECOND\r']]);
  const right = await runtime.view('right');
  assert.equal(left.state().tabs[0].id, right.state().tabs[0].id, 'IDs may safely repeat across isolated sides');
  assert.deepEqual(runtime.processes.map(terminal => terminal.writes), [
    ['echo LEFT_START\r'], ['echo LEFT_SECOND\r'], ['echo RIGHT_START\r'], ['echo RIGHT_SECOND\r'],
  ]);
  for (const view of [left, right]) {
    await view.send({ type: 'activate', id: view.state().tabs[0].id, cols: 80, rows: 24 });
    view.hide();
    view.show();
  }
  assert.equal(runtime.processes.length, 4, 'reactivation and visibility changes retain all running processes');
  runtime.processes[0].data.fire('LEFT_OUTPUT');
  runtime.processes[2].data.fire('RIGHT_OUTPUT');
  await delay(20);
  assert.deepEqual(left.output().map(message => message.data), ['LEFT_OUTPUT']);
  assert.deepEqual(right.output().map(message => message.data), ['RIGHT_OUTPUT']);
});

test('opening the other sidebar reveals its view without duplicating terminals or reopening closed tabs', async test_case => {
  for (const source_side of ['left', 'right'] as const) {
    await test_case.test(`from ${source_side}`, async side_test => {
      const target_side = source_side === 'left' ? 'right' : 'left';
      const configuration = structuredClone(initial_configuration);
      configuration[source_side] = [];
      const runtime = await harness({ configuration });
      side_test.after(() => runtime.dispose());
      const source = await runtime.view(source_side);
      const focus_command = `${view_ids[target_side]}.focus`;

      await source.send({ type: 'open_other_sidebar' });
      assert.equal(runtime.executions.at(-1)?.id, focus_command,
        'focus can reveal a destination whose renderer does not exist yet');
      assert.equal(runtime.processes.length, 0, 'startup waits for the destination renderer');

      const target = await runtime.view(target_side);
      const original_tabs = target.state().tabs;
      const original_processes = [...runtime.processes];
      const original_writes = runtime.processes.map(terminal => [...terminal.writes]);
      assert.equal(original_processes.length, configuration[target_side].length);

      target.hide();
      await source.send({ type: 'open_other_sidebar' });
      assert.equal(runtime.executions.at(-1)?.id, focus_command,
        'a hidden destination is focused, never toggled');
      // VS Code handles the focus command by making its existing view visible.
      target.show();
      await Promise.all([
        source.send({ type: 'open_other_sidebar' }),
        source.send({ type: 'open_other_sidebar' }),
      ]);
      await runtime.command(target_side === 'left' ? 'terminalSidebar.openLeft' : 'terminalSidebar.open');
      assert.deepEqual(target.state().tabs, original_tabs);
      assert.deepEqual(runtime.processes, original_processes);
      assert.deepEqual(runtime.processes.map(terminal => terminal.writes), original_writes);
      assert.ok(runtime.processes.every(terminal => terminal.killed === 0));
      assert.deepEqual(source.state().tabs, []);

      for (const tab of original_tabs) await target.send({ type: 'close_tab', id: tab.id });
      target.hide();
      await source.send({ type: 'open_other_sidebar' });
      target.show();
      await source.send({ type: 'open_other_sidebar' });
      assert.deepEqual(target.state().tabs, [], 'closed startup tabs remain closed during this window');
      assert.deepEqual(runtime.processes, original_processes);
      assert.ok(runtime.processes.every(terminal => terminal.killed === 1));
      assert.deepEqual(runtime.updates, []);
      assert.deepEqual(runtime.configuration(), configuration);
    });
  }
});

test('sidebar navigation remains available without workspace trust and never bypasses the startup guard', async test_case => {
  const runtime = await harness({ trusted: false });
  test_case.after(() => runtime.dispose());
  const left = await runtime.view('left');
  await left.send({ type: 'open_other_sidebar' });
  assert.equal(runtime.executions.at(-1)?.id, `${view_ids.right}.focus`);
  const right = await runtime.view('right');
  await right.send({ type: 'open_other_sidebar' });
  assert.equal(runtime.executions.at(-1)?.id, `${view_ids.left}.focus`);
  assert.equal(runtime.processes.length, 0);
  assert.deepEqual(runtime.errors, []);
  assert.ok([left, right].every(view => !view.messages.some(message => message.type === 'error')));

  await runtime.grant_trust();
  assert.equal(runtime.processes.length, 4);
  const original_writes = runtime.processes.map(terminal => [...terminal.writes]);
  await left.send({ type: 'open_other_sidebar' });
  await right.send({ type: 'open_other_sidebar' });
  assert.equal(runtime.processes.length, 4);
  assert.deepEqual(runtime.processes.map(terminal => terminal.writes), original_writes);
});

test('adding, renaming and closing runtime tabs never rewrites startup settings', async test_case => {
  const runtime = await harness();
  test_case.after(() => runtime.dispose());
  const right = await runtime.view('right');
  const startup_tab = right.state().tabs[0];
  await right.send({ type: 'close_tab', id: startup_tab.id });
  assert.equal(runtime.processes[0].killed, 1);
  assert.ok(!right.state().tabs.some(tab => tab.id === startup_tab.id));
  assert.deepEqual(right.state().configuration, initial_configuration);
  await right.send({ type: 'add_tab' });
  const temporary_tab = right.state().tabs.at(-1)!;
  assert.equal(temporary_tab.name, 'Term 0');
  assert.equal(temporary_tab.command, '');
  assert.deepEqual(runtime.processes.at(-1)?.writes, [], 'temporary tabs are ordinary shells');
  await right.send({ type: 'rename_tab', id: temporary_tab.id, name: 'Scratch' });
  await right.send({ type: 'close_tab', id: temporary_tab.id });
  await right.send({ type: 'add_tab' });
  assert.equal(right.state().tabs.at(-1)?.name, 'Term 0', 'closing all ordinary tabs resets numbering');
  assert.deepEqual(runtime.updates, []);
  assert.deepEqual(runtime.configuration(), initial_configuration);
  const left = await runtime.view('left');
  await left.send({ type: 'add_tab' });
  assert.equal(left.state().tabs.at(-1)?.name, 'Term 0', 'each side owns its numbering');
});

test('closing running or unknown commands requires confirmation; an integrated idle prompt closes directly', async test_case => {
  let response: string | undefined;
  const runtime = await harness({ warning: () => response });
  test_case.after(() => runtime.dispose());
  const view = await runtime.view('right');
  const [first, second] = view.state().tabs;
  await view.send({ type: 'close_tab', id: first.id });
  assert.equal(runtime.processes[0].killed, 0, 'cancel preserves the process and tab');
  assert.ok(view.state().tabs.some(tab => tab.id === first.id));
  assert.match(runtime.warnings[0], /command is still running/);
  response = 'Close terminal';
  await view.send({ type: 'close_tab', id: first.id });
  assert.equal(runtime.processes[0].killed, 1);
  runtime.processes[1].data.fire('\x1b]133;A\x07');
  await view.send({ type: 'input', id: second.id, data: 'not submitted' });
  const before = runtime.warnings.length;
  await view.send({ type: 'close_tab', id: second.id });
  assert.equal(runtime.warnings.length, before, 'a shell-reported idle prompt needs no dialog');
  assert.equal(runtime.processes[1].killed, 1);
  await view.send({ type: 'add_tab' });
  const unknown = view.state().tabs[0];
  response = undefined;
  await view.send({ type: 'close_tab', id: unknown.id });
  assert.match(runtime.warnings.at(-1)!, /cannot confirm that it is idle/);
  assert.ok(view.state().tabs.some(tab => tab.id === unknown.id), 'unknown state remains protected');
  runtime.processes[2].exit.fire({ exitCode: 0 });
  const after_unknown = runtime.warnings.length;
  await view.send({ type: 'close_tab', id: unknown.id });
  assert.equal(runtime.warnings.length, after_unknown, 'an exited process needs no dialog');
  assert.equal(view.state().tabs.length, 0);
});

test('directory notifications persist per terminal while hidden and restore with a missing-directory fallback', async test_case => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'side_terminal_cwd_'));
  test_case.after(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = await harness();
  test_case.after(() => runtime.dispose());
  const view = await runtime.view('right');
  const target = view.state().tabs[1];
  view.hide();
  runtime.processes[1].data.fire(`\x1b]7;${pathToFileURL(directory).href}\x07`);
  await next_turn();
  const next_window = await harness({ memory: runtime.memory });
  test_case.after(() => next_window.dispose());
  const restored = await next_window.view('right');
  assert.equal(restored.state().tabs.find(tab => tab.id === target.id)?.cwd, directory);
  assert.equal(next_window.spawns[1].cwd, directory);
  assert.notEqual(next_window.spawns[0].cwd, directory, 'the other terminal retains its own directory');
  assert.deepEqual(runtime.updates, [], 'cwd never enters synced startup settings');
  rmSync(directory, { recursive: true, force: true });
  const missing = await harness({ memory: runtime.memory });
  test_case.after(() => missing.dispose());
  await missing.view('right');
  assert.equal(missing.spawns[1].cwd, os.homedir());
});

test('pending terminal confirmation excludes duplicate close and restart requests', async test_case => {
  let finish_warning!: (choice: string | undefined) => void;
  const runtime = await harness({ warning: () => new Promise(resolve => { finish_warning = resolve; }) });
  test_case.after(() => runtime.dispose());
  const view = await runtime.view('right');
  const id = view.state().tabs[0].id;
  await view.send({ type: 'close_tab', id });
  await view.send({ type: 'close_tab', id });
  await view.send({ type: 'restart', id, cols: 80, rows: 24 });
  assert.equal(runtime.warnings.length, 1);
  assert.equal(runtime.processes.length, 2);
  finish_warning(undefined);
  await next_turn();
  await view.send({ type: 'restart', id, cols: 80, rows: 24 });
  await view.send({ type: 'close_tab', id });
  assert.equal(runtime.warnings.length, 2, 'close cannot invalidate a pending restart');
  finish_warning('Restart');
  await next_turn();
  assert.equal(runtime.processes.length, 3);
  assert.equal(runtime.processes[2].killed, 0);
  assert.ok(view.state().tabs.some(tab => tab.id === id));
});

test('web/file links use validated messages and trusted terminals', async test_case => {
  const runtime = await harness();
  test_case.after(() => runtime.dispose());
  const view = await runtime.view('right');
  const id = view.state().tabs[0].id;
  await view.send({ type: 'open_link', id, uri: 'https://example.com/build' });
  await view.send({ type: 'open_link', id, uri: 'command:workbench.action.closeWindow' });
  assert.deepEqual(runtime.links, ['https://example.com/build']);
  await view.send({ type: 'open_file', id, path: 'src/app.ts', line: 3, column: 2 });
  await view.send({ type: 'open_file', id, path: 'file://server/share/app.ts', line: 1 });
  assert.deepEqual(runtime.opened_files, [path.join(os.homedir(), 'src/app.ts')]);
  runtime.api.workspace.isTrusted = false;
  await view.send({ type: 'open_link', id, uri: 'https://example.com/blocked' });
  assert.equal(runtime.links.length, 1);
});

test('remote file links keep URI authority and host-specific path characters', async test_case => {
  const remote_paths: string[] = [];
  const runtime = await harness({ workspace_uri: {
    scheme: 'vscode-remote', fsPath: os.homedir(),
    with(change) {
      assert.ok(change.path.startsWith('/'), 'URI paths with authority need a leading slash, including Windows drive paths');
      remote_paths.push(change.path);
      return { scheme: 'vscode-remote', authority: 'ssh-remote+test', path: change.path, fsPath: change.path };
    },
  } });
  test_case.after(() => runtime.dispose());
  const view = await runtime.view('right');
  const id = view.state().tabs[0].id;
  // Backslashes are separators on Windows and literal filename characters on POSIX.
  const file = path.join(os.homedir(), 'source\\name #1.ts');
  await view.send({ type: 'open_file', id, path: file, line: 2 });
  const expected_path = decodeURIComponent(pathToFileURL(file).pathname);
  assert.deepEqual(remote_paths, [expected_path]);
  assert.deepEqual(runtime.opened_files, [expected_path]);
  assert.ok(!view.messages.some(message => message.type === 'error'));
});

test('plain text and HTML exports use separate save formats and preserve content', async test_case => {
  const destination = path.join(os.tmpdir(), 'side_terminal_export.html');
  const runtime = await harness({ save_destination: destination });
  test_case.after(() => runtime.dispose());
  const view = await runtime.view('right');
  const id = view.state().tabs[0].id;
  await view.send({ type: 'export', id, text: 'plain text' });
  await view.send({ type: 'export', id, text: '<pre><span style="color:red">failure</span></pre>', format: 'html' });
  assert.deepEqual(runtime.save_dialogs.map(options => options.filters), [{ 'Plain text files': ['txt'] }, { 'HTML files': ['html'] }]);
  assert.deepEqual(runtime.saved_files.map(file => file.text), ['plain text', '<pre><span style="color:red">failure</span></pre>']);
});

test('PDF export decodes binary data while Markdown stays text and malformed PDF is ignored', async test_case => {
  const runtime = await harness({ save_destination: path.join(os.tmpdir(), 'side_terminal_export.pdf') });
  test_case.after(() => runtime.dispose());
  const view = await runtime.view('right');
  const id = view.state().tabs[0].id;
  const pdf_bytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from([0, 128, 255]), Buffer.from('\n%%EOF')]);
  await view.send({ type: 'export', id, format: 'pdf', text: pdf_bytes.toString('base64') });
  await view.send({ type: 'export', id, format: 'markdown', text: '# Terminal\n\n<pre>中文</pre>\n' });
  await view.send({ type: 'export', id, format: 'pdf', text: '<html>not PDF</html>' });
  assert.deepEqual(runtime.save_dialogs.map(options => options.filters), [{ 'PDF files': ['pdf'] }, { 'Markdown files': ['md'] }]);
  assert.deepEqual(runtime.saved_files[0].bytes, pdf_bytes);
  assert.equal(runtime.saved_files[1].text, '# Terminal\n\n<pre>中文</pre>\n');
});

test('tab name colors are local, independent by side, validated, and removable', async test_case => {
  const runtime = await harness();
  test_case.after(() => runtime.dispose());
  const left = await runtime.view('left');
  const right = await runtime.view('right');
  const id = left.state().tabs[0].id;
  const right_before = right.state();
  const original_processes = [...runtime.processes];
  await left.send({ type: 'set_tab_color', id, color: 'ansiBlue' });
  assert.equal(left.state().tabs[0].name_color, 'ansiBlue');
  assert.deepEqual(right.state(), right_before);
  assert.deepEqual(runtime.updates, []);
  const color_memory = structuredClone(runtime.memory);
  await left.send({ type: 'set_tab_color', id, color: 'url(invalid)' } as unknown as client_message);
  await left.send({ type: 'set_tab_color', id: 'missing', color: 'ansiGreen' });
  assert.equal(left.state().tabs[0].name_color, 'ansiBlue');
  assert.deepEqual(runtime.memory, color_memory);
  await right.send({ type: 'set_tab_color', id: right.state().tabs[0].id, color: 'ansiYellow' });
  const next_window = await harness({ memory: runtime.memory });
  test_case.after(() => next_window.dispose());
  assert.equal((await next_window.view('left')).state().tabs[0].name_color, 'ansiBlue');
  assert.equal((await next_window.view('right')).state().tabs[0].name_color, 'ansiYellow');
  await left.send({ type: 'set_tab_color', id });
  assert.equal(left.state().tabs[0].name_color, undefined);
  assert.equal(right.state().tabs[0].name_color, 'ansiYellow');
  assert.deepEqual(runtime.processes, original_processes);
  assert.ok(runtime.processes.every(terminal => terminal.killed === 0));
  assert.deepEqual(runtime.updates, []);
});

test('find remains in the terminal and obsolete replace requests cannot open an editor copy', async test_case => {
  const runtime = await harness();
  test_case.after(() => runtime.dispose());
  const views = { left: await runtime.view('left'), right: await runtime.view('right') };
  const writes = runtime.processes.map(terminal => [...terminal.writes]);
  for (const side of ['left', 'right'] as const) {
    assert.equal(runtime.commands.has(`terminalSidebar.${side}.replace`), false);
    assert.ok(runtime.commands.has(`terminalSidebar.${side}.find`));
    await runtime.commands.get(`terminalSidebar.${side}.find`)!();
    assert.deepEqual(views[side].messages.at(-1), { type: 'action', action: 'find' });
    await views[side].send({ type: 'replace_copy', id: views[side].state().tabs[0].id, text: 'hello 中文\n' } as unknown as client_message);
  }
  assert.deepEqual(runtime.editable_copies, []);
  assert.equal(runtime.executions.some(command => command.id === 'editor.action.startFindReplaceAction'), false);
  assert.deepEqual(runtime.processes.map(terminal => terminal.writes), writes);
  assert.deepEqual(runtime.saved_files, []);
});

test('native rename changes only the requested terminal and remembers names on both sides', async test_case => {
  const runtime = await harness({ input: options => ` ${options.value} renamed ` });
  test_case.after(() => runtime.dispose());
  const views = { left: await runtime.view('left'), right: await runtime.view('right') };
  const original_processes = [...runtime.processes];
  const original_writes = runtime.processes.map(terminal => [...terminal.writes]);
  // The Primary button belongs to its own section, including a collapsed,
  // inactive section. The Secondary button belongs to the selected tab.
  await views.left.send({ type: 'select', id: views.left.state().tabs[1].id });
  await views.left.send({ type: 'expanded', id: views.left.state().tabs[0].id, expanded: false });

  for (const side of ['left', 'right'] as const) {
    const view = views[side];
    const previous = view.state();
    const target = previous.tabs[0];
    const other = views[side === 'left' ? 'right' : 'left'];
    const other_state = other.state();
    await view.send({ type: 'request_rename', id: target.id });
    const prompt = runtime.input_boxes.at(-1)!;
    assert.equal(prompt.title, 'Rename terminal');
    assert.equal(prompt.value, target.name);
    assert.deepEqual([...prompt.valueSelection!], [0, target.name.length]);
    assert.deepEqual(view.state().tabs, previous.tabs.map(tab => tab.id === target.id
      ? { ...tab, name: `${target.name} renamed` } : tab));
    assert.equal(view.state().active_id, previous.active_id);
    assert.deepEqual(view.state().expanded_ids, previous.expanded_ids);
    assert.deepEqual(other.state(), other_state);
  }
  assert.deepEqual(runtime.processes, original_processes);
  assert.deepEqual(runtime.processes.map(terminal => terminal.writes), original_writes);
  assert.ok(runtime.processes.every(terminal => terminal.killed === 0));
  assert.deepEqual(runtime.updates, []);
  assert.deepEqual(runtime.configuration(), initial_configuration);
  const reopened_runtime = await harness({ memory: runtime.memory });
  test_case.after(() => reopened_runtime.dispose());
  for (const side of ['left', 'right'] as const) {
    const reopened = await reopened_runtime.view(side);
    assert.deepEqual(reopened.state().tabs, views[side].state().tabs);
    assert.equal(reopened.state().active_id, views[side].state().active_id);
    assert.deepEqual(reopened.state().expanded_ids, views[side].state().expanded_ids);
  }
});

test('native rename rejects invalid values and treats cancel or unchanged names as no action', async test_case => {
  let response: string | undefined;
  const runtime = await harness({ input: () => response });
  test_case.after(() => runtime.dispose());
  const view = await runtime.view('right');
  const target = view.state().tabs[0];
  const initial_state = view.state();
  const initial_memory = structuredClone(runtime.memory);
  const initial_message_count = view.messages.length;
  const invalid_names = ['', '  ', 'x'.repeat(81), 'two\nlines', 'control\u007f'];
  for (response of [undefined, target.name, ` ${target.name} `, ...invalid_names]) {
    await view.send({ type: 'request_rename', id: target.id });
  }
  assert.deepEqual(view.state(), initial_state);
  assert.equal(view.messages.length, initial_message_count, 'cancel and no-op results do not repaint the terminal');
  assert.deepEqual(runtime.memory, initial_memory);
  const validate = runtime.input_boxes[0].validateInput!;
  assert.equal(await validate('部署 terminal'), undefined);
  assert.equal(await validate('x'.repeat(80)), undefined);
  for (const name of invalid_names) assert.ok(await validate(name), JSON.stringify(name));
  const previous_prompt_count = runtime.input_boxes.length;
  await view.send({ type: 'request_rename', id: 'missing_tab' });
  assert.equal(runtime.input_boxes.length, previous_prompt_count, 'unknown tabs never open a prompt');
  response = 'Accepted after cancellation';
  await view.send({ type: 'request_rename', id: target.id });
  assert.equal(view.state().tabs[0].name, response, 'the next valid request remains usable');
});

test('pending rename cannot target a replacement tab or open duplicate native prompts', async test_case => {
  let finish_input!: (name: string | undefined) => void;
  const runtime = await harness({ input: () => new Promise(resolve => { finish_input = resolve; }) });
  test_case.after(() => runtime.dispose());
  const left = await runtime.view('left');
  const right = await runtime.view('right');
  const target = right.state().tabs[0];
  await right.send({ type: 'request_rename', id: target.id });
  await right.send({ type: 'request_rename', id: target.id });
  await left.send({ type: 'request_rename', id: left.state().tabs[0].id });
  assert.equal(runtime.input_boxes.length, 1, 'both views share one native rename prompt');
  await right.send({ type: 'close_tab', id: target.id });
  await runtime.command('terminalSidebar.openProfile', target.profile_id);
  const replacement = right.state().tabs.find(tab => tab.profile_id === target.profile_id)!;
  assert.notEqual(replacement.id, target.id);
  const previous = right.state();
  const previous_memory = structuredClone(runtime.memory);
  const previous_processes = [...runtime.processes];
  finish_input('Stale name');
  await next_turn();
  assert.deepEqual(right.state(), previous);
  assert.deepEqual(runtime.memory, previous_memory);
  assert.deepEqual(runtime.processes, previous_processes);
  assert.deepEqual(runtime.updates, []);

  await right.send({ type: 'request_rename', id: replacement.id });
  assert.equal(runtime.input_boxes.length, 2, 'a later request can open normally');
  await right.send({ type: 'rename_tab', id: replacement.id, name: 'Newer name' });
  finish_input('Older dialog result');
  await next_turn();
  assert.equal(right.state().tabs.find(tab => tab.id === replacement.id)?.name, 'Newer name');
});

test('saving startup settings preserves live terminal names, processes and commands until the next window', async test_case => {
  const runtime = await harness();
  test_case.after(() => runtime.dispose());
  const left = await runtime.view('left');
  const right = await runtime.view('right');
  const previous_tabs = right.state().tabs;
  const updated_configuration: sidebar_configuration = {
    left: [],
    right: [{ id: 'replacement', name: 'Replacement', command: 'echo NEXT_WINDOW', shell: '' }],
  };
  await left.send({ type: 'save', configuration: updated_configuration, base_configuration: initial_configuration });
  assert.deepEqual(runtime.updates, [updated_configuration]);
  assert.deepEqual(right.state().tabs, previous_tabs);
  assert.equal(runtime.processes.length, 4);
  assert.ok(runtime.processes.every(terminal => terminal.killed === 0));
  assert.ok(left.messages.some(message => message.type === 'saved'));
  const next_window = await harness({ configuration: updated_configuration, memory: runtime.memory });
  test_case.after(() => next_window.dispose());
  const next_right = await next_window.view('right');
  assert.deepEqual(next_right.state().tabs.map(tab => tab.name), ['Replacement']);
  assert.deepEqual(next_window.processes[0].writes, ['echo NEXT_WINDOW\r']);
});

test('stale startup drafts cannot overwrite another settings surface', async test_case => {
  const runtime = await harness();
  test_case.after(() => runtime.dispose());
  const left = await runtime.view('left');
  const elsewhere = structuredClone(initial_configuration);
  elsewhere.right[0].name = 'Edited elsewhere';
  runtime.replace_configuration(elsewhere);
  const draft = structuredClone(initial_configuration);
  draft.right[0].name = 'My draft';
  await left.send({ type: 'save', configuration: draft, base_configuration: initial_configuration });
  assert.deepEqual(runtime.updates, []);
  assert.deepEqual(runtime.configuration(), elsewhere);
  assert.ok(left.messages.some(message => message.type === 'error' && message.message.includes('changed elsewhere')));
  await left.send({ type: 'save', configuration: draft, base_configuration: elsewhere });
  assert.deepEqual(runtime.updates, [draft]);
});

test('workspace memory restores tab names and selection but stores neither typed input, output nor commands', async test_case => {
  const runtime = await harness();
  test_case.after(() => runtime.dispose());
  const right = await runtime.view('right');
  const startup_tab = right.state().tabs[0];
  await right.send({ type: 'close_tab', id: startup_tab.id });
  await right.send({ type: 'add_tab' });
  const temporary_tab = right.state().tabs.at(-1)!;
  await right.send({ type: 'rename_tab', id: temporary_tab.id, name: 'Scratch' });
  await right.send({ type: 'input', id: temporary_tab.id, data: 'TYPED_SECRET\r' });
  runtime.processes.at(-1)!.data.fire('OUTPUT_SECRET');
  assert.deepEqual(runtime.processes.at(-1)?.writes, ['TYPED_SECRET\r']);
  const serialized_memory = JSON.stringify([...runtime.memory.entries()]);
  assert.doesNotMatch(serialized_memory, /TYPED_SECRET|OUTPUT_SECRET|echo RIGHT_START|command|shell/);
  const next_window = await harness({ memory: runtime.memory });
  test_case.after(() => next_window.dispose());
  const reopened = await next_window.view('right');
  assert.deepEqual(reopened.state().tabs.map(tab => tab.name), ['Right Two', 'Scratch', 'Right One']);
  assert.equal(reopened.state().tabs.find(tab => tab.id === reopened.state().active_id)?.name, 'Scratch');
  assert.deepEqual(next_window.processes.map(terminal => terminal.writes), [
    ['echo RIGHT_SECOND\r'], [], ['echo RIGHT_START\r'],
  ], 'startup settings reopen while remembered temporary tabs start clean shells');
  await reopened.send({ type: 'add_tab' });
  assert.equal(reopened.state().tabs.at(-1)?.name, 'Term 1');
});

test('both sidebars persist rapid tab moves and collapsed state without changing their running processes', async test_case => {
  const runtime = await harness();
  test_case.after(() => runtime.dispose());
  const views = { left: await runtime.view('left'), right: await runtime.view('right') };
  for (const view of Object.values(views)) await view.send({ type: 'add_tab' });
  const original_processes = [...runtime.processes];
  const original_writes = runtime.processes.map(terminal => [...terminal.writes]);
  const expected_states = new Map<sidebar_side, ReturnType<fake_view['state']>>();

  for (const side of ['left', 'right'] as const) {
    const view = views[side];
    const [first, second, temporary] = view.state().tabs;
    await view.send({ type: 'select', id: second.id });
    for (const tab of view.state().tabs) await view.send({ type: 'expanded', id: tab.id, expanded: false });
    const other_side = side === 'left' ? 'right' : 'left';
    const other_state = views[other_side].state();
    // Deliver a burst before awaiting any handler, as quick repeated drags can do.
    await Promise.all([
      view.send({ type: 'move_tab', id: temporary.id, target_id: first.id, placement: 'before' }),
      view.send({ type: 'move_tab', id: first.id, target_id: second.id, placement: 'after' }),
      view.send({ type: 'move_tab', id: temporary.id, target_id: first.id, placement: 'after' }),
    ]);
    assert.deepEqual(view.state().tabs.map(tab => tab.id), [second.id, first.id, temporary.id]);
    assert.equal(view.state().active_id, second.id);
    assert.deepEqual(view.state().expanded_ids, []);
    assert.deepEqual(views[other_side].state(), other_state, 'a move remains local to its originating sidebar');
    expected_states.set(side, view.state());
  }
  assert.deepEqual(runtime.processes, original_processes);
  assert.deepEqual(runtime.processes.map(terminal => terminal.writes), original_writes);
  assert.ok(runtime.processes.every(terminal => terminal.killed === 0));
  assert.deepEqual(runtime.updates, []);

  const next_window = await harness({ memory: runtime.memory });
  test_case.after(() => next_window.dispose());
  for (const side of ['left', 'right'] as const) {
    const restored = (await next_window.view(side)).state();
    const expected = expected_states.get(side)!;
    assert.deepEqual(restored.tabs, expected.tabs);
    assert.equal(restored.active_id, expected.active_id);
    assert.deepEqual(restored.expanded_ids, []);
  }
  assert.deepEqual(next_window.processes.map(terminal => terminal.writes), [
    ['echo LEFT_SECOND\r'], ['echo LEFT_START\r'], [],
    ['echo RIGHT_SECOND\r'], ['echo RIGHT_START\r'], [],
  ]);
});

test('stale or malformed tab moves leave open tabs, stored layout, and processes untouched', async test_case => {
  const runtime = await harness();
  test_case.after(() => runtime.dispose());
  const left = await runtime.view('left');
  const [closed, remaining] = left.state().tabs;
  await left.send({ type: 'close_tab', id: closed.id });
  const original_state = left.state();
  const original_memory = structuredClone(runtime.memory);
  const messages: unknown[] = [
    { type: 'move_tab', id: closed.id, target_id: remaining.id, placement: 'before' },
    { type: 'move_tab', id: remaining.id, target_id: closed.id, placement: 'after' },
    { type: 'move_tab', id: remaining.id, target_id: remaining.id, placement: 'before' },
    { type: 'move_tab', id: remaining.id, target_id: '../invalid', placement: 'after' },
    { type: 'move_tab', id: remaining.id, target_id: closed.id, placement: 'middle' },
  ];
  for (const message of messages) left.incoming.fire(message);
  await next_turn();
  assert.deepEqual(left.state(), original_state);
  assert.deepEqual(runtime.memory, original_memory);
  assert.equal(runtime.processes.length, 2);
  assert.deepEqual(runtime.processes.map(terminal => terminal.killed), [1, 0]);
  assert.deepEqual(runtime.errors, []);
});

test('hidden or collapsed surfaces cannot resize or type into their terminal', async test_case => {
  const runtime = await harness();
  test_case.after(() => runtime.dispose());
  const left = await runtime.view('left');
  const right = await runtime.view('right');
  const left_identifier = left.state().tabs[0].id;
  const right_identifier = right.state().tabs[0].id;
  await left.send({ type: 'resize', id: left_identifier, cols: 91, rows: 31 });
  await right.send({ type: 'resize', id: right_identifier, cols: 101, rows: 41 });
  assert.deepEqual(runtime.processes[0].sizes, [[91, 31]]);
  assert.deepEqual(runtime.processes[2].sizes, [[101, 41]]);
  await left.send({ type: 'expanded', id: left_identifier, expanded: false });
  await left.send({ type: 'resize', id: left_identifier, cols: 5, rows: 2 });
  await left.send({ type: 'input', id: left_identifier, data: 'hidden input' });
  right.hide();
  await right.send({ type: 'resize', id: right_identifier, cols: 6, rows: 3 });
  await right.send({ type: 'focus', id: right_identifier });
  assert.deepEqual(runtime.processes[0].sizes, [[91, 31]]);
  assert.deepEqual(runtime.processes[0].writes, ['echo LEFT_START\r']);
  assert.deepEqual(runtime.processes[2].sizes, [[101, 41]]);
  right.show();
  await right.send({ type: 'select', id: right.state().tabs[1].id });
  await right.send({ type: 'resize', id: right_identifier, cols: 7, rows: 4 });
  assert.deepEqual(runtime.processes[2].sizes, [[101, 41]], 'inactive right tabs do not resize');
  await left.send({ type: 'expanded', id: left_identifier, expanded: true });
  await left.send({ type: 'resize', id: left_identifier, cols: 92, rows: 32 });
  assert.deepEqual(runtime.processes[0].sizes, [[91, 31], [92, 32]]);
});

test('recreated views replay pending output once and retain their existing processes', async test_case => {
  const runtime = await harness();
  test_case.after(() => runtime.dispose());
  const original = await runtime.view('right');
  runtime.processes[0].data.fire('BEFORE_DISPOSAL');
  original.dispose();
  runtime.processes[0].data.fire('AFTER_DISPOSAL');
  const recreated = await runtime.view('right');
  await delay(20);
  assert.deepEqual(recreated.output().map(message => message.data), ['BEFORE_DISPOSALAFTER_DISPOSAL']);
  assert.equal(runtime.processes.length, 2);
  runtime.processes[0].data.fire('NEW_OUTPUT');
  await delay(20);
  assert.deepEqual(recreated.output().map(message => message.data), ['BEFORE_DISPOSALAFTER_DISPOSAL', 'NEW_OUTPUT']);
});

test('both gears route to the left editor and opening configuration alone starts no terminal', async test_case => {
  const runtime = await harness();
  test_case.after(() => runtime.dispose());
  await runtime.command('terminalSidebar.right.configure');
  const left = await runtime.view('left');
  assert.equal(runtime.processes.length, 0);
  assert.ok(left.messages.some(message => message.type === 'configure'));
  await left.send({ type: 'draft_state', configuring: true, can_undo: true, can_redo: false });
  assert.deepEqual(runtime.executions.slice(-3).map(item => item.args), [
    ['terminalSidebar.left.configuring', true],
    ['terminalSidebar.left.canUndo', true],
    ['terminalSidebar.left.canRedo', false],
  ]);
  for (const side of ['left', 'right'] as const) {
    await runtime.command(`terminalSidebar.${side}.configure`);
    assert.equal(runtime.executions.at(-1)?.id, 'terminalSidebar.left.focus');
  }
  for (const action of ['save', 'undo', 'redo', 'close']) {
    await runtime.command(`terminalSidebar.left.${action}`);
  }
  assert.deepEqual(left.messages.filter(message => message.type === 'action'), [
    { type: 'action', action: 'save' }, { type: 'action', action: 'undo' },
    { type: 'action', action: 'redo' }, { type: 'action', action: 'close' },
  ]);
  assert.equal(runtime.processes.length, 0);
  await left.send({ type: 'draft_state', configuring: false, can_undo: false, can_redo: false });
  assert.equal(runtime.processes.length, 2, 'leaving configuration opens startup terminals once');
});

test('named startup commands select or reopen only their target side without changing configuration', async test_case => {
  const runtime = await harness();
  test_case.after(() => runtime.dispose());
  const left = await runtime.view('left');
  const right = await runtime.view('right');
  await runtime.command('terminalSidebar.openProfile', 'Right Two');
  assert.equal(right.state().tabs.find(tab => tab.id === right.state().active_id)?.profile_id, 'two');
  assert.equal(left.state().tabs.find(tab => tab.id === left.state().active_id)?.profile_id, 'one');
  const closed_identifier = left.state().tabs[0].id;
  await left.send({ type: 'close_tab', id: closed_identifier });
  await runtime.command('terminalSidebar.openProfile', { id: 'one', side: 'left' });
  assert.equal(left.state().tabs.find(tab => tab.id === left.state().active_id)?.profile_id, 'one');
  assert.equal(runtime.processes.length, 5);
  assert.deepEqual(runtime.processes.at(-1)?.writes, ['echo LEFT_START\r']);
  assert.deepEqual(runtime.updates, []);
});

test('workspace trust gates all startup terminals and disposal releases both sides once', async test_case => {
  const runtime = await harness({ trusted: false });
  test_case.after(() => runtime.dispose());
  const left = await runtime.view('left');
  const right = await runtime.view('right');
  await left.send({ type: 'activate', id: left.state().tabs[0].id, cols: 80, rows: 24 });
  assert.equal(runtime.processes.length, 0);
  assert.ok(left.messages.some(message => message.type === 'error' && message.message.includes('Trust')));
  await runtime.grant_trust();
  assert.equal(runtime.processes.length, 4);
  await runtime.grant_trust();
  assert.equal(runtime.processes.length, 4);
  runtime.dispose();
  assert.ok(runtime.processes.every(terminal => terminal.killed === 1));
  assert.ok(runtime.processes.every(terminal => terminal.data.listeners.size === 0 && terminal.exit.listeners.size === 0));
  assert.equal(left.incoming.listeners.size, 0);
  assert.equal(right.incoming.listeners.size, 0);
  assert.equal(runtime.commands.size, 0);
  assert.equal(runtime.providers.size, 0);
});

test('legacy startup settings migrate to the right side without writing user settings', async test_case => {
  const runtime = await harness({ legacy_profiles: initial_configuration.right });
  test_case.after(() => runtime.dispose());
  const left = await runtime.view('left');
  const right = await runtime.view('right');
  assert.deepEqual(left.state().tabs, []);
  assert.deepEqual(right.state().tabs.map(tab => tab.name), ['Right One', 'Right Two']);
  assert.equal(runtime.processes.length, 2);
  assert.deepEqual(runtime.updates, []);
});

test('both sidebars inherit editor scrollbar defaults and terminal text settings', async test_case => {
  const runtime = await harness({ settings: {
    'editor.fontFamily': 'Editor Mono',
    'terminal.integrated.fontSize': 16,
  } });
  test_case.after(() => runtime.dispose());
  const left = await runtime.view('left');
  const right = await runtime.view('right');
  const expected_appearance = {
    font_family: 'Editor Mono', font_size: 16, cursor_blink: false, scrollback: 1000,
    editor_scrollbar_vertical: 'auto', editor_scrollbar_horizontal: 'auto',
    editor_scrollbar_vertical_size: 14, editor_scrollbar_horizontal_size: 12,
  };
  assert.deepEqual(left.state().appearance, expected_appearance);
  assert.deepEqual(right.state().appearance, expected_appearance);
  runtime.change_setting('terminal.integrated.fontFamily', 'Terminal Mono');
  assert.equal(left.state().appearance.font_family, 'Terminal Mono');
  assert.equal(right.state().appearance.font_family, 'Terminal Mono');
});

test('editor scrollbar changes update open sidebars without restarting terminals or rewriting settings', async test_case => {
  const runtime = await harness({ settings: {
    'editor.scrollbar.vertical': 'visible',
    'editor.scrollbar.horizontal': 'hidden',
    'editor.scrollbar.verticalScrollbarSize': 20,
    'editor.scrollbar.horizontalScrollbarSize': 9,
  } });
  test_case.after(() => runtime.dispose());
  const left = await runtime.view('left');
  const right = await runtime.view('right');
  assert.equal(left.state().appearance.editor_scrollbar_vertical, 'visible');
  assert.equal(right.state().appearance.editor_scrollbar_horizontal, 'hidden');
  assert.equal(left.state().appearance.editor_scrollbar_vertical_size, 20);
  assert.equal(right.state().appearance.editor_scrollbar_horizontal_size, 9);

  runtime.change_setting('editor.scrollbar.vertical', 'hidden');
  runtime.change_setting('editor.scrollbar.horizontal', 'visible');
  runtime.change_setting('editor.scrollbar.verticalScrollbarSize', 0);
  runtime.change_setting('editor.scrollbar.horizontalScrollbarSize', 18);
  for (const view of [left, right]) {
    assert.equal(view.state().appearance.editor_scrollbar_vertical, 'hidden');
    assert.equal(view.state().appearance.editor_scrollbar_horizontal, 'visible');
    assert.equal(view.state().appearance.editor_scrollbar_vertical_size, 0);
    assert.equal(view.state().appearance.editor_scrollbar_horizontal_size, 18);
  }
  runtime.change_setting('editor.scrollbar.vertical', undefined);
  runtime.change_setting('editor.scrollbar.verticalScrollbarSize', undefined);
  assert.equal(left.state().appearance.editor_scrollbar_vertical, 'auto');
  assert.equal(right.state().appearance.editor_scrollbar_vertical_size, 14);
  assert.equal(runtime.processes.length, 4);
  assert.ok(runtime.processes.every(terminal => terminal.killed === 0));
  assert.deepEqual(runtime.updates, []);
});

test('malformed scrollbar preferences fall back and numeric dimensions follow editor bounds', async test_case => {
  const runtime = await harness({ settings: {
    'editor.scrollbar.vertical': 'unexpected',
    'editor.scrollbar.horizontal': false,
    'editor.scrollbar.verticalScrollbarSize': Number.NaN,
    'editor.scrollbar.horizontalScrollbarSize': 'large',
  } });
  test_case.after(() => runtime.dispose());
  const right = await runtime.view('right');
  assert.equal(right.state().appearance.editor_scrollbar_vertical, 'auto');
  assert.equal(right.state().appearance.editor_scrollbar_horizontal, 'auto');
  assert.equal(right.state().appearance.editor_scrollbar_vertical_size, 14);
  assert.equal(right.state().appearance.editor_scrollbar_horizontal_size, 12);
  runtime.change_setting('editor.scrollbar.verticalScrollbarSize', -2);
  runtime.change_setting('editor.scrollbar.horizontalScrollbarSize', 2000);
  assert.equal(right.state().appearance.editor_scrollbar_vertical_size, 0);
  assert.equal(right.state().appearance.editor_scrollbar_horizontal_size, 1000);
  runtime.change_setting('editor.scrollbar.verticalScrollbarSize', 10.9);
  runtime.change_setting('editor.scrollbar.horizontalScrollbarSize', Number.POSITIVE_INFINITY);
  assert.equal(right.state().appearance.editor_scrollbar_vertical_size, 10);
  assert.equal(right.state().appearance.editor_scrollbar_horizontal_size, 12);
});
