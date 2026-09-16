import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DEFAULT_PROFILES, isClientMessage, parseProfiles } from './profiles';
import { resolveShell, type ShellOptions } from './shell';
import { discoverShells } from './discovery';
import { SessionManager, type SessionLaunch } from './sessions';
import type { Appearance, ClientMessage, HostMessage, Profile, ShellChoice } from './types';

type Side = 'left' | 'right';
type Action = 'save' | 'undo' | 'redo' | 'close';
const VIEW_IDS: Record<Side, string> = { left: 'terminalSidebar.left', right: 'terminalSidebar.terminals' };
const HISTORY_LIMIT = 1024 * 1024;

/** Each surface has its own selection and draft; both observe the same terminal sessions. */
class SidebarView implements vscode.WebviewViewProvider, vscode.Disposable {
  view?: vscode.WebviewView;
  ready = false;
  activeId?: string;
  configurePending = false;
  readonly sizes = new Map<string, { cols: number; rows: number }>();
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(readonly side: Side, private readonly owner: TerminalSidebar, private readonly context: vscode.ExtensionContext) {
    this.activeId = context.workspaceState.get<string>(`activeProfile.${side}`)
      ?? (side === 'right' ? context.workspaceState.get<string>('activeProfile') : undefined);
  }
  resolveWebviewView(view: vscode.WebviewView): void {
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    this.view = view;
    this.ready = false;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')] };
    view.webview.html = this.owner.html(view.webview);
    this.subscriptions.push(
      view.webview.onDidReceiveMessage((message: unknown) => {
        if (isClientMessage(message)) void this.owner.receive(this, message).catch(() => this.error('The action could not be completed. Try again.'));
      }),
      view.onDidChangeVisibility(() => { if (view.visible) this.owner.sendState(this); }),
      view.onDidDispose(() => {
        if (this.view === view) { this.view = undefined; this.ready = false; this.owner.setDraftState(this, false, false, false); }
      })
    );
    this.owner.sendState(this);
  }
  async open(configure = false): Promise<void> {
    this.configurePending ||= configure;
    await vscode.commands.executeCommand(`${VIEW_IDS[this.side]}.focus`);
    if (this.ready && this.configurePending) { this.configurePending = false; this.post({ type: 'configure' }); }
  }
  post(message: HostMessage): void { if (this.ready && this.view) void this.view.webview.postMessage(message); }
  error(message: string): void {
    if (this.ready) this.post({ type: 'error', message });
    else void vscode.window.showErrorMessage(`Terminal Sidebar: ${message}`);
  }
  dispose(): void {
    this.ready = false;
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    this.view = undefined;
  }
}

