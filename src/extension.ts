import * as vscode from 'vscode';
import * as operating_system from 'node:os';
import * as path from 'node:path';
import { randomBytes as random_bytes } from 'node:crypto';
import { existsSync as exists_sync } from 'node:fs';
import { is_client_message, parse_configuration, read_configuration } from './profiles';
import { resolve_shell, type shell_options } from './shell';
import { discover_shells } from './discovery';
import { session_manager, type session_launch } from './sessions';
import { sidebar_tabs } from './tabs';
import type {
  appearance, client_message, host_message, shell_choice, sidebar_configuration,
  sidebar_side, terminal_profile,
} from './types';

const view_ids: Record<sidebar_side, string> = {
  left: 'terminalSidebar.left',
  right: 'terminalSidebar.terminals',
};
const sidebar_sides: sidebar_side[] = ['left', 'right'];
const history_character_limit = 1024 * 1024;
const output_delay_ms = 12;
type sidebar_action = 'save' | 'undo' | 'redo' | 'close' | 'add';

function read_scrollbar_visibility(value: unknown): 'auto' | 'visible' | 'hidden' {
  return value === 'visible' || value === 'hidden' ? value : 'auto';
}

/** Match the editor's integer scrollbar dimensions, measured in CSS pixels. */
function read_scrollbar_size(value: unknown, default_size: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return default_size;
  }
  return Math.max(0, Math.min(1000, Math.trunc(value)));
}

/** One view owns its layout and process manager; no terminal belongs to both sides. */
class sidebar_view implements vscode.WebviewViewProvider, vscode.Disposable {
  view?: vscode.WebviewView;
  ready = false;
  configuring = false;
  configure_pending = false;
  startup_complete = false;
  tab_layout?: sidebar_tabs;
  readonly dimensions = new Map<string, { cols: number; rows: number }>();
  readonly history = new Map<string, string>();
  readonly pending_output = new Map<string, string>();
  readonly sessions: session_manager;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    readonly side: sidebar_side,
    private readonly owner: terminal_sidebar,
    private readonly context: vscode.ExtensionContext,
  ) {
    this.sessions = new session_manager({
      resolve: profile => owner.launch_options(profile),
      on_output: (id, data) => owner.receive_output(this, id, data),
      on_state: session => this.post({ type: 'session', session }),
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    for (const subscription of this.subscriptions.splice(0)) {
      subscription.dispose();
    }
    this.view = view;
    this.ready = false;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    };
    view.webview.html = this.owner.html(view.webview);
    this.subscriptions.push(
      view.webview.onDidReceiveMessage((message: unknown) => {
        if (is_client_message(message)) {
          void this.owner.receive(this, message).catch(() => {
            this.error('The action could not be completed. Try again.');
          });
        }
      }),
      view.onDidChangeVisibility(() => {
        if (view.visible) {
          this.owner.send_state(this);
          this.owner.start_side(this);
        }
      }),
      view.onDidDispose(() => {
        if (this.view === view) {
          this.view = undefined;
          this.ready = false;
          this.owner.set_draft_state(this, false, false, false);
        }
      }),
    );
  }

  async open(configure = false): Promise<void> {
    if (configure) {
      this.configure_pending = true;
      this.configuring = true;
    }
    await vscode.commands.executeCommand(`${view_ids[this.side]}.focus`);
    if (this.ready && this.configure_pending) {
      this.configure_pending = false;
      this.post({ type: 'configure' });
    }
    this.owner.start_side(this);
  }

  post(message: host_message): void {
    if (this.ready && this.view) {
      void this.view.webview.postMessage(message);
    }
  }

  error(message: string): void {
    if (this.ready) {
      this.post({ type: 'error', message });
    } else {
      void vscode.window.showErrorMessage(`Terminal Sidebar: ${message}`);
    }
  }

  dispose(): void {
    this.ready = false;
    for (const subscription of this.subscriptions.splice(0)) {
      subscription.dispose();
    }
    this.sessions.dispose();
    this.history.clear();
    this.pending_output.clear();
    this.dimensions.clear();
    this.view = undefined;
  }
}

