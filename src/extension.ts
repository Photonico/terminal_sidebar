import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DEFAULT_PROFILES, isClientMessage, parseProfiles } from './profiles';
import { resolveShell, type ShellOptions } from './shell';
import { SessionManager, type SessionLaunch } from './sessions';
import type { Appearance, ClientMessage, HostMessage, Profile } from './types';

const VIEW_ID = 'terminalSidebar.terminals';
const HISTORY_LIMIT = 1024 * 1024;

class TerminalSidebar implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private ready = false;
  private configurePending = false;
  private profiles: Profile[] = [];
  private activeId?: string;
  private saveInProgress = false;
  private readonly history = new Map<string, string>();
  private readonly pendingOutput = new Map<string, string>();
  private outputTimer?: ReturnType<typeof setTimeout>;
  private readonly sessions: SessionManager;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.activeId = context.workspaceState.get<string>('activeProfile');
    this.sessions = new SessionManager({
      resolve: profile => this.launchOptions(profile),
      onOutput: (id, data) => this.output(id, data),
      onState: session => this.post({ type: 'session', session })
    });
    this.reloadProfiles();
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('terminalSidebar.profiles')) this.reloadProfiles();
        if (event.affectsConfiguration('terminal.integrated') || event.affectsConfiguration('editor.fontFamily')) this.sendState();
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.sendState())
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')]
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: unknown) => {
      if (isClientMessage(message)) void this.receive(message).catch(() => this.error('The action could not be completed. Try again.'));
    }, undefined, this.context.subscriptions);
    view.onDidDispose(() => {
      if (this.view === view) { this.view = undefined; this.ready = false; }
    }, undefined, this.context.subscriptions);
  }

  async open(configure = false): Promise<void> {
    this.configurePending ||= configure;
    if (this.ready && this.configurePending) {
      this.configurePending = false;
      this.post({ type: 'configure' });
    }
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
  }

  async restartActive(): Promise<void> {
    if (this.activeId) await this.restart(this.activeId, 80, 24);
    else await this.open();
  }

  private post(message: HostMessage): void {
    if (this.ready && this.view) void this.view.webview.postMessage(message);
  }

  private error(message: string): void {
    if (this.ready) this.post({ type: 'error', message });
    else void vscode.window.showErrorMessage(`Terminal Sidebar: ${message}`);
  }

  private reloadProfiles(): void {
    try {
      // Application-scoped settings only: a repository cannot supply startup commands.
      const settings = vscode.workspace.getConfiguration('terminalSidebar');
      const value = settings.inspect<unknown>('profiles')?.globalValue ?? settings.inspect<unknown>('profiles')?.defaultValue ?? DEFAULT_PROFILES;
      const next = parseProfiles(value);
      const ids = new Set(next.map(profile => profile.id));
      for (const session of this.sessions.list()) if (!ids.has(session.id)) this.sessions.remove(session.id);
      for (const id of this.history.keys()) if (!ids.has(id)) { this.history.delete(id); this.pendingOutput.delete(id); }
      this.profiles = next;
      if (!this.activeId || !ids.has(this.activeId)) this.activeId = next[0]?.id;
      this.sendState();
    } catch (error) {
      this.error(error instanceof Error ? error.message : 'Invalid profile settings.');
    }
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

  private sendState(): void {
    this.post({ type: 'state', profiles: this.profiles, sessions: this.sessions.list(), trusted: vscode.workspace.isTrusted, appearance: this.appearance(), activeId: this.activeId });
  }

  private output(id: string, data: string): void {
    this.history.set(id, ((this.history.get(id) ?? '') + data).slice(-HISTORY_LIMIT));
    if (!this.ready) return;
    this.pendingOutput.set(id, (this.pendingOutput.get(id) ?? '') + data);
    if (!this.outputTimer) this.outputTimer = setTimeout(() => {
      this.outputTimer = undefined;
      for (const [outputId, text] of this.pendingOutput) this.post({ type: 'output', id: outputId, data: text });
      this.pendingOutput.clear();
    }, 12);
  }

  private async receive(message: ClientMessage): Promise<void> {
    if (message.type === 'ready') {
      this.ready = true;
      this.pendingOutput.clear();
      if (this.configurePending) { this.configurePending = false; this.post({ type: 'configure' }); }
      this.sendState();
      for (const [id, data] of this.history) this.post({ type: 'output', id, data });
      return;
    }
    if (message.type === 'settings') { await vscode.commands.executeCommand('workbench.action.openSettings', 'terminalSidebar.profiles'); return; }
    if (message.type === 'trust') { await vscode.commands.executeCommand('workbench.trust.manage'); return; }
    if (message.type === 'save') { await this.save(message.profiles); return; }
    if (message.type === 'copy') { await vscode.env.clipboard.writeText(message.text); return; }
    const profile = this.profiles.find(entry => entry.id === message.id);
    if (!profile) return;
    if (!vscode.workspace.isTrusted) { this.error('Trust this workspace before starting or using a terminal.'); return; }
    switch (message.type) {
      case 'activate':
        this.activeId = profile.id;
        void this.context.workspaceState.update('activeProfile', profile.id);
        if (!this.sessions.get(profile.id)) this.sessions.start(profile, message.cols, message.rows);
        else this.sessions.resize(profile.id, message.cols, message.rows);
        break;
      case 'input': this.sessions.input(profile.id, message.data); break;
      case 'resize': this.sessions.resize(profile.id, message.cols, message.rows); break;
      case 'stop': this.sessions.stop(profile.id); break;
      case 'restart': await this.restart(profile.id, message.cols, message.rows); break;
      case 'paste': {
        const data = await vscode.env.clipboard.readText();
        if (data.length > HISTORY_LIMIT) this.error('Clipboard text is too large to paste (maximum 1 MiB).');
        else this.post({ type: 'paste', id: profile.id, data });
        break;
      }
    }
  }

  private async restart(id: string, cols: number, rows: number): Promise<void> {
    if (!vscode.workspace.isTrusted) { this.error('Trust this workspace before starting a terminal.'); return; }
    const profile = this.profiles.find(entry => entry.id === id);
    if (!profile) return;
    if (this.sessions.get(id)?.status === 'running') {
      const choice = await vscode.window.showWarningMessage(`Restart “${profile.name}”? Its current process will end.`, { modal: true }, 'Restart');
      if (choice !== 'Restart') return;
    }
    this.sessions.remove(id);
    this.history.delete(id);
    this.pendingOutput.delete(id);
    this.post({ type: 'reset', id });
    this.sessions.start(profile, cols, rows);
  }

  private async save(value: unknown): Promise<void> {
    if (this.saveInProgress) return;
    this.saveInProgress = true;
    try {
      const profiles = parseProfiles(value);
      const ids = new Set(profiles.map(profile => profile.id));
      if (this.sessions.list().some(session => session.status === 'running' && !ids.has(session.id))) {
        const choice = await vscode.window.showWarningMessage('Saving will stop terminals whose profiles were removed.', { modal: true }, 'Save');
        if (choice !== 'Save') { this.error('Save cancelled. Your draft is still open.'); return; }
      }
      await vscode.workspace.getConfiguration('terminalSidebar').update('profiles', profiles, vscode.ConfigurationTarget.Global);
      this.reloadProfiles();
      this.post({ type: 'saved', profiles });
    } catch (error) {
      this.error(error instanceof Error ? error.message : 'Could not save profiles.');
    } finally { this.saveInProgress = false; }
  }

  private launchOptions(profile: Profile): SessionLaunch {
    const platformKey = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
    const terminal = vscode.workspace.getConfiguration('terminal.integrated');
    const env: NodeJS.ProcessEnv = { ...process.env, TERM_PROGRAM: 'terminal-sidebar', COLORTERM: 'truecolor' };
    for (const [key, value] of Object.entries(terminal.get<Record<string, string | null>>(`env.${platformKey}`, {}))) {
      if (value === null) delete env[key]; else env[key] = value;
    }
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

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(18).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css'));
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'));
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:; connect-src 'none';"><link rel="stylesheet" href="${css}"><title>Terminal Sidebar</title></head><body><div id="app"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }

  dispose(): void {
    if (this.outputTimer) clearTimeout(this.outputTimer);
    this.ready = false;
    this.sessions.dispose();
    this.history.clear();
    this.pendingOutput.clear();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new TerminalSidebar(context);
  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('terminalSidebar.open', () => provider.open()),
    vscode.commands.registerCommand('terminalSidebar.configure', () => provider.open(true)),
    vscode.commands.registerCommand('terminalSidebar.restart', () => provider.restartActive())
  );
}