class TerminalSidebar implements vscode.Disposable {
  readonly views: Record<Side, SidebarView>;
  private profiles: Profile[] = [];
  private shells: ShellChoice[] = [];
  private focusedSide: Side = 'right';
  private saveInProgress = false;
  private discovery?: Promise<void>;
  private disposed = false;
  private readonly history = new Map<string, string>();
  private readonly pendingOutput = new Map<string, string>();
  private readonly resizeOwner = new Map<string, Side>();
  private outputTimer?: ReturnType<typeof setTimeout>;
  private readonly sessions: SessionManager;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.views = { left: new SidebarView('left', this, context), right: new SidebarView('right', this, context) };
    this.sessions = new SessionManager({
      resolve: profile => this.launchOptions(profile),
      onOutput: (id, data) => this.output(id, data),
      onState: session => this.broadcast({ type: 'session', session })
    });
    this.reloadProfiles();
    void this.refreshShells();
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('terminalSidebar.profiles')) this.reloadProfiles();
        if (event.affectsConfiguration('terminal.integrated') || event.affectsConfiguration('editor.fontFamily')) {
          this.sendState();
          void this.refreshShells();
        }
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.sendState())
    );
  }

  private currentProfiles(): Profile[] {
    const setting = vscode.workspace.getConfiguration('terminalSidebar').inspect<unknown>('profiles');
    return parseProfiles(setting?.globalValue ?? setting?.defaultValue ?? DEFAULT_PROFILES);
  }
  private reloadProfiles(): void {
    try {
      const next = this.currentProfiles();
      const ids = new Set(next.map(profile => profile.id));
      for (const session of this.sessions.list()) if (!ids.has(session.id)) this.sessions.remove(session.id);
      for (const id of this.history.keys()) if (!ids.has(id)) { this.history.delete(id); this.pendingOutput.delete(id); this.resizeOwner.delete(id); }
      this.profiles = next;
      for (const view of Object.values(this.views)) {
        if (!view.activeId || !ids.has(view.activeId)) view.activeId = next[0]?.id;
        for (const id of view.sizes.keys()) if (!ids.has(id)) view.sizes.delete(id);
      }
      this.sendState();
    } catch (error) { this.views[this.focusedSide].error(error instanceof Error ? error.message : 'Invalid profile settings.'); }
  }
  private appearance(): Appearance {
    const terminal = vscode.workspace.getConfiguration('terminal.integrated');
    return {
      fontFamily: terminal.get<string>('fontFamily') || vscode.workspace.getConfiguration('editor').get<string>('fontFamily') || 'monospace',
      fontSize: Math.max(8, Math.min(40, terminal.get<number>('fontSize', 14))),
      cursorBlink: terminal.get<boolean>('cursorBlinking', false),
      scrollback: Math.max(100, Math.min(10000, terminal.get<number>('scrollback', 1000)))
    };
  }
  sendState(only?: SidebarView): void {
    for (const view of only ? [only] : Object.values(this.views)) {
      if (view.view) view.view.title = view.side === 'right' ? this.profiles.find(profile => profile.id === view.activeId)?.name ?? 'Terminals' : 'Terminals';
      view.post({ type: 'state', profiles: this.profiles, sessions: this.sessions.list(), trusted: vscode.workspace.isTrusted,
        appearance: this.appearance(), activeId: view.activeId, shells: this.shells });
    }
  }
  private broadcast(message: HostMessage): void { for (const view of Object.values(this.views)) view.post(message); }
  private output(id: string, data: string): void {
    const tail = ((this.history.get(id) ?? '') + data).slice(-HISTORY_LIMIT);
    this.history.set(id, /^[\uDC00-\uDFFF]/.test(tail) ? tail.slice(1) : tail);
    if (!Object.values(this.views).some(view => view.ready)) return;
    this.pendingOutput.set(id, (this.pendingOutput.get(id) ?? '') + data);
    if (!this.outputTimer) this.outputTimer = setTimeout(() => {
      this.outputTimer = undefined;
      for (const [outputId, text] of this.pendingOutput) this.broadcast({ type: 'output', id: outputId, data: text });
      this.pendingOutput.clear();
    }, 12);
  }
  private flushOutput(): void {
    if (this.outputTimer) clearTimeout(this.outputTimer);
    this.outputTimer = undefined;
    for (const [id, data] of this.pendingOutput) this.broadcast({ type: 'output', id, data });
    this.pendingOutput.clear();
  }
  private async refreshShells(): Promise<void> {
    if (this.discovery) return this.discovery;
    const platformKey = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
    this.discovery = (async () => {
      try {
        const configuredProfiles = vscode.workspace.getConfiguration('terminal.integrated').get<Record<string, { path?: string | string[]; source?: string } | null>>(`profiles.${platformKey}`, {});
        const shells = await discoverShells({ configuredProfiles, env: this.terminalEnvironment() });
        if (!this.disposed) { this.shells = shells; this.sendState(); }
      } catch { /* Discovery is advisory; users can still provide an executable path. */ }
      finally { this.discovery = undefined; }
    })();
    return this.discovery;
  }
  setDraftState(view: SidebarView, configuring: boolean, canUndo: boolean, canRedo: boolean): void {
    for (const [name, value] of Object.entries({ configuring, canUndo: configuring && canUndo, canRedo: configuring && canRedo }))
      void vscode.commands.executeCommand('setContext', `terminalSidebar.${view.side}.${name}`, value);
  }
  async open(side: Side = 'right', configure = false): Promise<void> { this.focusedSide = side; await this.views[side].open(configure); }
  async action(side: Side, action: Action): Promise<void> {
    this.focusedSide = side;
    await this.views[side].open();
    this.views[side].post({ type: 'action', action });
  }
  async configure(): Promise<void> { await this.open('left', true); }
  async restartActive(side: Side = this.focusedSide): Promise<void> {
    const view = this.views[side];
    if (view.activeId) { const size = view.sizes.get(view.activeId) ?? { cols: 80, rows: 24 }; await this.restart(view, view.activeId, size.cols, size.rows); }
    else await view.open();
  }
  async openProfile(value?: unknown, side: Side = 'right'): Promise<void> {
    this.focusedSide = side;
    const view = this.views[side];
    let profile = typeof value === 'string' ? this.profiles.find(item => item.id === value) : undefined;
    if (!profile && typeof value === 'string') {
      const matches = this.profiles.filter(item => item.name === value);
      if (matches.length === 1) profile = matches[0];
    }
    if (!profile) {
      if (!this.profiles.length) { await view.open(true); return; }
      const selected = await vscode.window.showQuickPick(this.profiles.map(item => ({
        label: item.name, description: this.sessions.get(item.id)?.status ?? 'idle', detail: item.command || 'Interactive shell', profile: item
      })), { title: 'Terminal Sidebar: Open Profile', placeHolder: 'Choose a terminal profile', matchOnDescription: false, matchOnDetail: false });
      profile = selected?.profile;
    }
    if (!profile || !this.profiles.some(item => item.id === profile!.id)) return;
    view.activeId = profile.id;
    void this.context.workspaceState.update(`activeProfile.${side}`, profile.id);
    await view.open();
    this.sendState(view);
  }

  async receive(view: SidebarView, message: ClientMessage): Promise<void> {
    if (message.type === 'ready') {
      // Flush to existing views before replaying, avoiding duplicate output in the new view.
      this.flushOutput();
      view.ready = true;
      if (view.configurePending) { view.configurePending = false; view.post({ type: 'configure' }); }
      this.sendState(view);
      for (const [id, data] of this.history) view.post({ type: 'output', id, data });
      return;
    }
    if (message.type === 'draftState') { this.setDraftState(view, message.configuring, message.canUndo, message.canRedo); return; }
    if (message.type === 'settings') { await vscode.commands.executeCommand('workbench.action.openSettings', 'terminalSidebar.profiles'); return; }
    if (message.type === 'trust') { await vscode.commands.executeCommand('workbench.trust.manage'); return; }
    if (message.type === 'save') { await this.save(view, message.profiles, message.baseProfiles); return; }
    if (message.type === 'refreshShells') { await this.refreshShells(); return; }
    if (message.type === 'selectProfile') { await this.openProfile(undefined, view.side); return; }
    if (message.type === 'configure') { await this.configure(); return; }
    if (message.type === 'copy') { await vscode.env.clipboard.writeText(message.text); return; }
    const profile = this.profiles.find(entry => entry.id === message.id);
    if (!profile) return;
    if (message.type === 'export') {
      const name = profile.name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/[. ]+$/, '') || 'terminal';
      const uri = await vscode.window.showSaveDialog({ title: 'Save terminal text', defaultUri: vscode.Uri.file(path.join(os.homedir(), `${name}.txt`)), filters: { 'Text files': ['txt'] } });
      if (uri) await vscode.workspace.fs.writeFile(uri, Buffer.from(message.text, 'utf8'));
      return;
    }
    if (!vscode.workspace.isTrusted) { view.error('Trust this workspace before starting or using a terminal.'); return; }
    switch (message.type) {
      case 'focus':
        if (!view.view?.visible || view.activeId !== profile.id) break;
        this.focusedSide = view.side;
        this.resizeOwner.set(profile.id, view.side);
        { const size = view.sizes.get(profile.id); if (size) this.sessions.resize(profile.id, size.cols, size.rows); }
        break;
      case 'activate':
        if (!view.view?.visible) break;
        view.activeId = profile.id;
        view.sizes.set(profile.id, { cols: message.cols, rows: message.rows });
        void this.context.workspaceState.update(`activeProfile.${view.side}`, profile.id);
        if (!this.sessions.get(profile.id)) {
          this.resizeOwner.set(profile.id, view.side);
          this.sessions.start(profile, message.cols, message.rows);
        } else if (!this.resizeOwner.has(profile.id) || !this.views[this.resizeOwner.get(profile.id)!].view?.visible
          || this.views[this.resizeOwner.get(profile.id)!].activeId !== profile.id) {
          this.resizeOwner.set(profile.id, view.side);
          this.sessions.resize(profile.id, message.cols, message.rows);
        }
        this.sendState(view);
        break;
      case 'input':
        if (!view.view?.visible || view.activeId !== profile.id) break;
        this.focusedSide = view.side;
        if (this.resizeOwner.get(profile.id) !== view.side) {
          const size = view.sizes.get(profile.id);
          if (size) this.sessions.resize(profile.id, size.cols, size.rows);
        }
        this.resizeOwner.set(profile.id, view.side);
        this.sessions.input(profile.id, message.data);
        break;
      case 'resize':
        view.sizes.set(profile.id, { cols: message.cols, rows: message.rows });
        if (view.view?.visible && view.activeId === profile.id && this.resizeOwner.get(profile.id) === view.side) this.sessions.resize(profile.id, message.cols, message.rows);
        break;
      case 'stop': this.sessions.stop(profile.id); break;
      case 'restart': await this.restart(view, profile.id, message.cols, message.rows); break;
      case 'paste': {
        const data = await vscode.env.clipboard.readText();
        if (data.length > HISTORY_LIMIT) view.error('Clipboard text exceeds the 1 MiB limit.');
        else view.post({ type: 'paste', id: profile.id, data });
        break;
      }
    }
  }
  private async restart(view: SidebarView, id: string, cols: number, rows: number): Promise<void> {
    if (!vscode.workspace.isTrusted) { view.error('Trust this workspace before starting a terminal.'); return; }
    if (!this.profiles.some(profile => profile.id === id)) return;
    if (this.sessions.get(id)?.status === 'running') {
      const choice = await vscode.window.showWarningMessage('Restart this terminal? Its current process will end in both sidebars.', { modal: true }, 'Restart');
      if (choice !== 'Restart') return;
    }
    const profile = this.profiles.find(item => item.id === id);
    if (!profile || !vscode.workspace.isTrusted) return;
    this.sessions.remove(id);
    this.history.delete(id);
    this.pendingOutput.delete(id);
    this.broadcast({ type: 'reset', id });
    this.resizeOwner.set(id, view.side);
    this.sessions.start(profile, cols, rows);
  }
  private async save(view: SidebarView, value: unknown, baseValue: unknown): Promise<void> {
    if (this.saveInProgress) { view.error('Another profile save is in progress. Try again after it finishes.'); return; }
    this.saveInProgress = true;
    try {
      const profiles = parseProfiles(value);
      const baseline = JSON.stringify(parseProfiles(baseValue));
      const unchanged = (): boolean => baseline === JSON.stringify(this.currentProfiles());
      if (!unchanged()) throw new Error('Profiles changed elsewhere. Your draft is intact. Copy any needed edits, then close and reopen configuration before saving.');
      const ids = new Set(profiles.map(profile => profile.id));
      if (this.sessions.list().some(session => session.status === 'running' && !ids.has(session.id))) {
        const choice = await vscode.window.showWarningMessage('Saving will stop terminals whose profiles were removed, in both sidebars.', { modal: true }, 'Save');
        if (choice !== 'Save') { view.error('Save cancelled. Your draft is still open.'); return; }
      }
      if (!unchanged()) throw new Error('Profiles changed while saving. Your draft is intact. Reopen configuration before applying it.');
      await vscode.workspace.getConfiguration('terminalSidebar').update('profiles', profiles, vscode.ConfigurationTarget.Global);
      this.reloadProfiles();
      view.post({ type: 'saved', profiles });
    } catch (error) { view.error(error instanceof Error ? error.message : 'Could not save profiles.'); }
    finally { this.saveInProgress = false; }
  }

  private terminalEnvironment(): NodeJS.ProcessEnv {
    const platformKey = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
    const terminal = vscode.workspace.getConfiguration('terminal.integrated');
    const env: NodeJS.ProcessEnv = { ...process.env, TERM_PROGRAM: 'terminal-sidebar', COLORTERM: 'truecolor' };
    for (const [key, value] of Object.entries(terminal.get<Record<string, string | null>>(`env.${platformKey}`, {}))) {
      if (value === null) delete env[key]; else env[key] = value;
    }
    return env;
  }
  private launchOptions(profile: Profile): SessionLaunch {
    const platformKey = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
    const terminal = vscode.workspace.getConfiguration('terminal.integrated');
    const env = this.terminalEnvironment();
    const expand = (text: string): string => text.replace(/\$\{env:([^}]+)\}/g, (_, key: string) => env[key] ?? '').replaceAll('${userHome}', os.homedir());
    const profileName = terminal.get<string>(`defaultProfile.${platformKey}`);
    const nativeProfiles = terminal.get<Record<string, { path?: string | string[]; source?: string; args?: string[] | string; env?: Record<string, string | null> } | null>>(`profiles.${platformKey}`, {});
    const native = profileName ? nativeProfiles[profileName] : undefined;
    let defaultProfile: ShellOptions['defaultProfile'];
    if (native?.path) defaultProfile = { ...native, path: Array.isArray(native.path) ? native.path.map(expand) : expand(native.path) };
    else if (native?.source === 'PowerShell') {
      const powershell = resolveShell('powershell', { env });
      defaultProfile = { path: powershell.file, args: native.args ?? powershell.args, env: native.env };
    } else if (native?.source === 'Git Bash' && process.platform === 'win32') {
      const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LocalAppData && path.join(env.LocalAppData, 'Programs')].filter((root): root is string => !!root);
      defaultProfile = { path: roots.map(root => path.join(root, 'Git', 'bin', 'bash.exe')), args: native.args ?? ['--login', '-i'], env: native.env };
    }
    const shell = resolveShell(expand(profile.shell), { env, defaultProfile });
    const cwd = vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath).find(folder => existsSync(folder)) ?? os.homedir();
    return { ...shell, cwd };
  }
  html(webview: vscode.Webview): string {
    const nonce = randomBytes(18).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css'));
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'));
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:; connect-src 'none';"><link rel="stylesheet" href="${css}"><title>Terminal Sidebar</title></head><body><div id="app"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }
  dispose(): void {
    this.disposed = true;
    if (this.outputTimer) clearTimeout(this.outputTimer);
    for (const view of Object.values(this.views)) view.dispose();
    this.sessions.dispose();
    this.history.clear();
    this.pendingOutput.clear();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new TerminalSidebar(context);
  context.subscriptions.push(provider);
  for (const side of ['left', 'right'] as const) {
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(VIEW_IDS[side], provider.views[side], { webviewOptions: { retainContextWhenHidden: true } }),
      vscode.commands.registerCommand(`terminalSidebar.${side}.configure`, () => provider.configure()),
      vscode.commands.registerCommand(`terminalSidebar.${side}.restart`, () => provider.restartActive(side)),
      vscode.commands.registerCommand(`terminalSidebar.${side}.selectProfile`, () => provider.openProfile(undefined, side))
    );
    for (const action of ['save', 'undo', 'redo', 'close'] as const)
      context.subscriptions.push(vscode.commands.registerCommand(`terminalSidebar.${side}.${action}`, () => provider.action(side, action)));
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('terminalSidebar.open', () => provider.open()),
    vscode.commands.registerCommand('terminalSidebar.openLeft', () => provider.open('left')),
    vscode.commands.registerCommand('terminalSidebar.openProfile', (arg?: unknown, target?: unknown) => {
      const options = arg && typeof arg === 'object' ? arg as Record<string, unknown> : undefined;
      return provider.openProfile(options?.id ?? arg, (options?.side ?? target) === 'left' ? 'left' : 'right');
    }),
    vscode.commands.registerCommand('terminalSidebar.configure', () => provider.configure()),
    vscode.commands.registerCommand('terminalSidebar.restart', () => provider.restartActive())
  );
}
