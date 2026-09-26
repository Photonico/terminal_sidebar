import { set_preview_font, preview_font_family, read_preview_font } from './preview_font';
import { about_panel } from './about';
import { usage_panel } from './usage';
import { global_search_host } from './global_search_host';
import * as vscode from 'vscode';
import * as operating_system from 'node:os';
import * as path from 'node:path';
import { randomBytes as random_bytes } from 'node:crypto';
import { statSync as stat_sync } from 'node:fs';
import { is_client_message, is_tab_name, parse_configuration, read_configuration } from './profiles';
import { resolve_shell, type shell_options } from './shell';
import { shell_integration } from './shell_integration';
import { discover_shells } from './discovery';
import { session_manager, type session_launch } from './sessions';
import { sidebar_tabs } from './tabs';
import { pdf_watch } from './pdf_watch';
import { is_pdf_uri } from './pdf_state';
import { is_pdf_tab, is_markdown_tab, is_document_tab, is_terminal_tab } from './types';
import { text_document_watch } from './text_document_watch';
import { is_markdown_link } from './markdown_state';
import { preview_kind, preview_extensions, markdown_extensions } from './preview_format';
import { marker_memory } from './marker_memory';
import { resolve_latex_pdf, reverse_sync } from './latex_preview';
import { export_filename, terminal_file, web_link } from './terminal_actions';
import { export_extensions, maximum_pdf_bytes } from './export_format';
import type {
  appearance, client_message, host_message, shell_choice, sidebar_configuration,
  sidebar_side, sidebar_tab, terminal_profile, terminal_tab,
} from './types';

const view_ids: Record<sidebar_side, string> = {
  left: 'terminalSidebar.left',
  right: 'terminalSidebar.terminals',
};
const sidebar_sides: sidebar_side[] = ['left', 'right'];
const history_character_limit = 1024 * 1024;
const output_delay_ms = 12;
type sidebar_action = 'save' | 'undo' | 'redo' | 'close' | 'add' | 'find';

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
  renderer_id?: string;
  readonly retired_renderers = new Set<string>();
  private resource_root_keys?: string[];
  configuring = false;
  configure_pending = false;
  startup_complete = false;
  tab_layout?: sidebar_tabs;
  readonly dimensions = new Map<string, { cols: number; rows: number }>();
  readonly history = new Map<string, string>();
  readonly pending_output = new Map<string, string>();
  readonly sessions: session_manager;
  readonly pdfs = new Map<string, pdf_watch>();
  readonly documents = new Map<string, text_document_watch>();
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
      on_shell_state: (id, state) => owner.receive_shell_state(this, id, state.cwd),
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    for (const subscription of this.subscriptions.splice(0)) {
      subscription.dispose();
    }
    this.view = view;
    this.ready = false;
    this.renderer_id = undefined;
    this.retired_renderers.clear();
    this.resource_root_keys = undefined;
    this.update_resource_roots();
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
          this.renderer_id = undefined;
          this.owner.set_draft_state(this, false, false, false);
        }
      }),
    );
    // Cached webview scripts can send ready immediately during window restoration.
    // Subscribe before assigning HTML so that first handshake cannot be lost.
    view.webview.html = this.owner.html(view.webview);
  }

  retire_renderer(): void {
    if (this.renderer_id) this.retired_renderers.add(this.renderer_id);
    this.ready = false;
    this.renderer_id = undefined;
  }

  /** Changing resource roots recreates the iframe in VS Code. Wait for its own handshake. */
  update_resource_roots(): boolean {
    if (!this.view) return false;
    const roots = this.owner.resource_roots(this);
    const keys = roots.map(uri => uri.toString());
    if (this.resource_root_keys?.length === keys.length
      && keys.every((key, index) => key === this.resource_root_keys?.[index])) return false;
    this.resource_root_keys = keys;
    this.retire_renderer();
    this.view.webview.options = { enableScripts: true, localResourceRoots: roots };
    return true;
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
    for (const pdf of this.pdfs.values()) pdf.dispose();
    this.pdfs.clear();
    for (const document of this.documents.values()) document.dispose();
    this.documents.clear();
    this.history.clear();
    this.pending_output.clear();
    this.dimensions.clear();
    this.view = undefined;
  }
}

