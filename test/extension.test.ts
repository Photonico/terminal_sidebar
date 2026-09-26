import assert from 'node:assert/strict';
import { createRequire as create_require } from 'node:module';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { setImmediate as next_turn, setTimeout as delay } from 'node:timers/promises';
import { runInNewContext as run_in_new_context } from 'node:vm';
import { build } from 'esbuild';
import type * as vscode from 'vscode';
import { is_terminal_tab, is_pdf_tab, is_markdown_tab, is_document_tab } from '../src/types';
import type { client_message, host_message, sidebar_configuration, sidebar_side, terminal_profile, sidebar_tab } from '../src/types';
import type { latex_pdf_candidates, synctex_location } from '../src/latex_preview';
import type { pty_process, pty_spawn_options } from '../src/sessions';

const repository_root = path.resolve(__dirname, '..');
const require_builtin = create_require(path.join(repository_root, 'package.json'));
const view_ids = { left: 'terminalSidebar.left', right: 'terminalSidebar.terminals' } as const;
type disposable = { dispose(): void };
const global_storage_directories = new WeakMap<Map<string, unknown>, string>();
const storage_cleanup: string[] = [];
after(() => { for (const directory of storage_cleanup) rmSync(directory, { recursive: true, force: true }); });

function global_directory(memory: Map<string, unknown>): string {
  let directory = global_storage_directories.get(memory);
  if (!directory) {
    directory = mkdtempSync(path.join(os.tmpdir(), 'terminal_sidebar_host_storage_'));
    storage_cleanup.push(directory);
    global_storage_directories.set(memory, directory);
  }
  return directory;
}

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
      builder.onResolve({ filter: /^\.\/(discovery|shell|latex_preview)$/ }, arguments_object => ({
        path: arguments_object.path,
        namespace: 'host-test',
      }));
      builder.onLoad({ filter: /.*/, namespace: 'host-test' }, arguments_object => ({
        contents: arguments_object.path === './latex_preview'
          ? 'exports.reverse_sync = (...args) => globalThis.test_reverse_sync(...args); exports.resolve_latex_pdf = (...args) => globalThis.test_latex_pdf(...args);'
          : arguments_object.path === './discovery'
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

class fake_uri {
  private constructor(private readonly value: URL) {}
  static parse(value: string): fake_uri { return new fake_uri(new URL(value)); }
  static file(filename: string): fake_uri { return new fake_uri(pathToFileURL(filename)); }
  static joinPath(base: fake_uri, ...parts: string[]): fake_uri {
    return base.with({ path: path.posix.join(base.path, ...parts) });
  }
  get scheme(): string { return this.value.protocol.slice(0, -1); }
  get authority(): string { return this.value.host; }
  get path(): string { return decodeURIComponent(this.value.pathname); }
  get fsPath(): string { return this.scheme === 'file' ? fileURLToPath(this.value) : this.path; }
  get query(): string { return this.value.search.slice(1); }
  with(change: { path?: string; query?: string; fragment?: string }): fake_uri {
    const value = new URL(this.value);
    if (change.path !== undefined) value.pathname = change.path;
    if (change.query !== undefined) value.search = change.query;
    if (change.fragment !== undefined) value.hash = change.fragment;
    return new fake_uri(value);
  }
  toString(): string { return this.value.toString(); }
}

class fake_watcher {
  readonly changed = new event_source<fake_uri>();
  readonly created = new event_source<fake_uri>();
  readonly deleted = new event_source<fake_uri>();
  readonly onDidChange = this.changed.subscribe;
  readonly onDidCreate = this.created.subscribe;
  readonly onDidDelete = this.deleted.subscribe;
  disposed = false;
  constructor(readonly pattern: { baseUri: fake_uri; pattern: string }) {}
  dispose(): void {
    this.disposed = true;
    for (const source of [this.changed, this.created, this.deleted]) source.listeners.clear();
  }
}

function terminal(tab: sidebar_tab | undefined) {
  assert.ok(tab && is_terminal_tab(tab), 'expected a terminal tab');
  return tab;
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
  renderer_id = 'renderer_0';
  options_updates = 0;
  reload_on_options = true;
  private renderer_number = 0;
  title?: string;
  readonly messages: host_message[] = [];
  readonly incoming = new event_source<unknown>();
  readonly visibility = new event_source<void>();
  readonly disposal = new event_source<void>();
  readonly onDidChangeVisibility = this.visibility.subscribe;
  readonly onDidDispose = this.disposal.subscribe;
  readonly webview = {
    options: {} as { localResourceRoots?: fake_uri[] },
    html: '',
    cspSource: 'vscode-webview://host-test',
    asWebviewUri: (uri: unknown) => uri,
    onDidReceiveMessage: this.incoming.subscribe,
    postMessage: async (message: host_message) => {
      this.messages.push(structuredClone(message));
      return true;
    },
  };

  constructor(private readonly flush_file_io: () => Promise<void> = async () => {}, ready_on_html = false) {
    let html = '';
    let options: { localResourceRoots?: fake_uri[] } = {};
    Object.defineProperty(this.webview, 'options', {
      get: () => options,
      set: (value: { localResourceRoots?: fake_uri[] }) => {
        options = value;
        this.options_updates++;
        if (html) {
          this.renderer_id = `renderer_${++this.renderer_number}`;
          if (this.reload_on_options) queueMicrotask(() => {
            this.incoming.fire({ type: 'ready', renderer_id: this.renderer_id });
          });
        }
      },
    });
    Object.defineProperty(this.webview, 'html', {
      get: () => html,
      set: (value: string) => {
        html = value;
        if (ready_on_html) this.incoming.fire({ type: 'ready', renderer_id: this.renderer_id });
      },
    });
  }

  async send(message: client_message): Promise<void> {
    this.incoming.fire(message);
    // The public event returns void. Flush its handler without advancing output timers.
    await next_turn();
    await this.flush_file_io();
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
  global_memory?: Map<string, unknown>;
  global_storage_directory?: string;
  ready_on_html?: boolean;
  trusted?: boolean;
  settings?: Record<string, unknown>;
  input?: (options: vscode.InputBoxOptions) => string | undefined | Promise<string | undefined>;
  warning?: (message: string, first: string) => string | undefined | Promise<string | undefined>;
  save_destination?: string;
  open_destination?: string;
  reverse_sync?: (...args: unknown[]) => Promise<synctex_location>;
  latex_pdf?: (...args: unknown[]) => Promise<latex_pdf_candidates>;
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
  const global_memory = options.global_memory ?? new Map<string, unknown>();
  const settings = new Map(Object.entries(options.settings ?? {}));
  const errors: string[] = [];
  const input_boxes: vscode.InputBoxOptions[] = [];
  const warnings: string[] = [];
  const links: string[] = [];
  const opened_files: string[] = [];
  const editable_copies: Array<{ content: string; language: string }> = [];
  const saved_files: Array<{ path: string; text: string; bytes: Buffer }> = [];
  const copied_files: Array<{ source: string; target: string; overwrite?: boolean }> = [];
  const save_dialogs: vscode.SaveDialogOptions[] = [];
  const open_dialogs: vscode.OpenDialogOptions[] = [];
  const shown_documents: Array<{ document: { uri?: fake_uri }; options: vscode.TextDocumentShowOptions | undefined }> = [];
  const watchers: fake_watcher[] = [];
  const sync_calls: unknown[][] = [];
  const file_operations = new Set<Promise<unknown>>();
  const flush_file_io = async () => {
    while (file_operations.size) {
      await Promise.allSettled([...file_operations]);
      await next_turn();
    }
  };
  const api = {
    ConfigurationTarget: { Global: 1 },
    Uri: fake_uri,
    ViewColumn: { One: 1 },
    FileType: { File: 1, Directory: 2 },
    RelativePattern: class { constructor(readonly baseUri: fake_uri, readonly pattern: string) {} },
    env: { openExternal: async (uri: { toString(): string }) => { links.push(uri.toString()); return true; } },
    Range: class { constructor(readonly startLine: number, readonly startCharacter: number, readonly endLine: number, readonly endCharacter: number) {} },
    workspace: {
      isTrusted: options.trusted ?? true,
      workspaceFolders: options.workspace_uri ? [{ uri: options.workspace_uri }] : [],
      fs: {
        writeFile: async (uri: { fsPath: string }, data: Uint8Array) => { saved_files.push({ path: uri.fsPath, text: Buffer.from(data).toString('utf8'), bytes: Buffer.from(data) }); },
        copy: async (source: fake_uri, target: fake_uri, copy_options?: { overwrite?: boolean }) => {
          copied_files.push({ source: source.toString(), target: target.toString(), overwrite: copy_options?.overwrite });
        },
        stat: async (uri: { fsPath: string }) => { const item = await stat(uri.fsPath); return { type: item.isFile() ? 1 : 2, ctime: item.ctimeMs, mtime: item.mtimeMs, size: item.size }; },
      },
      getWorkspaceFolder: () => options.workspace_uri ? { uri: options.workspace_uri } : undefined,
      createFileSystemWatcher: (pattern: { baseUri: fake_uri; pattern: string }) => {
        const watcher = new fake_watcher(pattern);
        watchers.push(watcher);
        return watcher;
      },
      openTextDocument: async (uri: { fsPath: string } | { content: string; language: string }) => {
        if ('content' in uri) editable_copies.push(structuredClone(uri));
        else opened_files.push(uri.fsPath);
        return { uri: 'fsPath' in uri ? uri : undefined, lineCount: 10, lineAt: () => ({ text: 'example source line' }) };
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
      activeTextEditor: undefined as { document: { uri: fake_uri } } | undefined,
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
      showTextDocument: async (document: { uri?: fake_uri }, show_options?: vscode.TextDocumentShowOptions) => {
        shown_documents.push({ document, options: show_options });
        return { document };
      },
      showOpenDialog: async (open_options: vscode.OpenDialogOptions) => {
        open_dialogs.push(open_options);
        return options.open_destination ? [fake_uri.file(options.open_destination)] : undefined;
      },
      showSaveDialog: async (save_options: vscode.SaveDialogOptions) => {
        save_dialogs.push({ ...save_options, filters: structuredClone(save_options.filters) });
        return options.save_destination ? fake_uri.file(options.save_destination) : undefined;
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
    extensionUri: fake_uri.parse('vscode-extension://terminal-sidebar/extension'),
    globalStorageUri: fake_uri.file(options.global_storage_directory ?? global_directory(global_memory)),
    workspaceState: {
      get: (key: string) => structuredClone(memory.get(key)),
      update: async (key: string, value: unknown) => { memory.set(key, structuredClone(value)); },
    },
    globalState: {
      get: (key: string) => structuredClone(global_memory.get(key)),
      update: async (key: string, value: unknown) => { global_memory.set(key, structuredClone(value)); },
      keys: () => [...global_memory.keys()],
    },
  };
  const host_module = { exports: {} as { activate(context: vscode.ExtensionContext): void } };
  run_in_new_context(await bundled_host, {
    module: host_module,
    exports: host_module.exports,
    Buffer,
    URL,
    TextEncoder,
    TextDecoder,
    test_reverse_sync: async (...args: unknown[]) => {
      sync_calls.push(args);
      if (!options.reverse_sync) throw new Error('No SyncTeX fixture configured.');
      return options.reverse_sync(...args);
    },
    test_latex_pdf: async (...args: unknown[]) => options.latex_pdf
      ? options.latex_pdf(...args) : { root_uri: String(args[0]), pdf_uris: [] },
    process,
    setTimeout,
    clearTimeout,
    require: (id: string) => {
      if (id === 'vscode') return api;
      if (id === 'node:fs/promises') {
        return new Proxy(require_builtin(id), {
          get(target, property) {
            const member = target[property];
            if (typeof member !== 'function') return member;
            return (...args: unknown[]) => {
              const result = member(...args);
              if (result && typeof result.then === 'function') {
                file_operations.add(result);
                void result.finally(() => file_operations.delete(result)).catch(() => {});
              }
              return result;
            };
          },
        });
      }
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
    warnings, links, opened_files, editable_copies, saved_files, copied_files, save_dialogs, global_memory,
    global_storage_directory: context.globalStorageUri.fsPath,
    open_dialogs, shown_documents, watchers, sync_calls,
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
      const view = new fake_view(flush_file_io, options.ready_on_html);
      await provider.resolveWebviewView(view as unknown as vscode.WebviewView, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
      if (options.ready_on_html) { await next_turn(); await flush_file_io(); }
      else await view.send({ type: 'ready', renderer_id: view.renderer_id });
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

test('ready sent synchronously while HTML is assigned is received on initial and recreated webviews', async test_case => {
  const runtime = await harness({ ready_on_html: true });
  test_case.after(() => runtime.dispose());
  const first = await runtime.view('right');
  assert.equal(first.state().tabs.length, 2, 'the first ready handshake starts the view without a retry');
  assert.equal(runtime.processes.length, 2);
  first.dispose();
  const reopened = await runtime.view('right');
  assert.equal(reopened.state().tabs.length, 2, 'a recreated view also receives its synchronous ready');
  assert.equal(runtime.processes.length, 2, 'view recreation retains the running terminals');
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
  const temporary_tab = terminal(right.state().tabs.at(-1));
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
  assert.equal(terminal(restored.state().tabs.find(tab => tab.id === target.id)).cwd, directory);
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

test('close all removes idle terminals and previews without confirmation and leaves the other side unchanged', async test_case => {
  const files = preview_fixture(test_case);
  const runtime = await harness({ memory: files.memory });
  test_case.after(() => runtime.dispose());
  const left = await runtime.view('left');
  const left_before = left.state();
  const left_processes = [...runtime.processes];
  const right = await runtime.view('right');
  const right_processes = runtime.processes.slice(left_processes.length);
  for (const process of right_processes) process.data.fire('\x1b]133;A\x07');
  await right.send({ type: 'load_pdf', id: 'pdf' });
  await right.send({ type: 'load_markdown', id: 'markdown' });
  assert.ok(runtime.watchers.length > 0);
  await right.send({ type: 'close_all_tabs' });
  assert.deepEqual(right.state().tabs, []);
  assert.deepEqual(runtime.warnings, []);
  assert.ok(right_processes.every(process => process.killed === 1));
  assert.ok(left_processes.every(process => process.killed === 0));
  assert.ok(runtime.watchers.every(watcher => watcher.disposed));
  assert.deepEqual(left.state(), left_before);
  assert.deepEqual(runtime.configuration(), initial_configuration);
  assert.deepEqual(runtime.updates, []);
  await right.send({ type: 'close_all_tabs' });
  assert.deepEqual(runtime.warnings, [], 'closing an empty side is a no-op');
  const restored = await harness({ memory: runtime.memory });
  test_case.after(() => restored.dispose());
  const reopened = (await restored.view('right')).state().tabs;
  assert.deepEqual(reopened.map(tab => tab.name), initial_configuration.right.map(profile => profile.name),
    'closing runtime tabs preserves startup profiles but does not reopen the closed previews');
});

test('close all confirms once, cancels atomically and never closes tabs opened during its pending confirmation', async test_case => {
  let finish_warning!: (choice: string | undefined) => void;
  const runtime = await harness({ warning: () => new Promise(resolve => { finish_warning = resolve; }) });
  test_case.after(() => runtime.dispose());
  const right = await runtime.view('right');
  const original_tabs = right.state().tabs;
  const original_processes = [...runtime.processes];
  const left = await runtime.view('left');
  const left_before = left.state();
  const left_processes = runtime.processes.slice(original_processes.length);
  await right.send({ type: 'close_all_tabs' });
  await right.send({ type: 'close_all_tabs' });
  await right.send({ type: 'close_tab', id: original_tabs[0].id });
  await right.send({ type: 'restart', id: original_tabs[1].id, cols: 80, rows: 24 });
  assert.equal(runtime.warnings.length, 1, 'duplicate and individual actions share the pending guard');
  finish_warning(undefined);
  await next_turn();
  assert.deepEqual(right.state().tabs, original_tabs);
  assert.ok(original_processes.every(process => process.killed === 0));
  await right.send({ type: 'close_all_tabs' });
  await right.send({ type: 'add_tab' });
  const fresh = right.state().tabs.at(-1)!;
  const fresh_process = runtime.processes.at(-1)!;
  await right.send({ type: 'close_all_tabs' });
  assert.equal(runtime.warnings.length, 2, 'one confirmation for every group, even with multiple busy terminals');
  finish_warning('Close all tabs');
  await next_turn();
  assert.deepEqual(right.state().tabs.map(tab => ({ id: tab.id, name: tab.name })), [{ id: fresh.id, name: fresh.name }]);
  assert.ok(original_processes.every(process => process.killed === 1));
  assert.equal(fresh_process.killed, 0);
  assert.ok(left_processes.every(process => process.killed === 0));
  assert.deepEqual(left.state(), left_before);
  assert.deepEqual(runtime.updates, []);
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

test('Codicon markers are local, independent by side, validated, and removable without restarting processes', async test_case => {
  const runtime = await harness();
  test_case.after(() => runtime.dispose());
  const left = await runtime.view('left');
  const right = await runtime.view('right');
  const id = left.state().tabs[0].id;
  const right_before = right.state();
  const original_processes = [...runtime.processes];
  const left_marker = { icon: 'bookmark', color: 'tab_active_foreground' } as const;
  const right_marker = { icon: 'ask', color: 'tab_inactive_foreground' } as const;
  await left.send({ type: 'set_tab_marker', id, marker: left_marker });
  assert.deepEqual(left.state().tabs[0].marker, left_marker);
  assert.deepEqual(right.state(), right_before);
  assert.deepEqual(runtime.updates, []);
  const marker_memory = structuredClone(runtime.memory);
  await left.send({ type: 'set_tab_marker', id, marker: { icon: 'bookmark', color: 'url(invalid)' } } as unknown as client_message);
  await left.send({ type: 'set_tab_marker', id, marker: { icon: 'bookmark invalid_class', color: 'ansiGreen' } });
  await left.send({ type: 'set_tab_marker', id, marker: { shape: 'circle', color: 'ansiGreen' } } as unknown as client_message);
  await left.send({ type: 'set_tab_color', id, color: 'ansiGreen' } as unknown as client_message);
  await left.send({ type: 'set_tab_marker', id: 'missing', marker: right_marker });
  assert.deepEqual(left.state().tabs[0].marker, left_marker);
  assert.deepEqual(runtime.memory, marker_memory);
  await right.send({ type: 'set_tab_marker', id: right.state().tabs[0].id, marker: right_marker });
  const next_window = await harness({ memory: runtime.memory });
  test_case.after(() => next_window.dispose());
  assert.deepEqual((await next_window.view('left')).state().tabs[0].marker, left_marker);
  assert.deepEqual((await next_window.view('right')).state().tabs[0].marker, right_marker);
  await left.send({ type: 'set_tab_marker', id });
  assert.equal(left.state().tabs[0].marker, undefined);
  assert.deepEqual(right.state().tabs[0].marker, right_marker);
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
  const target = terminal(right.state().tabs[0]);
  await right.send({ type: 'request_rename', id: target.id });
  await right.send({ type: 'request_rename', id: target.id });
  await left.send({ type: 'request_rename', id: left.state().tabs[0].id });
  assert.equal(runtime.input_boxes.length, 1, 'both views share one native rename prompt');
  await right.send({ type: 'close_tab', id: target.id });
  await runtime.command('terminalSidebar.openProfile', target.profile_id);
  const replacement = right.state().tabs.filter(is_terminal_tab).find(tab => tab.profile_id === target.profile_id)!;
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

test('ready retries resend state without replaying terminal output or starting duplicate processes', async test_case => {
  const runtime = await harness();
  test_case.after(() => runtime.dispose());
  const view = await runtime.view('right');
  await view.send({ type: 'ready', renderer_id: 'renderer_one' });
  runtime.processes[0].data.fire('FIRST_OUTPUT');
  await delay(20);
  const state_count = view.messages.filter(message => message.type === 'state').length;
  await view.send({ type: 'ready', renderer_id: 'renderer_one' });
  await view.send({ type: 'ready', renderer_id: 'renderer_one' });
  assert.equal(view.messages.filter(message => message.type === 'state').length, state_count + 2);
  assert.deepEqual(view.output().map(message => message.data), ['FIRST_OUTPUT']);
  assert.equal(runtime.processes.length, 2);

  runtime.processes[0].data.fire('PENDING_OUTPUT');
  await view.send({ type: 'ready', renderer_id: 'renderer_two' });
  await delay(20);
  assert.deepEqual(view.output().map(message => message.data), ['FIRST_OUTPUT', 'FIRST_OUTPUTPENDING_OUTPUT'],
    'a newly created renderer receives pending output only through its one history replay');
  await view.send({ type: 'ready', renderer_id: 'renderer_two' });
  assert.equal(view.output().length, 2);
  assert.equal(runtime.processes.length, 2);
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
  assert.equal(terminal(right.state().tabs.find(tab => tab.id === right.state().active_id)).profile_id, 'two');
  assert.equal(terminal(left.state().tabs.find(tab => tab.id === left.state().active_id)).profile_id, 'one');
  const closed_identifier = left.state().tabs[0].id;
  await left.send({ type: 'close_tab', id: closed_identifier });
  await runtime.command('terminalSidebar.openProfile', { id: 'one', side: 'left' });
  assert.equal(terminal(left.state().tabs.find(tab => tab.id === left.state().active_id)).profile_id, 'one');
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
    markdown_font_family: '',
    markdown_font_choice: 'default',
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

test('startup marker choices cross workspace boundaries and removals override stale workspace copies', async test_case => {
  const original = await harness();
  test_case.after(() => original.dispose());
  const first = await original.view('left');
  const marker = { icon: 'bookmark', color: 'ansiBlue' } as const;
  await first.send({ type: 'set_tab_marker', id: first.state().tabs[0].id, marker });
  const old_workspace = structuredClone(original.memory);
  const second_repo = await harness({ global_memory: original.global_memory });
  test_case.after(() => second_repo.dispose());
  const shared = await second_repo.view('left');
  assert.deepEqual(shared.state().tabs[0].marker, marker);
  assert.equal((await second_repo.view('right')).state().tabs[0].marker, undefined, 'same profile ID on another side stays independent');
  assert.deepEqual(second_repo.updates, []);
  await shared.send({ type: 'set_tab_marker', id: shared.state().tabs[0].id });
  const reopened = await harness({ memory: old_workspace, global_memory: second_repo.global_memory });
  test_case.after(() => reopened.dispose());
  assert.equal((await reopened.view('left')).state().tabs[0].marker, undefined, 'explicit removal cannot be overwritten by old workspace data');
  assert.doesNotMatch(JSON.stringify([...second_repo.global_memory.values()]), /LEFT_START|RIGHT_START|command|cwd/);
});

test('existing workspace markers migrate once while temporary markers remain local', async test_case => {
  const configuration = { left: [{ id: 'profile', name: 'Shell', command: '', shell: '' }], right: [] };
  const memory = new Map<string, unknown>([['terminalSidebar.tabs.left', {
    version: 1, tabs: [
      { id: 'startup', profile_id: 'profile', name: 'Shell', marker: { icon: 'flag', color: 'ansiGreen' } },
      { id: 'temporary', name: 'Term 0', marker: { icon: 'tag', color: 'ansiRed' } },
    ], active_id: 'startup', expanded_ids: ['startup'], next_number: 1,
  }]]);
  const original = await harness({ configuration, memory });
  test_case.after(() => original.dispose());
  const view = await original.view('left');
  assert.deepEqual(view.state().tabs[1].marker, { icon: 'tag', color: 'ansiRed' });
  const next_repo = await harness({ configuration, global_memory: original.global_memory });
  test_case.after(() => next_repo.dispose());
  const next = await next_repo.view('left');
  assert.deepEqual(next.state().tabs[0].marker, { icon: 'flag', color: 'ansiGreen' });
  await next.send({ type: 'add_tab' });
  assert.equal(next.state().tabs[1].marker, undefined);
});

test('already-open repository windows update separate profile keys without losing or reviving other markers', async test_case => {
  const global_memory = new Map<string, unknown>();
  const first = await harness({ global_memory });
  const second = await harness({ global_memory });
  test_case.after(() => first.dispose());
  test_case.after(() => second.dispose());
  const first_view = await first.view('left');
  const second_view = await second.view('left');
  await first_view.send({ type: 'set_tab_marker', id: first_view.state().tabs[0].id, marker: { icon: 'bookmark', color: 'ansiBlue' } });
  await second_view.send({ type: 'set_tab_marker', id: second_view.state().tabs[1].id, marker: { icon: 'flag', color: 'ansiGreen' } });
  const third = await harness({ global_memory });
  test_case.after(() => third.dispose());
  assert.deepEqual((await third.view('left')).state().tabs.map(tab => tab.marker), [
    { icon: 'bookmark', color: 'ansiBlue' }, { icon: 'flag', color: 'ansiGreen' },
  ]);
  await first_view.send({ type: 'set_tab_marker', id: first_view.state().tabs[0].id });
  await second_view.send({ type: 'set_tab_marker', id: second_view.state().tabs[1].id, marker: { icon: 'ask', color: 'ansiRed' } });
  const next = await harness({ global_memory });
  test_case.after(() => next.dispose());
  assert.deepEqual((await next.view('left')).state().tabs.map(tab => tab.marker), [undefined, { icon: 'ask', color: 'ansiRed' }]);
  assert.equal(global_memory.size, 0, 'new writes do not use whole-extension Memento snapshots');
  assert.equal(readdirSync(path.join(first.global_storage_directory, 'profile_markers')).length, 2);
});

test('marker storage failures preserve the current tab and report a handled error', async test_case => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'terminal_sidebar_blocked_storage_'));
  test_case.after(() => rmSync(directory, { recursive: true, force: true }));
  const blocked = path.join(directory, 'not_a_directory');
  writeFileSync(blocked, 'storage fixture');
  const runtime = await harness({ global_storage_directory: blocked });
  test_case.after(() => runtime.dispose());
  const view = await runtime.view('left');
  const previous = view.state().tabs;
  const processes = [...runtime.processes];
  await view.send({ type: 'set_tab_marker', id: previous[0].id, marker: { icon: 'flag', color: 'ansiGreen' } });
  assert.deepEqual(view.state().tabs, previous);
  assert.deepEqual(runtime.processes, processes);
  assert.ok(view.messages.some(message => message.type === 'error' && message.message.includes('could not be saved')));
});

function preview_fixture(test_case: { after(callback: () => void): void }) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'terminal_sidebar_host_preview_~'));
  test_case.after(() => rmSync(directory, { recursive: true, force: true }));
  const pdf = path.join(directory, 'thesis.pdf');
  const markdown = path.join(directory, 'notes.md');
  const tex = path.join(directory, 'thesis.tex');
  writeFileSync(pdf, '%PDF-1.4\n%%EOF');
  writeFileSync(markdown, '# Notes\n\nUpdated with Vim.\n');
  writeFileSync(tex, '\\documentclass{article}\n');
  const memory = new Map<string, unknown>([['terminalSidebar.tabs.right', {
    version: 1, tabs: [
      { id: 'pdf', name: 'Thesis', pdf: { uri: fake_uri.file(pdf).toString(), page: 2, zoom: 1.5 } },
      { id: 'markdown', name: 'Notes', markdown: { uri: fake_uri.file(markdown).toString(), scroll: 40 } },
    ], active_id: 'pdf', expanded_ids: ['pdf', 'markdown'], next_number: 0,
  }]]);
  return { directory, pdf, markdown, tex, memory };
}

test('saving every preview kind copies the source URI and proposes its filename instead of its renamed tab', async test_case => {
  const files = preview_fixture(test_case);
  const destination = path.join(files.directory, 'chosen copy #1.pdf');
  const runtime = await harness({ configuration: { left: [], right: [] }, save_destination: destination });
  test_case.after(() => runtime.dispose());
  const view = await runtime.view('right');
  const sources = [files.pdf, files.markdown, ...['html', 'css', 'json', 'jsonc'].map(extension => {
    const filename = path.join(files.directory, `source name #1.${extension}`);
    writeFileSync(filename, 'source content');
    return filename;
  })];
  for (const filename of sources) {
    await runtime.command('terminalSidebar.openPreview', fake_uri.file(filename));
    const tab = view.state().tabs.at(-1)!;
    await view.send({ type: 'rename_tab', id: tab.id, name: 'Different display name' });
    await view.send({ type: 'save_document', id: tab.id });
    const copy = runtime.copied_files.at(-1)!;
    assert.deepEqual(copy, {
      source: fake_uri.file(filename).toString(), target: fake_uri.file(destination).toString(), overwrite: true,
    });
    const extension = path.extname(filename);
    const suggested = path.join(files.directory, `${path.basename(filename, extension)}_copy${extension}`);
    assert.equal(runtime.save_dialogs.at(-1)?.defaultUri?.fsPath, suggested);
    assert.equal(view.state().tabs.at(-1)?.name, 'Different display name');
  }
  assert.equal(runtime.copied_files.length, sources.length);
  assert.deepEqual(runtime.saved_files, [], 'binary and source files use the filesystem copy API without text conversion');
  assert.equal(runtime.processes.length, 0);
  assert.ok(!view.messages.some(message => message.type === 'error'));
});

test('saving a preview respects cancellation, rejects its source as destination and ignores terminal or missing IDs', async test_case => {
  const files = preview_fixture(test_case);
  const cancelled = await harness({ memory: files.memory });
  const same_source = await harness({ memory: files.memory, save_destination: files.pdf });
  test_case.after(() => { cancelled.dispose(); same_source.dispose(); });
  const cancelled_view = await cancelled.view('right');
  const before = cancelled_view.state().tabs;
  await cancelled_view.send({ type: 'save_document', id: 'pdf' });
  assert.equal(cancelled.save_dialogs.length, 1);
  assert.deepEqual(cancelled.copied_files, []);
  assert.deepEqual(cancelled_view.state().tabs, before);
  const terminal_id = cancelled_view.state().tabs.find(is_terminal_tab)!.id;
  await cancelled_view.send({ type: 'save_document', id: terminal_id });
  await cancelled_view.send({ type: 'save_document', id: 'missing' });
  assert.equal(cancelled.save_dialogs.length, 1, 'only a live preview can open Save copy');
  const same_view = await same_source.view('right');
  await same_view.send({ type: 'save_document', id: 'pdf' });
  assert.deepEqual(same_source.copied_files, []);
  assert.ok(same_view.messages.some(message => message.type === 'error' && /different filename/.test(message.message)));
});

test('pending preview saves deduplicate requests and recheck workspace trust before copying', async test_case => {
  const files = preview_fixture(test_case);
  const runtime = await harness({ memory: files.memory });
  test_case.after(() => runtime.dispose());
  const view = await runtime.view('right');
  let finish_save!: (uri: fake_uri | undefined) => void;
  let dialogs = 0;
  runtime.api.window.showSaveDialog = async () => {
    dialogs++;
    return new Promise(resolve => { finish_save = resolve; });
  };
  await view.send({ type: 'save_document', id: 'pdf' });
  await view.send({ type: 'save_document', id: 'pdf' });
  assert.equal(dialogs, 1);
  runtime.api.workspace.isTrusted = false;
  finish_save(fake_uri.file(path.join(files.directory, 'copy.pdf')));
  await next_turn();
  assert.deepEqual(runtime.copied_files, []);
  await view.send({ type: 'save_document', id: 'pdf' });
  assert.equal(dialogs, 1, 'untrusted workspaces do not open the save dialog');
  runtime.api.workspace.isTrusted = true;
  await view.send({ type: 'save_document', id: 'pdf' });
  assert.equal(dialogs, 2, 'cancellation releases the pending action guard');
  finish_save(undefined);
  await next_turn();
});

async function wait_for(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 3500;
  while (!predicate() && Date.now() < deadline) await delay(20);
  assert.ok(predicate(), description);
}

test('mixed document tabs restore without PTYs and keep reading positions and preview resources separate', async test_case => {
  const files = preview_fixture(test_case);
  const runtime = await harness({ memory: files.memory });
  test_case.after(() => runtime.dispose());
  const right = await runtime.view('right');
  assert.equal(right.state().tabs.filter(is_pdf_tab).length, 1);
  assert.equal(right.state().tabs.filter(is_markdown_tab).length, 1);
  assert.equal(runtime.processes.length, 2, 'only the two startup terminal profiles spawn shells');
  assert.deepEqual(Array.from(right.webview.options.localResourceRoots ?? [], value => value.scheme === 'file' ? value.fsPath : value.toString()), [
    files.directory, 'vscode-extension://terminal-sidebar/extension/dist',
  ]);
  assert.equal(right.options_updates, 1, 'all restored roots are present before HTML and never reload its first renderer');
  await right.send({ type: 'ready', renderer_id: right.renderer_id });
  assert.equal(right.options_updates, 1, 'equivalent roots do not recreate the iframe');
  await right.send({ type: 'pdf_position', id: 'pdf', position: { page: 8, zoom: 'page-fit' } });
  await right.send({ type: 'markdown_position', id: 'markdown', position: { scroll: 240 } });
  const next_window = await harness({ memory: runtime.memory });
  test_case.after(() => next_window.dispose());
  const next = await next_window.view('right');
  assert.equal(next.state().tabs.filter(is_pdf_tab)[0].page, 8);
  assert.equal(next.state().tabs.filter(is_pdf_tab)[0].zoom, 'page-fit');
  assert.equal(next.state().tabs.filter(is_markdown_tab)[0].scroll, 240);
  for (const id of ['pdf', 'markdown']) {
    await right.send({ type: 'activate', id, cols: 80, rows: 24 });
    await right.send({ type: 'input', id, data: 'must not reach a PTY' });
    await right.send({ type: 'restart', id, cols: 80, rows: 24 });
  }
  assert.equal(runtime.processes.length, 2);
  assert.ok(runtime.processes.every(process => !process.writes.includes('must not reach a PTY')));
});

test('dynamic preview roots retire the old renderer and wait for the replacement handshake', async test_case => {
  const files = preview_fixture(test_case);
  const runtime = await harness();
  test_case.after(() => runtime.dispose());
  const view = await runtime.view('right');
  const original_renderer = view.renderer_id;
  view.reload_on_options = false;
  runtime.processes[0].data.fire('ORIGINAL');
  await delay(20);
  const states_before_open = view.messages.filter(message => message.type === 'state').length;
  await runtime.command('terminalSidebar.openPdf', fake_uri.file(files.pdf));
  assert.equal(view.options_updates, 2);
  assert.equal(view.messages.filter(message => message.type === 'state').length, states_before_open,
    'state is withheld while resource options replace the iframe');
  runtime.processes[0].data.fire('DURING_RELOAD');
  await view.send({ type: 'ready', renderer_id: original_renderer });
  assert.equal(view.messages.filter(message => message.type === 'state').length, states_before_open,
    'a late retry from the retired renderer cannot reclaim the view');
  await view.send({ type: 'ready', renderer_id: view.renderer_id });
  assert.equal(view.state().tabs.filter(is_pdf_tab).length, 1);
  assert.deepEqual(view.output().map(message => message.data), ['ORIGINAL', 'ORIGINALDURING_RELOAD']);
  const new_state_count = view.messages.filter(message => message.type === 'state').length;
  await view.send({ type: 'ready', renderer_id: original_renderer });
  assert.equal(view.messages.filter(message => message.type === 'state').length, new_state_count);
  assert.equal(view.output().length, 2);
  assert.equal(runtime.processes.length, 2);

  await runtime.command('terminalSidebar.openMarkdown', fake_uri.file(files.markdown));
  assert.equal(view.options_updates, 2, 'another document in the same directory needs no iframe replacement');
  await view.send({ type: 'close_tab', id: view.state().tabs.find(is_pdf_tab)!.id });
  assert.equal(view.options_updates, 2, 'the remaining document retains the shared directory grant');
  const previous_renderer = view.renderer_id;
  await view.send({ type: 'close_tab', id: view.state().tabs.find(is_markdown_tab)!.id });
  assert.equal(view.options_updates, 3, 'the last document revokes its directory grant');
  await view.send({ type: 'ready', renderer_id: previous_renderer });
  await view.send({ type: 'ready', renderer_id: view.renderer_id });
  assert.ok(view.state().tabs.every(is_terminal_tab));
  assert.equal(view.webview.options.localResourceRoots?.length, 1);
  assert.equal(runtime.processes.length, 2);
});

test('PDF and Markdown watchers refresh complete files and close without affecting terminal processes', async test_case => {
  const files = preview_fixture(test_case);
  const runtime = await harness({ memory: files.memory });
  test_case.after(() => runtime.dispose());
  const view = await runtime.view('right');
  await view.send({ type: 'load_pdf', id: 'pdf' });
  await view.send({ type: 'load_markdown', id: 'markdown' });
  assert.equal(runtime.watchers.length, 2);
  await wait_for(() => view.messages.some(message => message.type === 'pdf_source')
    && view.messages.some(message => message.type === 'markdown_source'), 'both previews receive file contents');
  const source = view.messages.find(message => message.type === 'markdown_source');
  assert.ok(source?.type === 'markdown_source');
  assert.equal(source.source.text, '# Notes\n\nUpdated with Vim.\n');
  assert.equal(path.resolve(fileURLToPath(source.source.base_url)), files.directory);
  assert.ok(source.source.base_url.endsWith('/'), 'relative resources resolve inside the source directory');
  writeFileSync(files.markdown, '# Saved again\n');
  runtime.watchers[1].created.fire(fake_uri.file(files.markdown));
  await wait_for(() => view.messages.some(message => message.type === 'markdown_source' && message.source.text === '# Saved again\n'), 'replace-on-save refreshes Markdown');
  const old_processes = [...runtime.processes];
  await view.send({ type: 'close_tab', id: 'pdf' });
  await view.send({ type: 'close_tab', id: 'markdown' });
  assert.ok(runtime.watchers.every(watcher => watcher.disposed));
  assert.deepEqual(runtime.processes, old_processes);
  assert.ok(runtime.processes.every(process => process.killed === 0));
  assert.deepEqual(runtime.warnings, []);
  assert.equal(view.webview.options.localResourceRoots?.length, 1, 'closed files lose their resource grants');
});

test('preview requests require the matching live document tab and workspace trust', async test_case => {
  const files = preview_fixture(test_case);
  const runtime = await harness({ memory: files.memory, trusted: false, open_destination: files.pdf });
  test_case.after(() => runtime.dispose());
  const view = await runtime.view('right');
  await runtime.command('terminalSidebar.openPdf', fake_uri.file(files.pdf));
  await runtime.command('terminalSidebar.openMarkdown', fake_uri.file(files.markdown));
  for (const id of ['pdf', 'markdown', 'missing']) {
    await view.send({ type: 'load_pdf', id });
    await view.send({ type: 'load_markdown', id });
    await view.send({ type: 'pdf_reverse_sync', id, page: 1, x: 10, y: 20 });
  }
  assert.equal(runtime.watchers.length, 0);
  assert.equal(runtime.sync_calls.length, 0);
  assert.equal(runtime.open_dialogs.length, 0);
  assert.equal(runtime.processes.length, 0);
  assert.ok(!view.messages.some(message => message.type === 'pdf_source' || message.type === 'markdown_source'));
  await runtime.grant_trust();
  for (const request of [
    { type: 'load_pdf', id: 'markdown' }, { type: 'load_markdown', id: 'pdf' },
    { type: 'load_pdf', id: 'missing' }, { type: 'pdf_reverse_sync', id: 'pdf', page: 0, x: 10, y: 20 },
  ]) await view.send(request as client_message);
  assert.equal(runtime.watchers.length, 0);
  assert.equal(runtime.sync_calls.length, 0);
});

test('open commands accept URI instances and PDF source navigation opens the main editor at the returned position', async test_case => {
  const files = preview_fixture(test_case);
  const runtime = await harness({ configuration: { left: [], right: [] },
    reverse_sync: async () => ({ uri: fake_uri.file(files.tex).toString(), line: 4, column: 6 }) });
  test_case.after(() => runtime.dispose());
  const view = await runtime.view('right');
  await runtime.command('terminalSidebar.openPdf', fake_uri.file(files.pdf));
  await runtime.command('terminalSidebar.openMarkdown', fake_uri.file(files.markdown));
  assert.equal(runtime.open_dialogs.length, 0, 'an explicit file bypasses the picker');
  const pdf = view.state().tabs.find(is_pdf_tab)!;
  await view.send({ type: 'pdf_reverse_sync', id: pdf.id, page: 2, x: 12.5, y: 50 });
  assert.equal(runtime.sync_calls.length, 1);
  assert.deepEqual(runtime.sync_calls[0].slice(0, 4), [fake_uri.file(files.pdf).toString(), 2, 12.5, 50]);
  assert.deepEqual(runtime.opened_files, [files.tex]);
  assert.equal(runtime.shown_documents[0].options?.viewColumn, 1);
  assert.deepEqual(runtime.shown_documents[0].options?.selection, new runtime.api.Range(3, 5, 3, 5));
  assert.equal(runtime.processes.length, 0);
});

test('PDF file links open documents beside the PDF only from a trusted, matching PDF tab', async test_case => {
  const files = preview_fixture(test_case);
  const appendix = path.join(files.directory, 'appendix.pdf');
  writeFileSync(appendix, '%PDF-1.4\n%%EOF');
  const runtime = await harness({ memory: files.memory, trusted: false });
  test_case.after(() => runtime.dispose());
  const view = await runtime.view('right');
  const pdf_tabs = () => view.state().tabs.filter(is_pdf_tab).map(tab => tab.uri);
  const before = pdf_tabs();
  await view.send({ type: 'open_pdf_link', id: 'pdf', href: 'appendix.pdf' });
  assert.deepEqual(pdf_tabs(), before, 'untrusted workspaces ignore PDF file links');
  await runtime.grant_trust();
  await view.send({ type: 'open_pdf_link', id: 'markdown', href: 'appendix.pdf' });
  assert.deepEqual(pdf_tabs(), before, 'the link must come from a PDF tab');
  await view.send({ type: 'open_pdf_link', id: 'pdf', href: 'appendix.pdf#results' });
  assert.deepEqual(pdf_tabs(), [...before, fake_uri.file(appendix).toString()]);
  assert.deepEqual(runtime.links, [], 'no external browser is involved');
});

test('the Markdown source button opens its source in the main editor instead of reselecting the preview', async test_case => {
  const files = preview_fixture(test_case);
  const runtime = await harness({ memory: files.memory });
  test_case.after(() => runtime.dispose());
  const view = await runtime.view('right');
  const before = view.state().tabs;
  await view.send({ type: 'open_markdown_link', id: 'markdown', href: fake_uri.file(files.markdown).toString() });
  assert.deepEqual(runtime.opened_files, [files.markdown]);
  assert.equal(runtime.shown_documents[0].options?.viewColumn, 1);
  assert.deepEqual(view.state().tabs, before);
});

test('LaTeX preview preserves its root association across direct PDF reopening and window restore', async test_case => {
  const files = preview_fixture(test_case);
  const output_directory = path.join(files.directory, 'build', 'pdf');
  mkdirSync(output_directory, { recursive: true });
  const pdf = path.join(output_directory, 'thesis.pdf');
  writeFileSync(pdf, '%PDF-1.4\n%%EOF');
  const root_uri = fake_uri.file(files.tex).toString();
  const pdf_uri = fake_uri.file(pdf).toString();
  const runtime = await harness({ configuration: { left: [], right: [] },
    latex_pdf: async () => ({ root_uri, pdf_uris: [pdf_uri] }) });
  test_case.after(() => runtime.dispose());
  const view = await runtime.view('right');
  await runtime.command('terminalSidebar.openLatex', fake_uri.file(files.tex));
  const tab = view.state().tabs.find(is_pdf_tab)!;
  assert.equal(tab.uri, pdf_uri);
  assert.equal(tab.source_uri, root_uri);
  await runtime.command('terminalSidebar.openPdf', fake_uri.file(pdf));
  assert.equal(view.state().tabs.find(is_pdf_tab)?.source_uri, root_uri);
  const restored = await harness({ configuration: { left: [], right: [] }, memory: runtime.memory,
    reverse_sync: async (...args) => {
      assert.deepEqual(structuredClone(args[4]), { synctex_path: 'synctex', root_uri });
      return { uri: root_uri, line: 2, column: 1 };
    } });
  test_case.after(() => restored.dispose());
  const next = await restored.view('right');
  assert.equal(next.state().tabs.find(is_pdf_tab)?.source_uri, root_uri);
  await next.send({ type: 'pdf_reverse_sync', id: tab.id, page: 1, x: 0, y: 0 });
  assert.deepEqual(restored.opened_files, [files.tex]);
  assert.equal(restored.shown_documents[0].options?.viewColumn, 1);
  assert.equal(restored.processes.length, 0);
});

test('pending reverse SyncTeX requests are deduplicated and cannot reopen a closed tab source', async test_case => {
  const files = preview_fixture(test_case);
  let complete!: (value: synctex_location) => void;
  const runtime = await harness({ memory: files.memory,
    reverse_sync: () => new Promise(resolve => { complete = resolve; }) });
  test_case.after(() => runtime.dispose());
  const view = await runtime.view('right');
  await view.send({ type: 'pdf_reverse_sync', id: 'pdf', page: 1, x: 20, y: 30 });
  await view.send({ type: 'pdf_reverse_sync', id: 'pdf', page: 1, x: 20, y: 30 });
  assert.equal(runtime.sync_calls.length, 1);
  await view.send({ type: 'close_tab', id: 'pdf' });
  complete({ uri: fake_uri.file(files.tex).toString(), line: 1, column: 1 });
  await next_turn();
  assert.deepEqual(runtime.opened_files, []);
  assert.deepEqual(runtime.shown_documents, []);
});

test('global find enumerates both sides, reads inactive documents and routes terminal snapshots by side', async test_case => {
  const files = preview_fixture(test_case);
  const runtime = await harness({ memory: files.memory });
  test_case.after(() => runtime.dispose());
  const left = await runtime.view('left');
  const right = await runtime.view('right');
  right.hide();
  await left.send({ type: 'search_catalog', request: 'catalog' });
  const catalog = left.messages.find(message => message.type === 'search_catalog');
  assert.ok(catalog?.type === 'search_catalog');
  assert.ok(catalog.tabs.some(tab => tab.side === 'right' && tab.kind === 'pdf'));
  assert.ok(catalog.tabs.some(tab => tab.side === 'right' && tab.kind === 'markdown'));
  assert.ok(catalog.tabs.some(tab => tab.side === 'left' && tab.kind === 'terminal'));
  await left.send({ type: 'search_read', request: 'markdown_request', side: 'right', id: 'markdown' });
  await wait_for(() => left.messages.some(message => message.type === 'search_source' && message.request === 'markdown_request'), 'Markdown snapshot arrives');
  const markdown = left.messages.find(message => message.type === 'search_source' && message.request === 'markdown_request');
  assert.ok(markdown?.type === 'search_source' && markdown.source?.kind === 'markdown');
  assert.match(markdown.source.text, /Updated with Vim/);
  await left.send({ type: 'search_read', request: 'pdf_request', side: 'right', id: 'pdf' });
  const pdf = left.messages.find(message => message.type === 'search_source' && message.request === 'pdf_request');
  assert.ok(pdf?.type === 'search_source' && pdf.source?.kind === 'pdf');
  assert.ok(left.webview.options.localResourceRoots?.some(uri => uri.fsPath === files.directory));
  const terminal = right.state().tabs.find(is_terminal_tab)!;
  await left.send({ type: 'search_read', request: 'terminal_request', side: 'right', id: terminal.id });
  const snapshot = right.messages.find(message => message.type === 'search_snapshot');
  assert.ok(snapshot?.type === 'search_snapshot');
  await left.send({ type: 'search_snapshot', request: snapshot.request, snapshot: { text: 'wrong side', rows: [] } });
  assert.ok(!left.messages.some(message => message.type === 'search_source' && message.request === 'terminal_request'));
  await right.send({ type: 'search_snapshot', request: snapshot.request, snapshot: { text: 'needle', rows: [{ row: 0, offset: 0 }] } });
  const result = left.messages.find(message => message.type === 'search_source' && message.request === 'terminal_request');
  assert.ok(result?.type === 'search_source' && result.source?.kind === 'terminal');
  assert.equal(result.source.snapshot.text, 'needle');
  await left.send({ type: 'search_read', request: 'missing', side: 'right', id: 'closed_tab' });
  const missing = left.messages.find(message => message.type === 'search_source' && message.request === 'missing');
  assert.ok(missing?.type === 'search_source' && missing.error);
});

test('document marker choices are applied when the same file is opened in another workspace', async test_case => {
  const files = preview_fixture(test_case);
  const global_memory = new Map<string, unknown>();
  const first = await harness({ memory: files.memory, global_memory });
  const second = await harness({ global_memory });
  test_case.after(() => { first.dispose(); second.dispose(); });
  const original = await first.view('right');
  const marker = { icon: 'bookmark', color: 'ansiBlue' } as const;
  await original.send({ type: 'set_tab_marker', id: 'pdf', marker });
  const other = await second.view('right');
  await second.command('terminalSidebar.openPdf', fake_uri.file(files.pdf));
  await other.send({ type: 'ready', renderer_id: other.renderer_id });
  assert.deepEqual(other.state().tabs.find(is_pdf_tab)?.marker, marker);
  await other.send({ type: 'set_tab_marker', id: other.state().tabs.find(is_pdf_tab)!.id });
  original.hide();
  original.show();
  assert.equal(original.state().tabs.find(is_pdf_tab)?.marker, undefined);
});

test('preview commands and document links route every supported Markdown filename to the same renderer', async test_case => {
  const files = preview_fixture(test_case);
  const runtime = await harness({ configuration: { left: [], right: [] } });
  test_case.after(() => runtime.dispose());
  const view = await runtime.view('right');
  await runtime.command('terminalSidebar.openMarkdown', fake_uri.file(files.markdown));
  const source = view.state().tabs.find(is_markdown_tab)!;
  for (const extension of ['md', 'markdown', 'mdown', 'mkd', 'mkdn', 'mdwn']) {
    const direct_uri = fake_uri.file(path.join(files.directory, `direct.${extension.toUpperCase()}`));
    await runtime.command('terminalSidebar.openPreview', direct_uri);
    assert.ok(view.state().tabs.some(tab => is_markdown_tab(tab) && tab.uri === direct_uri.toString()), extension);
    const linked_uri = fake_uri.file(path.join(files.directory, `linked.${extension}`));
    await view.send({ type: 'open_markdown_link', id: source.id, href: `linked.${extension}` });
    assert.ok(view.state().tabs.some(tab => is_markdown_tab(tab) && tab.uri === linked_uri.toString()), `linked ${extension}`);
    for (const uri of [direct_uri, linked_uri]) {
      const opened = view.state().tabs.find(tab => is_markdown_tab(tab) && tab.uri === uri.toString())!;
      await view.send({ type: 'close_tab', id: opened.id });
    }
  }
  assert.equal(runtime.open_dialogs.length, 0);
  assert.deepEqual(runtime.opened_files, [], 'previewable document links do not open a source editor');
  assert.equal(runtime.processes.length, 0, 'previewing documents never starts a shell');
});

test('editor preview uses the active Markdown alias and file pickers offer every supported alias', async test_case => {
  const files = preview_fixture(test_case);
  const runtime = await harness({ configuration: { left: [], right: [] } });
  test_case.after(() => runtime.dispose());
  const view = await runtime.view('right');
  const document = fake_uri.file(path.join(files.directory, 'active.mdown'));
  runtime.api.window.activeTextEditor = { document: { uri: document } };
  await runtime.command('terminalSidebar.openPreview');
  assert.ok(view.state().tabs.some(tab => is_markdown_tab(tab) && tab.uri === document.toString()));
  assert.equal(runtime.open_dialogs.length, 0);

  runtime.api.window.activeTextEditor = undefined;
  const tabs_before = view.state().tabs;
  await runtime.command('terminalSidebar.openMarkdown');
  await runtime.command('terminalSidebar.openPreview');
  const [markdown_picker, document_picker] = runtime.open_dialogs;
  for (const extension of ['md', 'markdown', 'mdown', 'mkd', 'mkdn', 'mdwn']) {
    assert.ok(Object.values(markdown_picker.filters ?? {}).flat().includes(extension), `Markdown picker: ${extension}`);
    assert.ok(Object.values(document_picker.filters ?? {}).flat().includes(extension), `Document picker: ${extension}`);
  }
  assert.deepEqual(view.state().tabs, tabs_before, 'cancelling a picker leaves all tabs unchanged');
});

test('preview rejects unsupported and ambiguous targets without creating a tab or starting a process', async test_case => {
  const runtime = await harness({ configuration: { left: [], right: [] } });
  test_case.after(() => runtime.dispose());
  const view = await runtime.view('right');
  for (const uri of [
    'file:///project/code.js', 'file:///project/data.xml', 'file:///project/data.yaml',
    'untitled:/notes.md', 'https://example.com/paper.pdf',
    'file:///notes.md?revision=other', 'file:///paper.pdf#page=2', 'file:///paper.tex?query=other',
  ]) {
    view.messages.length = 0;
    await runtime.command('terminalSidebar.openPreview', fake_uri.parse(uri));
    assert.ok(view.messages.some(message => message.type === 'error'), `invalid target is explained: ${uri}`);
  }
  assert.equal(runtime.open_dialogs.length, 0, 'an invalid explicit target is not replaced with a different selection');
  assert.equal(runtime.processes.length, 0);
  assert.deepEqual(runtime.opened_files, []);
});

test('HTML and source previews restore positions, refresh after atomic saves and never create shell sessions', async test_case => {
  const files = preview_fixture(test_case);
  const documents = [
    { extension: 'html', text: '<h1>Host preview fixture</h1>' },
    { extension: 'css', text: 'body{color:red}' },
    { extension: 'json', text: '{"preview":true}' },
    { extension: 'jsonc', text: '{\n// Comment is preserved\n"preview":true\n}' },
  ];
  const runtime = await harness({ configuration: { left: [], right: [] } });
  test_case.after(() => runtime.dispose());
  const right = await runtime.view('right');
  for (const document of documents) {
    const uri = fake_uri.file(path.join(files.directory, `example.${document.extension}`));
    writeFileSync(uri.fsPath, document.text);
    await runtime.command('terminalSidebar.openPreview', uri);
    const tab = right.state().tabs.find(tab => is_document_tab(tab) && tab.uri === uri.toString());
    assert.ok(tab && is_document_tab(tab));
    assert.equal(tab.format, document.extension);
    await right.send({ type: 'document_position', id: tab.id, position: { scroll: 120 } });
    await right.send({ type: 'load_document', id: tab.id });
    await right.send({ type: 'activate', id: tab.id, cols: 80, rows: 24 });
    await right.send({ type: 'input', id: tab.id, data: 'should never run\r' });
    await right.send({ type: 'resize', id: tab.id, cols: 100, rows: 30 });
  }
  await wait_for(() => right.messages.filter(message => message.type === 'document_source').length === 4, 'all document types load');
  assert.equal(runtime.processes.length, 0);
  assert.equal(runtime.watchers.length, 4);
  assert.ok(right.webview.options.localResourceRoots?.some(uri => uri.fsPath === files.directory));
  const source = right.messages.find(message => message.type === 'document_source' && message.source.text === documents[0].text);
  assert.ok(source?.type === 'document_source');
  assert.ok(source.source.base_url.endsWith('/'));

  const html_file = fake_uri.file(path.join(files.directory, 'example.html'));
  const html = right.state().tabs.find(tab => is_document_tab(tab) && tab.uri === html_file.toString())!;
  writeFileSync(html_file.fsPath, '<p>Replaced with an atomic save</p>');
  runtime.watchers[0].created.fire(html_file);
  await wait_for(() => right.messages.some(message => message.type === 'document_source'
    && message.id === html.id && message.source.text.includes('atomic save')), 'file replacement refreshes HTML');
  const restored = await harness({ configuration: { left: [], right: [] }, memory: runtime.memory });
  test_case.after(() => restored.dispose());
  const next = await restored.view('right');
  assert.equal(next.state().tabs.filter(is_document_tab).length, 4);
  assert.ok(next.state().tabs.filter(is_document_tab).every(tab => tab.scroll === 120));
  assert.equal(restored.processes.length, 0);

  await right.send({ type: 'close_tab', id: html.id });
  assert.equal(runtime.watchers[0].disposed, true);
  assert.equal(runtime.warnings.length, 0, 'closing a document never warns about a foreground command');
  const count = right.messages.length;
  await right.send({ type: 'load_document', id: html.id });
  assert.equal(right.messages.length, count, 'a stale request cannot revive a closed document');
});

test('document global search snapshots carry their format and links reuse preview routing', async test_case => {
  const files = preview_fixture(test_case);
  const uri = fake_uri.file(path.join(files.directory, 'sample.jsonc'));
  writeFileSync(uri.fsPath, '{\n// quantum source search\n"enabled":true\n}');
  const runtime = await harness({ configuration: { left: [], right: [] } });
  test_case.after(() => runtime.dispose());
  const left = await runtime.view('left');
  const right = await runtime.view('right');
  await runtime.command('terminalSidebar.openPreview', uri);
  const tab = right.state().tabs.find(is_document_tab)!;
  await left.send({ type: 'search_catalog', request: 'documents' });
  const catalog = left.messages.find(message => message.type === 'search_catalog');
  assert.ok(catalog?.type === 'search_catalog' && catalog.tabs.some(item => item.id === tab.id && item.kind === 'document'));
  await left.send({ type: 'search_read', request: 'document_text', side: 'right', id: tab.id });
  await wait_for(() => left.messages.some(message => message.type === 'search_source'), 'source snapshot arrives');
  const result = left.messages.find(message => message.type === 'search_source');
  assert.ok(result?.type === 'search_source' && result.source?.kind === 'document');
  assert.equal(result.source.format, 'jsonc');
  assert.match(result.source.text, /quantum source search/);
  await right.send({ type: 'open_document_link', id: tab.id, href: 'sibling.css' });
  assert.ok(right.state().tabs.some(item => is_document_tab(item) && item.format === 'css'));
  await right.send({ type: 'open_document_link', id: tab.id, href: uri.toString() });
  assert.deepEqual(runtime.opened_files, [uri.fsPath], 'the source button opens the current source in the editor');
  assert.equal(runtime.processes.length, 0);
});

test('untrusted workspaces cannot open or load HTML and source previews', async test_case => {
  const memory = new Map([['terminalSidebar.tabs.right', {
    version: 1, tabs: [{ id: 'html', name: 'Page', document: { uri: 'file:///page.html', format: 'html', scroll: 0 } }],
    active_id: 'html', expanded_ids: ['html'], next_number: 0,
  }]]);
  const runtime = await harness({ trusted: false, configuration: { left: [], right: [] }, memory });
  test_case.after(() => runtime.dispose());
  const view = await runtime.view('right');
  await runtime.command('terminalSidebar.openPreview', fake_uri.parse('file:///other.html'));
  await view.send({ type: 'load_document', id: 'html' });
  await view.send({ type: 'open_document_link', id: 'html', href: 'https://example.com/' });
  await view.send({ type: 'search_read', request: 'blocked', side: 'right', id: 'html' });
  assert.equal(view.state().tabs.length, 1);
  assert.equal(runtime.watchers.length, 0);
  assert.equal(runtime.processes.length, 0);
  assert.deepEqual(runtime.links, []);
  assert.ok(!view.messages.some(message => message.type === 'document_source' || message.type === 'search_source'));
});