class terminal_sidebar implements vscode.Disposable {
  readonly views: Record<sidebar_side, sidebar_view>;
  private configuration: sidebar_configuration = { left: [], right: [] };
  private shells: shell_choice[] = [];
  private focused_side: sidebar_side = 'right';
  private save_in_progress = false;
  private shell_detection?: Promise<void>;
  private output_timer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.views = {
      left: new sidebar_view('left', this, context),
      right: new sidebar_view('right', this, context),
    };
    this.reload_configuration();
    void this.refresh_shells();
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('terminalSidebar.sidebars')
          || event.affectsConfiguration('terminalSidebar.profiles')) {
          this.reload_configuration();
        }
        if (event.affectsConfiguration('terminal.integrated')) {
          this.send_state();
          void this.refresh_shells();
        } else if (event.affectsConfiguration('editor.fontFamily')
          || event.affectsConfiguration('editor.scrollbar')) {
          this.send_state();
        }
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        this.send_state();
        for (const side of sidebar_sides) {
          this.start_side(this.views[side]);
        }
      }),
    );
  }

  /** Read explicit User values before defaults, preserving legacy settings and empty groups. */
  private current_configuration(): sidebar_configuration {
    const settings = vscode.workspace.getConfiguration('terminalSidebar');
    const grouped = settings.inspect<unknown>('sidebars');
    const legacy = settings.inspect<unknown>('profiles');
    return read_configuration(grouped?.globalValue, legacy?.globalValue);
  }

  private reload_configuration(): void {
    try {
      this.configuration = this.current_configuration();
      // Startup definitions never remove, rename, or stop an already-open terminal.
      this.send_state();
    } catch (error) {
      this.views[this.focused_side].error(
        error instanceof Error ? error.message : 'Invalid startup configuration.',
      );
    }
  }

  private ensure_layout(view: sidebar_view): sidebar_tabs {
    if (!view.tab_layout) {
      const remembered = this.context.workspaceState.get<unknown>(`terminalSidebar.tabs.${view.side}`);
      view.tab_layout = new sidebar_tabs(this.configuration[view.side], remembered);
    }
    return view.tab_layout;
  }

  private async remember_layout(view: sidebar_view): Promise<void> {
    if (!view.tab_layout) {
      return;
    }
    try {
      await this.context.workspaceState.update(
        `terminalSidebar.tabs.${view.side}`, view.tab_layout.remember(),
      );
    } catch {
      view.error('The terminal layout could not be remembered. Open terminals are still available.');
    }
  }

  private terminal_appearance(): appearance {
    const terminal_settings = vscode.workspace.getConfiguration('terminal.integrated');
    const editor_settings = vscode.workspace.getConfiguration('editor');
    return {
      font_family: terminal_settings.get<string>('fontFamily')
        || editor_settings.get<string>('fontFamily') || 'monospace',
      font_size: Math.max(8, Math.min(40, terminal_settings.get<number>('fontSize', 14))),
      cursor_blink: terminal_settings.get<boolean>('cursorBlinking', false),
      scrollback: Math.max(100, Math.min(10000, terminal_settings.get<number>('scrollback', 1000))),
      editor_scrollbar_vertical: read_scrollbar_visibility(
        editor_settings.get<unknown>('scrollbar.vertical'),
      ),
      editor_scrollbar_horizontal: read_scrollbar_visibility(
        editor_settings.get<unknown>('scrollbar.horizontal'),
      ),
      editor_scrollbar_vertical_size: read_scrollbar_size(
        editor_settings.get<unknown>('scrollbar.verticalScrollbarSize'), 14,
      ),
      editor_scrollbar_horizontal_size: read_scrollbar_size(
        editor_settings.get<unknown>('scrollbar.horizontalScrollbarSize'), 12,
      ),
    };
  }

  send_state(only_view?: sidebar_view): void {
    const target_views = only_view ? [only_view] : Object.values(this.views);
    for (const view of target_views) {
      if (!view.ready) {
        continue;
      }
      const layout = this.ensure_layout(view);
      if (view.view) {
        view.view.title = view.side === 'left' ? 'Terminals' : 'Side Terminal';
      }
      view.post({
        type: 'state', side: view.side, configuration: this.configuration,
        tabs: layout.tabs, sessions: view.sessions.list(),
        trusted: vscode.workspace.isTrusted, appearance: this.terminal_appearance(),
        active_id: layout.active_id, expanded_ids: layout.expanded_ids, shells: this.shells,
      });
    }
  }

  /** Start each open tab once, on first use of its sidebar, after Workspace Trust. */
  start_side(view: sidebar_view): void {
    if (this.disposed || !view.ready || !view.view?.visible || view.configuring
      || view.configure_pending || !vscode.workspace.isTrusted || view.startup_complete) {
      return;
    }
    const layout = this.ensure_layout(view);
    view.startup_complete = true;
    this.send_state(view);
    for (const tab of layout.tabs) {
      const dimensions = view.dimensions.get(tab.id) ?? { cols: 80, rows: 24 };
      view.sessions.start(tab, dimensions.cols, dimensions.rows);
    }
    void this.remember_layout(view);
  }

  receive_output(view: sidebar_view, id: string, data: string): void {
    const remaining_output = ((view.history.get(id) ?? '') + data).slice(-history_character_limit);
    const begins_with_low_surrogate = /^[\uDC00-\uDFFF]/.test(remaining_output);
    view.history.set(id, begins_with_low_surrogate ? remaining_output.slice(1) : remaining_output);
    if (!view.ready) {
      return;
    }
    view.pending_output.set(id, (view.pending_output.get(id) ?? '') + data);
    if (!this.output_timer) {
      this.output_timer = setTimeout(() => this.flush_output(), output_delay_ms);
    }
  }

  private flush_output(): void {
    if (this.output_timer) {
      clearTimeout(this.output_timer);
      this.output_timer = undefined;
    }
    for (const view of Object.values(this.views)) {
      for (const [id, data] of view.pending_output) {
        view.post({ type: 'output', id, data });
      }
      view.pending_output.clear();
    }
  }

  private async refresh_shells(): Promise<void> {
    if (this.shell_detection) {
      return this.shell_detection;
    }
    const platform_key = this.platform_key();
    this.shell_detection = (async () => {
      try {
        const configured_profiles = vscode.workspace.getConfiguration('terminal.integrated')
          .get<Record<string, { path?: string | string[]; source?: string } | null>>(`profiles.${platform_key}`, {});
        const choices = await discover_shells({ configured_profiles, env: this.terminal_environment() });
        if (!this.disposed) {
          this.shells = choices;
          this.send_state();
        }
      } catch {
        // Discovery is advisory; a custom executable remains usable when detection fails.
      } finally {
        this.shell_detection = undefined;
      }
    })();
    return this.shell_detection;
  }

  set_draft_state(view: sidebar_view, configuring: boolean, can_undo: boolean, can_redo: boolean): void {
    view.configuring = configuring;
    const context_values = {
      configuring, canUndo: configuring && can_undo, canRedo: configuring && can_redo,
    };
    for (const [name, value] of Object.entries(context_values)) {
      void vscode.commands.executeCommand('setContext', `terminalSidebar.${view.side}.${name}`, value);
    }
  }

  async open(side: sidebar_side = 'right', configure = false): Promise<void> {
    this.focused_side = side;
    await this.views[side].open(configure);
  }

  async action(side: sidebar_side, action: sidebar_action): Promise<void> {
    this.focused_side = side;
    await this.views[side].open();
    this.views[side].post({ type: 'action', action });
  }

  async configure(): Promise<void> {
    await this.open('left', true);
  }

  async restart_active(side: sidebar_side = this.focused_side): Promise<void> {
    const view = this.views[side];
    const active_id = this.ensure_layout(view).active_id;
    if (!active_id) {
      await view.open();
      return;
    }
    const dimensions = view.dimensions.get(active_id) ?? { cols: 80, rows: 24 };
    await this.restart_tab(view, active_id, dimensions.cols, dimensions.rows);
  }

  /** Public command compatibility: open one saved startup definition in the requested side. */
  async open_profile(value?: unknown, side: sidebar_side = 'right'): Promise<void> {
    const view = this.views[side];
    const profiles = this.configuration[side];
    let profile = typeof value === 'string' ? profiles.find(item => item.id === value) : undefined;
    if (!profile && typeof value === 'string') {
      const matches = profiles.filter(item => item.name === value);
      if (matches.length === 1) {
        profile = matches[0];
      }
    }
    if (!profile) {
      const selected = await vscode.window.showQuickPick(profiles.map(item => ({
        label: item.name, detail: item.command || 'Interactive shell', profile: item,
      })), { title: 'Terminal Sidebar: Open Startup Profile', placeHolder: 'Choose a startup profile' });
      profile = selected?.profile;
    }
    if (!profile) {
      return;
    }
    const layout = this.ensure_layout(view);
    const tab = layout.open_profile(profile);
    layout.select_tab(tab.id);
    layout.set_expanded(tab.id, true);
    this.focused_side = side;
    await view.open();
    this.send_state(view);
    this.start_side(view);
    if (view.startup_complete && !view.sessions.get(tab.id) && vscode.workspace.isTrusted) {
      view.sessions.start(tab, 80, 24);
    }
    await this.remember_layout(view);
  }

  async receive(view: sidebar_view, message: client_message): Promise<void> {
    if (message.type === 'ready') {
      // Flush before replay: a freshly created renderer receives each buffered chunk once.
      this.flush_output();
      view.ready = true;
      this.ensure_layout(view);
      if (view.configure_pending || view.configuring) {
        view.configure_pending = false;
        view.post({ type: 'configure' });
      }
      this.send_state(view);
      for (const [id, data] of view.history) {
        view.post({ type: 'output', id, data });
      }
      this.start_side(view);
      return;
    }
    if (message.type === 'draft_state') {
      this.set_draft_state(view, message.configuring, message.can_undo, message.can_redo);
      this.start_side(view);
      return;
    }
    if (message.type === 'settings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'terminalSidebar.sidebars');
      return;
    }
    if (message.type === 'trust') {
      await vscode.commands.executeCommand('workbench.trust.manage');
      return;
    }
    if (message.type === 'save') {
      await this.save_configuration(view, message.configuration, message.base_configuration);
      return;
    }
    if (message.type === 'refresh_shells') {
      await this.refresh_shells();
      return;
    }
    if (message.type === 'select_profile') {
      await this.open_profile(undefined, view.side);
      return;
    }
    if (message.type === 'configure') {
      await this.configure();
      return;
    }
    if (message.type === 'copy') {
      await vscode.env.clipboard.writeText(message.text);
      return;
    }
    const layout = this.ensure_layout(view);
    if (message.type === 'add_tab') {
      const tab = layout.add_tab();
      this.send_state(view);
      this.start_side(view);
      if (view.startup_complete && vscode.workspace.isTrusted && !view.sessions.get(tab.id)) {
        view.sessions.start(tab, 80, 24);
      }
      await this.remember_layout(view);
      return;
    }
    const tab = layout.tabs.find(item => item.id === message.id);
    if (!tab) {
      return;
    }
    switch (message.type) {
      case 'close_tab':
        layout.close_tab(tab.id);
        view.sessions.remove(tab.id);
        view.history.delete(tab.id);
        view.pending_output.delete(tab.id);
        view.dimensions.delete(tab.id);
        this.send_state(view);
        await this.remember_layout(view);
        return;
      case 'rename_tab':
        layout.rename_tab(tab.id, message.name);
        this.send_state(view);
        await this.remember_layout(view);
        return;
      case 'select':
        layout.select_tab(tab.id);
        this.send_state(view);
        await this.remember_layout(view);
        return;
      case 'expanded':
        layout.set_expanded(tab.id, message.expanded);
        this.send_state(view);
        await this.remember_layout(view);
        return;
      case 'export': {
        const file_name = tab.name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/[. ]+$/, '') || 'terminal';
        const destination = await vscode.window.showSaveDialog({
          title: 'Save terminal text',
          defaultUri: vscode.Uri.file(path.join(operating_system.homedir(), `${file_name}.txt`)),
          filters: { 'Text files': ['txt'] },
        });
        if (destination) {
          await vscode.workspace.fs.writeFile(destination, Buffer.from(message.text, 'utf8'));
        }
        return;
      }
    }
    if (!vscode.workspace.isTrusted) {
      view.error('Trust this workspace before starting or using a terminal.');
      return;
    }
    const surface_visible = view.view?.visible && !view.configuring
      && (view.side === 'left' ? layout.expanded_ids.includes(tab.id) : layout.active_id === tab.id);
    switch (message.type) {
      case 'focus':
        if (surface_visible) {
          this.focused_side = view.side;
          layout.select_tab(tab.id);
          await this.remember_layout(view);
        }
        break;
      case 'activate':
      case 'resize':
        if (surface_visible) {
          view.dimensions.set(tab.id, { cols: message.cols, rows: message.rows });
          view.sessions.resize(tab.id, message.cols, message.rows);
        }
        break;
      case 'input':
        if (surface_visible) {
          this.focused_side = view.side;
          view.sessions.input(tab.id, message.data);
        }
        break;
      case 'restart':
        await this.restart_tab(view, tab.id, message.cols, message.rows);
        break;
      case 'paste': {
        if (!surface_visible) {
          break;
        }
        const text = await vscode.env.clipboard.readText();
        if (text.length > history_character_limit) {
          view.error('Clipboard text exceeds the 1 MiB limit.');
        } else {
          view.post({ type: 'paste', id: tab.id, data: text });
        }
        break;
      }
    }
  }

  private async restart_tab(view: sidebar_view, id: string, column_count: number, row_count: number): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      view.error('Trust this workspace before starting a terminal.');
      return;
    }
    if (view.sessions.get(id)?.status === 'running') {
      const choice = await vscode.window.showWarningMessage(
        'Restart this terminal? Its current process will end.', { modal: true }, 'Restart',
      );
      if (choice !== 'Restart') {
        return;
      }
    }
    const tab = this.ensure_layout(view).tabs.find(item => item.id === id);
    if (!tab || !vscode.workspace.isTrusted) {
      return;
    }
    view.sessions.remove(id);
    view.history.delete(id);
    view.pending_output.delete(id);
    view.post({ type: 'reset', id });
    view.sessions.start(tab, column_count, row_count);
  }

  private async save_configuration(view: sidebar_view, value: unknown, baseline_value: unknown): Promise<void> {
    if (this.save_in_progress) {
      view.error('Another save is in progress. Try again after it finishes.');
      return;
    }
    this.save_in_progress = true;
    try {
      const configuration = parse_configuration(value);
      const baseline = JSON.stringify(parse_configuration(baseline_value));
      if (baseline !== JSON.stringify(this.current_configuration())) {
        throw new Error('Startup settings changed elsewhere. Your draft is intact. Reopen configuration before saving.');
      }
      await vscode.workspace.getConfiguration('terminalSidebar').update(
        'sidebars', configuration, vscode.ConfigurationTarget.Global,
      );
      this.reload_configuration();
      view.post({ type: 'saved', configuration });
    } catch (error) {
      view.error(error instanceof Error ? error.message : 'Startup settings could not be saved.');
    } finally {
      this.save_in_progress = false;
    }
  }

  private platform_key(): 'windows' | 'osx' | 'linux' {
    if (process.platform === 'win32') {
      return 'windows';
    }
    return process.platform === 'darwin' ? 'osx' : 'linux';
  }

  private terminal_environment(): NodeJS.ProcessEnv {
    const settings = vscode.workspace.getConfiguration('terminal.integrated');
    const environment_variables: NodeJS.ProcessEnv = {
      ...process.env, TERM_PROGRAM: 'terminal-sidebar', COLORTERM: 'truecolor',
    };
    const configured_environment = settings.get<Record<string, string | null>>(`env.${this.platform_key()}`, {});
    for (const [name, value] of Object.entries(configured_environment)) {
      if (value === null) {
        delete environment_variables[name];
      } else {
        environment_variables[name] = value;
      }
    }
    return environment_variables;
  }

  launch_options(profile: terminal_profile): session_launch {
    const platform_key = this.platform_key();
    const settings = vscode.workspace.getConfiguration('terminal.integrated');
    const environment_variables = this.terminal_environment();
    const expand_path = (text: string): string => text
      .replace(/\$\{env:([^}]+)\}/g, (_, name: string) => environment_variables[name] ?? '')
      .replaceAll('${userHome}', operating_system.homedir());
    const profile_name = settings.get<string>(`defaultProfile.${platform_key}`);
    const native_profiles = settings.get<Record<string, {
      path?: string | string[]; source?: string; args?: string[] | string; env?: Record<string, string | null>;
    } | null>>(`profiles.${platform_key}`, {});
    const native_profile = profile_name ? native_profiles[profile_name] : undefined;
    let default_profile: shell_options['default_profile'];
    if (native_profile?.path) {
      default_profile = {
        ...native_profile,
        path: Array.isArray(native_profile.path)
          ? native_profile.path.map(expand_path) : expand_path(native_profile.path),
      };
    } else if (native_profile?.source === 'PowerShell') {
      const powershell = resolve_shell('powershell', { env: environment_variables });
      default_profile = {
        path: powershell.file, args: native_profile.args ?? powershell.args, env: native_profile.env,
      };
    } else if (native_profile?.source === 'Git Bash' && process.platform === 'win32') {
      const roots = [environment_variables.ProgramFiles, environment_variables['ProgramFiles(x86)']];
      if (environment_variables.LocalAppData) {
        roots.push(path.join(environment_variables.LocalAppData, 'Programs'));
      }
      const executable_paths = roots.filter((root): root is string => Boolean(root))
        .map(root => path.join(root, 'Git', 'bin', 'bash.exe'));
      default_profile = {
        path: executable_paths, args: native_profile.args ?? ['--login', '-i'], env: native_profile.env,
      };
    }
    const resolved = resolve_shell(expand_path(profile.shell), { env: environment_variables, default_profile });
    const working_directory = vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath)
      .find(folder => exists_sync(folder)) ?? operating_system.homedir();
    return { ...resolved, cwd: working_directory };
  }

  html(webview: vscode.Webview): string {
    const nonce = random_bytes(18).toString('base64');
    const stylesheet = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css'));
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'));
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:; connect-src 'none';"><link rel="stylesheet" href="${stylesheet}"><title>Terminal Sidebar</title></head><body><div id="app"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }

  dispose(): void {
    this.disposed = true;
    if (this.output_timer) {
      clearTimeout(this.output_timer);
    }
    for (const view of Object.values(this.views)) {
      view.dispose();
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new terminal_sidebar(context);
  context.subscriptions.push(provider);
  for (const side of sidebar_sides) {
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(view_ids[side], provider.views[side], {
        webviewOptions: { retainContextWhenHidden: true },
      }),
      vscode.commands.registerCommand(`terminalSidebar.${side}.configure`, () => provider.configure()),
      vscode.commands.registerCommand(`terminalSidebar.${side}.restart`, () => provider.restart_active(side)),
      vscode.commands.registerCommand(`terminalSidebar.${side}.selectProfile`, () => provider.open_profile(undefined, side)),
    );
    for (const action of ['save', 'undo', 'redo', 'close', 'add'] as const) {
      context.subscriptions.push(vscode.commands.registerCommand(
        `terminalSidebar.${side}.${action}`, () => provider.action(side, action),
      ));
    }
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('terminalSidebar.open', () => provider.open()),
    vscode.commands.registerCommand('terminalSidebar.openLeft', () => provider.open('left')),
    vscode.commands.registerCommand('terminalSidebar.openProfile', (argument?: unknown, target?: unknown) => {
      const options = argument && typeof argument === 'object' ? argument as Record<string, unknown> : undefined;
      const side = (options?.side ?? target) === 'left' ? 'left' : 'right';
      return provider.open_profile(options?.id ?? argument, side);
    }),
    vscode.commands.registerCommand('terminalSidebar.configure', () => provider.configure()),
    vscode.commands.registerCommand('terminalSidebar.restart', () => provider.restart_active()),
  );
}