class terminal_sidebar implements vscode.Disposable {
  private readonly integration = new shell_integration(vscode.env.appRoot);
  readonly views: Record<sidebar_side, sidebar_view>;
  private configuration: sidebar_configuration = { left: [], right: [] };
  private shells: shell_choice[] = [];
  private focused_side: sidebar_side = 'right';
  private save_in_progress = false;
  private rename_in_progress = false;
  private readonly pending_terminal_actions = new Set<string>();
  private shell_detection?: Promise<void>;
  private output_timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private readonly global_search: global_search_host;
  private readonly shared_markers: marker_memory;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.shared_markers = new marker_memory(
      path.join(context.globalStorageUri.fsPath, 'profile_markers'), context.globalState,
      message => this.views[this.focused_side].error(message),
    );
    this.views = {
      left: new sidebar_view('left', this, context),
      right: new sidebar_view('right', this, context),
    };
    this.global_search = new global_search_host({
      view: side => this.views[side], tabs: side => this.ensure_layout(this.views[side]).tabs,
      reveal: async (side, id) => {
        const view = this.views[side];
        const layout = this.ensure_layout(view);
        layout.select_tab(id);
        if (side === 'left') layout.set_expanded(id, true);
        view.configuring = false;
        await view.open();
        this.send_state(view);
        await this.remember_layout(view);
      },
    });
    context.subscriptions.push(this.global_search);
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
          || event.affectsConfiguration('editor.scrollbar')
          || event.affectsConfiguration('terminalSidebar.markdownFontFamily')) {
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
      for (const tab of view.tab_layout.tabs) {
        view.tab_layout.set_marker(tab.id, this.shared_markers.marker_for(view.side, tab));
      }
      void this.shared_markers.migrate(view.side, view.tab_layout.tabs).catch(() => {
        view.error('Tab marker preferences could not be shared across workspaces. Existing workspace markers are preserved.');
      });
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
      markdown_font_family: preview_font_family(),
      markdown_font_choice: read_preview_font(),
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
      for (const tab of layout.tabs) layout.set_marker(tab.id, this.shared_markers.marker_for(view.side, tab));
      if (view.update_resource_roots()) continue;
      if (view.view) {
        view.view.title = 'Side Terminals';
      }
      view.post({
        type: 'state', side: view.side, configuration: this.configuration,
        tabs: layout.tabs, sessions: view.sessions.list(),
        trusted: vscode.workspace.isTrusted, appearance: this.terminal_appearance(),
        active_id: layout.active_id, expanded_ids: layout.expanded_ids, shells: this.shells,
      });
    }
  }

  resource_roots(view: sidebar_view): vscode.Uri[] {
    const roots = [vscode.Uri.joinPath(this.context.extensionUri, 'dist')];
    for (const tab of sidebar_sides.flatMap(side => this.ensure_layout(this.views[side]).tabs)) {
      if (!is_terminal_tab(tab)) {
        // VS Code accepts descendants of roots, not a root file itself.
        roots.push(vscode.Uri.joinPath(vscode.Uri.parse(tab.uri), '..'));
      }
    }
    return [...new Map(roots.map(uri => [uri.toString(), uri])).entries()]
      .sort(([left], [right]) => left.localeCompare(right)).map(([, uri]) => uri);
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
      if (!is_terminal_tab(tab)) continue;
      const dimensions = view.dimensions.get(tab.id) ?? { cols: 80, rows: 24 };
      view.sessions.start(tab, dimensions.cols, dimensions.rows);
    }
    this.send_state(view);
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

  receive_shell_state(view: sidebar_view, id: string, cwd?: string): void {
    if (cwd && view.tab_layout?.set_cwd(id, cwd)) {
      void this.remember_layout(view);
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

  /** File previews share tab layout, but never become process launch profiles. */
  async open_preview(candidate?: unknown, side: sidebar_side = 'right', kind?: 'markdown' | 'latex'): Promise<void> {
    const view = this.views[side];
    if (!vscode.workspace.isTrusted) {
      view.error('Trust this workspace before opening a document preview.');
      return;
    }
    let uri = candidate instanceof vscode.Uri ? candidate : undefined;
    const accepts = (value: vscode.Uri): boolean => {
      const format = preview_kind(value.toString());
      return format !== undefined && (kind === undefined || format === kind);
    };
    if (!uri && vscode.window.activeTextEditor && accepts(vscode.window.activeTextEditor.document.uri)) {
      uri = vscode.window.activeTextEditor.document.uri;
    }
    if (!uri) {
      uri = (await vscode.window.showOpenDialog({
        title: 'Open preview in Side Terminals', canSelectMany: false,
        filters: kind === 'markdown' ? { Markdown: [...markdown_extensions] }
          : kind === 'latex' ? { LaTeX: ['tex'] } : { Documents: [...preview_extensions] },
        defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
      }))?.[0];
    }
    if (!uri) return;
    if (!accepts(uri)) {
      view.error('Choose a PDF, Markdown, LaTeX, HTML, CSS, JSON or JSONC file on the local or connected remote filesystem.');
      return;
    }
    try {
      const format = preview_kind(uri.toString());
      if (format === 'latex') {
        const settings = vscode.workspace.getConfiguration('latex-workshop', uri);
        const result = await resolve_latex_pdf(uri.toString(), {
          out_dir: settings.get<string>('latex.outDir', '%DIR%'),
          jobname: settings.get<string>('latex.jobname', ''),
          workspace_directory: vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath,
        });
        let pdf: string | undefined = result.pdf_uris[0];
        if (result.pdf_uris.length > 1) {
          const selected = await vscode.window.showQuickPick(result.pdf_uris.map(value => ({
            label: path.basename(vscode.Uri.parse(value).fsPath), description: vscode.Uri.parse(value).fsPath, uri: value,
          })), { title: 'Choose the compiled PDF' });
          pdf = selected?.uri;
        }
        if (pdf) await this.open_pdf(vscode.Uri.parse(pdf), side, result.root_uri);
        else if (result.pdf_uris.length === 0) {
          const choice = await vscode.window.showInformationMessage(
            'No compiled PDF found. Build with LaTeX Workshop or latexmk, then open the preview again.', 'Choose PDF…');
          if (choice === 'Choose PDF…') await this.open_pdf(undefined, side, result.root_uri);
        }
        return;
      }
      if (format === 'pdf') { await this.open_pdf(uri, side); return; }
      const layout = this.ensure_layout(view);
      const name = path.basename(uri.fsPath).slice(0, 80);
      const tab = format === 'markdown' ? layout.open_markdown(uri.toString(), name) : layout.open_document(uri.toString(), name);
      layout.set_marker(tab.id, this.shared_markers.marker_for(side, tab));
      await view.open();
      this.send_state();
      await this.remember_layout(view);
    } catch (error) {
      view.error(error instanceof Error ? error.message : 'The document preview could not be opened.');
    }
  }

  private load_text_document(view: sidebar_view, id: string): void {
    const tab = this.ensure_layout(view).tabs.find(tab => tab.id === id);
    if (!tab || (!is_markdown_tab(tab) && !is_document_tab(tab)) || !vscode.workspace.isTrusted) return;
    const markdown = is_markdown_tab(tab);
    let watcher = view.documents.get(id);
    if (!watcher) {
      const uri = vscode.Uri.parse(tab.uri);
      watcher = new text_document_watch(uri, text => {
        const webview = view.view?.webview;
        if (!webview || !view.tab_layout?.tabs.some(tab => tab.id === id)) return;
        const parent = vscode.Uri.joinPath(uri, '..');
        const base_url = `${webview.asWebviewUri(parent).toString().replace(/\/$/, '')}/`;
        view.post({ type: markdown ? 'markdown_source' : 'document_source', id, source: { text, base_url } });
      }, message => view.post({ type: markdown ? 'markdown_error' : 'document_error', id, message }),
      is_markdown_tab(tab) ? 'Markdown' : tab.format.toUpperCase());
      view.documents.set(id, watcher);
    }
    watcher.refresh();
  }

  private async open_markdown_link(view: sidebar_view, source: string, href: string): Promise<void> {
    if (!is_markdown_link(href)) return;
    const external = web_link(href);
    if (external) { await vscode.env.openExternal(vscode.Uri.parse(external)); return; }
    if (/^mailto:/i.test(href)) { await vscode.env.openExternal(vscode.Uri.parse(href)); return; }
    const base = new URL(source);
    const target = new URL(href, base);
    if (target.protocol !== base.protocol || target.host !== base.host || target.search) return;
    target.hash = '';
    const uri = vscode.Uri.parse(target.href);
    if (target.href !== base.href && preview_kind(uri.toString())) await this.open_preview(uri, view.side);
    else await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { viewColumn: vscode.ViewColumn.One, preview: true });
  }

  private async reverse_pdf_sync(view: sidebar_view, uri: string, position: Extract<client_message, { type: 'pdf_reverse_sync' }>): Promise<void> {
    const tab = view.tab_layout?.tabs.find(tab => tab.id === position.id);
    if (!tab || !is_pdf_tab(tab) || tab.uri !== uri) return;
    const key = `${view.side}:synctex`;
    if (this.pending_terminal_actions.has(key)) return;
    this.pending_terminal_actions.add(key);
    try {
      const settings = vscode.workspace.getConfiguration('latex-workshop', vscode.Uri.parse(uri));
      const location = await reverse_sync(uri, position.page, position.x, position.y, {
        synctex_path: settings.get<string>('synctex.path', 'synctex'),
        root_uri: tab.source_uri,
      });
      if (this.disposed || !view.tab_layout?.tabs.some(tab => tab.id === position.id)) return;
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(location.uri));
      const line = Math.min(location.line - 1, Math.max(0, document.lineCount - 1));
      const column = Math.min(location.column - 1, document.lineAt(line).text.length);
      await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One,
        selection: new vscode.Range(line, column, line, column), preview: true });
    } catch (error) {
      view.error(error instanceof Error ? error.message : 'SyncTeX could not locate the source. Build with -synctex=1 and try again.');
    } finally {
      this.pending_terminal_actions.delete(key);
    }
  }

  async open_pdf(candidate?: unknown, side: sidebar_side = 'right', source_uri?: string): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      this.views[side].error('Trust this workspace before opening a PDF preview.');
      return;
    }
    let uri = candidate instanceof vscode.Uri ? candidate : undefined;
    if (!uri) {
      const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
      uri = (await vscode.window.showOpenDialog({
        title: 'Open PDF in Side Terminal', canSelectMany: false, filters: { PDF: ['pdf'] },
        defaultUri: workspace ? vscode.Uri.joinPath(workspace, '.output') : undefined,
      }))?.[0];
    }
    if (!uri) return;
    if (!is_pdf_uri(uri.toString())) {
      this.views[side].error('Choose a PDF on the local or connected remote filesystem.');
      return;
    }
    const view = this.views[side];
    const layout = this.ensure_layout(view);
    const tab = layout.open_pdf(uri.toString(), path.basename(uri.fsPath).slice(0, 80), source_uri);
    layout.set_marker(tab.id, this.shared_markers.marker_for(side, tab));
    await view.open();
    this.send_state();
    await this.remember_layout(view);
  }

  private load_pdf(view: sidebar_view, id: string): void {
    const tab = this.ensure_layout(view).tabs.find(tab => tab.id === id);
    if (!tab || !is_pdf_tab(tab) || !vscode.workspace.isTrusted) return;
    let watcher = view.pdfs.get(id);
    if (!watcher) {
      const uri = vscode.Uri.parse(tab.uri);
      watcher = new pdf_watch(uri, () => {
        const webview = view.view?.webview;
        if (!webview || !view.tab_layout?.tabs.some(tab => tab.id === id)) return;
        const url = webview.asWebviewUri(uri).with({ query: `revision=${Date.now()}` }).toString();
        view.post({ type: 'pdf_source', id, url });
      }, message => view.post({ type: 'pdf_error', id, message }));
      view.pdfs.set(id, watcher);
    }
    watcher.refresh();
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
    layout.set_marker(tab.id, this.shared_markers.marker_for(side, tab));
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
    if (message.type === 'search_catalog' || message.type === 'search_read' || message.type === 'search_snapshot' || message.type === 'search_reveal') {
      await this.global_search.receive(view.side, message);
      return;
    }
    if (message.type === 'ready') {
      if (message.renderer_id && view.retired_renderers.has(message.renderer_id)) return;
      const new_renderer = !view.ready || (message.renderer_id !== undefined
        && message.renderer_id !== view.renderer_id);
      if (new_renderer) {
        // Pending output is already in history. Deliver it only through this replay.
        view.retire_renderer();
        this.flush_output();
      }
      view.ready = true;
      view.renderer_id = message.renderer_id;
      this.ensure_layout(view);
      if (view.configure_pending || (new_renderer && view.configuring)) {
        view.configure_pending = false;
        view.post({ type: 'configure' });
      }
      this.send_state(view);
      if (!view.ready) return;
      if (new_renderer) {
        for (const [id, data] of view.history) {
          view.post({ type: 'output', id, data });
        }
        this.start_side(view);
      }
      this.global_search.ready(view.side);
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
    if (message.type === 'open_preview') {
      await this.open_preview(undefined, view.side);
      return;
    }
    if (message.type === 'open_pdf') {
      await this.open_pdf(undefined, view.side);
      return;
    }
    if (message.type === 'configure') {
      await this.configure();
      return;
    }
    if (message.type === 'open_other_sidebar') {
      await this.open(view.side === 'left' ? 'right' : 'left');
      return;
    }
    if (message.type === 'copy') {
      await vscode.env.clipboard.writeText(message.text);
      return;
    }
    const layout = this.ensure_layout(view);
    if (message.type === 'close_all_tabs') {
      await this.close_all_tabs(view);
      return;
    }
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
        await this.close_tab(view, tab.id);
        return;
      case 'save_document':
        await this.save_document(view, tab);
        return;
      case 'request_rename':
        await this.request_rename(view, tab.id);
        return;
      case 'rename_tab':
        if (layout.rename_tab(tab.id, message.name)) {
          this.send_state(view);
          await this.remember_layout(view);
        }
        return;
      case 'set_tab_marker':
        try { await this.shared_markers.set(view.side, tab, message.marker); }
        catch {
          view.error('The tab marker could not be saved. Check access to VS Code extension storage and try again.');
          return;
        }
        if (layout.set_marker(tab.id, message.marker)) {
          this.send_state();
          await this.remember_layout(view);
        }
        return;
      case 'move_tab':
        if (layout.move_tab(tab.id, message.target_id, message.placement)) {
          this.send_state(view);
          await this.remember_layout(view);
        }
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
      case 'set_preview_font':
        if (is_markdown_tab(tab)) {
          await set_preview_font(message.font);
          this.send_state();
        }
        return;
      case 'load_markdown':
        if (is_markdown_tab(tab)) this.load_text_document(view, tab.id);
        return;
      case 'load_document':
        if (is_document_tab(tab)) this.load_text_document(view, tab.id);
        return;
      case 'document_position':
        if (layout.set_document_position(tab.id, message.position)) await this.remember_layout(view);
        return;
      case 'open_document_link':
        if (is_document_tab(tab) && vscode.workspace.isTrusted) await this.open_markdown_link(view, tab.uri, message.href);
        return;
      case 'markdown_position':
        if (layout.set_markdown_position(tab.id, message.position)) await this.remember_layout(view);
        return;
      case 'open_markdown_link':
        if (is_markdown_tab(tab) && vscode.workspace.isTrusted) await this.open_markdown_link(view, tab.uri, message.href);
        return;
      case 'pdf_reverse_sync':
        if (is_pdf_tab(tab) && vscode.workspace.isTrusted) await this.reverse_pdf_sync(view, tab.uri, message);
        return;
      case 'focus':
        if (view.view?.visible && !view.configuring
          && (view.side === 'left' ? layout.expanded_ids.includes(tab.id) : layout.active_id === tab.id)) {
          this.focused_side = view.side;
          layout.select_tab(tab.id);
          await this.remember_layout(view);
        }
        return;
      case 'load_pdf':
        this.load_pdf(view, tab.id);
        return;
      case 'pdf_position':
        if (layout.set_pdf_position(tab.id, message.position)) await this.remember_layout(view);
        return;
      case 'export': {
        if (!is_terminal_tab(tab)) return;
        const format = message.format ?? 'text';
        const bytes = Buffer.from(message.text, format === 'pdf' ? 'base64' : 'utf8');
        if (format === 'pdf' && (bytes.length > maximum_pdf_bytes || bytes.subarray(0, 5).toString('ascii') !== '%PDF-')) return;
        const labels = { html: 'HTML', pdf: 'PDF', markdown: 'Markdown', text: 'Plain text' };
        const destination = await vscode.window.showSaveDialog({
          title: `Export terminal · ${labels[format]}`,
          defaultUri: vscode.Uri.file(path.join(operating_system.homedir(), export_filename(tab.name, format))),
          filters: { [`${labels[format]} files`]: [export_extensions[format]] },
        });
        if (destination) {
          await vscode.workspace.fs.writeFile(destination, bytes);
          if (format === 'html') {
            const choice = await vscode.window.showInformationMessage(
              'HTML saved. Open it in a browser, then use Print → Save as PDF. Enable background graphics to retain colours.',
              'Open in browser',
            );
            if (choice === 'Open in browser' && destination.scheme === 'file') {
              await vscode.env.openExternal(destination);
            }
          }
        }
        return;
      }
    }
    if (!is_terminal_tab(tab)) return;
    if (!vscode.workspace.isTrusted) {
      view.error('Trust this workspace before starting or using a terminal.');
      return;
    }
    const surface_visible = view.view?.visible && !view.configuring
      && (view.side === 'left' ? layout.expanded_ids.includes(tab.id) : layout.active_id === tab.id);
    switch (message.type) {
      case 'open_link': {
        const uri = web_link(message.uri);
        if (uri) await vscode.env.openExternal(vscode.Uri.parse(uri));
        break;
      }
      case 'open_file': {
        const cwd = view.sessions.shell_state(tab.id)?.cwd ?? this.working_directory(tab);
        const file = terminal_file(message.path, cwd);
        if (!file) break;
        try {
          // Preserve the remote extension host's URI authority when appropriate.
          const workspace_uri = vscode.workspace.workspaceFolders?.[0]?.uri;
          const file_uri = vscode.Uri.file(file);
          const uri = workspace_uri && workspace_uri.scheme !== 'file'
            ? workspace_uri.with({ path: file_uri.path }) : file_uri;
          const document = await vscode.workspace.openTextDocument(uri);
          const line = Math.min(message.line - 1, Math.max(0, document.lineCount - 1));
          const column = Math.min((message.column ?? 1) - 1, document.lineAt(line).text.length);
          await vscode.window.showTextDocument(document, { selection: new vscode.Range(line, column, line, column), preview: true });
        } catch {
          view.error('The linked file could not be opened. Check the path and terminal working directory.');
        }
        break;
      }
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

  private async close_tab(view: sidebar_view, id: string): Promise<void> {
    const key = `${view.side}:${id}`;
    if (this.pending_terminal_actions.has(key)) return;
    this.pending_terminal_actions.add(key);
    try {
      if (view.sessions.get(id)?.status === 'running') {
        const state = view.sessions.shell_state(id)?.command_state ?? 'unknown';
        if (state !== 'idle') {
          const choice = await vscode.window.showWarningMessage(
            state === 'running'
              ? 'Close this terminal? A command is still running and will be stopped.'
              : 'Close this terminal? Its process will end. Shell integration cannot confirm that it is idle.',
            { modal: true }, 'Close terminal',
          );
          if (choice !== 'Close terminal') return;
        }
      }
      if (this.disposed || !view.tab_layout?.tabs.some(tab => tab.id === id)) return;
      this.remove_tab(view, id);
      this.send_state(view);
      await this.remember_layout(view);
    } finally {
      this.pending_terminal_actions.delete(key);
    }
  }

  private remove_tab(view: sidebar_view, id: string): void {
    view.tab_layout?.close_tab(id);
    view.sessions.remove(id);
    view.pdfs.get(id)?.dispose();
    view.pdfs.delete(id);
    view.documents.get(id)?.dispose();
    view.documents.delete(id);
    view.history.delete(id);
    view.pending_output.delete(id);
    view.dimensions.delete(id);
  }

  private async close_all_tabs(view: sidebar_view): Promise<void> {
    const layout = this.ensure_layout(view);
    const ids = layout.tabs.map(tab => tab.id);
    const keys = ids.map(id => `${view.side}:${id}`);
    if (!ids.length || keys.some(key => this.pending_terminal_actions.has(key))) return;
    keys.forEach(key => this.pending_terminal_actions.add(key));
    try {
      const busy = ids.some(id => view.sessions.get(id)?.status === 'running'
        && view.sessions.shell_state(id)?.command_state !== 'idle');
      if (busy) {
        const choice = await vscode.window.showWarningMessage(
          'Close all open tabs in this side bar? Some terminals may have running commands. Their processes will be stopped.',
          { modal: true }, 'Close all tabs',
        );
        if (choice !== 'Close all tabs') return;
      }
      if (this.disposed || view.tab_layout !== layout) return;
      // Only close the captured tabs: a tab opened while confirmation was visible stays open.
      for (const id of ids) this.remove_tab(view, id);
      this.send_state(view);
      await this.remember_layout(view);
    } finally {
      keys.forEach(key => this.pending_terminal_actions.delete(key));
    }
  }

  private async save_document(view: sidebar_view, tab: sidebar_tab): Promise<void> {
    if (is_terminal_tab(tab) || !vscode.workspace.isTrusted) return;
    const key = `${view.side}:${tab.id}`;
    if (this.pending_terminal_actions.has(key)) return;
    this.pending_terminal_actions.add(key);
    const layout = view.tab_layout;
    try {
      const source = vscode.Uri.parse(tab.uri);
      const extension = path.posix.extname(source.path);
      const filename = path.posix.basename(source.path, extension);
      const target = await vscode.window.showSaveDialog({
        title: 'Save a copy', saveLabel: 'Save copy',
        defaultUri: vscode.Uri.joinPath(source, '..', `${filename}_copy${extension}`),
      });
      if (!target || this.disposed || !vscode.workspace.isTrusted || view.tab_layout !== layout
        || !layout?.tabs.some(item => item.id === tab.id)) return;
      if (source.toString() === target.toString()) {
        view.error('Choose a different filename to save a copy.');
        return;
      }
      await vscode.workspace.fs.copy(source, target, { overwrite: true });
    } catch {
      view.error('The document could not be copied. Check the source file and destination permissions.');
    } finally {
      this.pending_terminal_actions.delete(key);
    }
  }

  private async request_rename(view: sidebar_view, id: string): Promise<void> {
    // VS Code shares one Quick Input surface across both sidebars.
    if (this.rename_in_progress) {
      return;
    }
    const layout = this.ensure_layout(view);
    const tab = layout.tabs.find(item => item.id === id);
    if (!tab) {
      return;
    }
    this.rename_in_progress = true;
    try {
      const name = await vscode.window.showInputBox({
        title: 'Rename terminal',
        value: tab.name,
        valueSelection: [0, tab.name.length],
        ignoreFocusOut: true,
        validateInput: value => is_tab_name(value)
          ? undefined : 'Enter a name of 1–80 characters without control characters.',
      });
      // Runtime IDs are never reused within a layout. Do not revive a closed tab
      // or overwrite a newer rename while this input was awaiting a response.
      const current_tab = view.tab_layout?.tabs.find(item => item.id === id);
      if (this.disposed || view.tab_layout !== layout || current_tab?.name !== tab.name || !is_tab_name(name)) {
        return;
      }
      if (layout.rename_tab(id, name)) {
        this.send_state(view);
        await this.remember_layout(view);
      }
    } finally {
      this.rename_in_progress = false;
    }
  }

  private async restart_tab(view: sidebar_view, id: string, column_count: number, row_count: number): Promise<void> {
    const key = `${view.side}:${id}`;
    if (this.pending_terminal_actions.has(key)) return;
    this.pending_terminal_actions.add(key);
    try {
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
      if (is_pdf_tab(tab)) { this.load_pdf(view, id); return; }
      if (is_markdown_tab(tab) || is_document_tab(tab)) { this.load_text_document(view, id); return; }
      view.sessions.remove(id);
      view.history.delete(id);
      view.pending_output.delete(id);
      view.post({ type: 'reset', id });
      view.sessions.start(tab, column_count, row_count);
    } finally {
      this.pending_terminal_actions.delete(key);
    }
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
        throw new Error('Startup settings changed elsewhere. Your draft is intact. Copy any edits you want to keep, then Cancel and reopen configuration to load the latest settings.');
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

  launch_options(profile: terminal_profile & Pick<terminal_tab, 'cwd'>): session_launch {
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
    const native_profile = !profile.shell.trim() && profile_name ? native_profiles[profile_name] : undefined;
    let default_profile: shell_options['default_profile'];
    if (native_profile?.path) {
      default_profile = {
        ...native_profile,
        path: Array.isArray(native_profile.path)
          ? native_profile.path.map(expand_path) : expand_path(native_profile.path),
      };
    } else if (native_profile?.source === 'PowerShell') {
      const powershell = resolve_shell('powershell', {
        env: environment_variables, profile_env: { ...native_profile.env, ...profile.env },
      });
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
    const resolved = resolve_shell(expand_path(profile.shell), {
      env: environment_variables, default_profile, profile_args: profile.args, profile_env: profile.env,
    });
    return this.integration.prepare({ ...resolved, cwd: this.working_directory(profile) },
      settings.get<boolean>('shellIntegration.enabled', true));
  }

  private working_directory(profile: Pick<terminal_tab, 'cwd'>): string {
    const is_directory = (folder: string): boolean => {
      try { return path.isAbsolute(folder) && stat_sync(folder).isDirectory(); } catch { return false; }
    };
    const candidates = [profile.cwd, ...(vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [])];
    return candidates.find((folder): folder is string => Boolean(folder && is_directory(folder)))
      ?? operating_system.homedir();
  }

  html(webview: vscode.Webview): string {
    const nonce = random_bytes(18).toString('base64');
    const stylesheet = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css'));
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'));
    const pdf_assets = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'pdfjs')).toString();
    const version = String(this.context.extension?.packageJSON?.version ?? '').replace(/[^0-9A-Za-z.+-]/g, '');
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="pdf-assets" content="${pdf_assets}"><meta name="extension-version" content="${version}"><meta name="webview-csp-source" content="${webview.cspSource}"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src 'self'; script-src 'nonce-${nonce}' ${webview.cspSource} 'wasm-unsafe-eval'; worker-src ${webview.cspSource} blob:; style-src ${webview.cspSource} data: 'unsafe-inline'; font-src ${webview.cspSource} blob: data:; img-src ${webview.cspSource} data: blob:; connect-src ${webview.cspSource};"><link rel="stylesheet" href="${stylesheet}"><title>Terminal Sidebar</title></head><body><div id="app"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }

  dispose(): void {
    this.disposed = true;
    if (this.output_timer) {
      clearTimeout(this.output_timer);
    }
    for (const view of Object.values(this.views)) {
      view.dispose();
    }
    this.integration.dispose();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new terminal_sidebar(context);
  const about = new about_panel(context);
  const usage = new usage_panel(context);
  context.subscriptions.push(provider, about, usage,
    vscode.commands.registerCommand('terminalSidebar.usage', () => usage.show()),
    vscode.commands.registerCommand('terminalSidebar.about', () => about.show()));
  for (const side of sidebar_sides) {
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(view_ids[side], provider.views[side], {
        webviewOptions: { retainContextWhenHidden: true },
      }),
      vscode.commands.registerCommand(`terminalSidebar.${side}.configure`, () => provider.configure()),
      vscode.commands.registerCommand(`terminalSidebar.${side}.restart`, () => provider.restart_active(side)),
      vscode.commands.registerCommand(`terminalSidebar.${side}.selectProfile`, () => provider.open_profile(undefined, side)),
      vscode.commands.registerCommand(`terminalSidebar.${side}.openPdf`, () => provider.open_pdf(undefined, side)),
      vscode.commands.registerCommand(`terminalSidebar.${side}.openPreview`, () => provider.open_preview(undefined, side)),
    );
    for (const action of ['save', 'undo', 'redo', 'close', 'add', 'find'] as const) {
      context.subscriptions.push(vscode.commands.registerCommand(
        `terminalSidebar.${side}.${action}`, () => provider.action(side, action),
      ));
    }
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('terminalSidebar.openPreview', (uri?: vscode.Uri) => provider.open_preview(uri)),
    vscode.commands.registerCommand('terminalSidebar.openMarkdown', (uri?: vscode.Uri) => provider.open_preview(uri, 'right', 'markdown')),
    vscode.commands.registerCommand('terminalSidebar.openLatex', (uri?: vscode.Uri) => provider.open_preview(uri, 'right', 'latex')),
    vscode.commands.registerCommand('terminalSidebar.openPdf', (uri?: vscode.Uri) => provider.open_pdf(uri)),
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
