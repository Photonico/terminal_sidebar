import { global_search } from './global_search';
import { snapshot_terminal, reveal_terminal } from './terminal_text';
import type { search_location } from '../src/global_search_protocol';
import { Terminal, type ITheme, type IDisposable } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { configuration_draft } from '../src/draft';
import { tab_reordering } from './reordering';
import { terminal_menu } from './menu';
import { tab_actions } from './tab_actions';
import { tab_rename } from './rename';
import { terminal_search, is_find_shortcut } from './search';
import { create_tab_marker, tab_marker_picker } from './tab_marker';
import { terminal_indicator, show_tab_indicator, indicator_label, tab_completion_tracker } from './status';
import { install_terminal_links } from './terminal_links';
import { terminal_text, terminal_html, terminal_markdown } from './export';
import { terminal_pdf } from './pdf_export';
import { pdf_view } from './pdf_view';
import { document_view } from './document_view';
import { markdown_view } from './markdown_view';
import { startup_handshake } from './startup_handshake';
import { hover_hints } from './hover_hint';
import { is_terminal_tab, is_pdf_tab, is_markdown_tab, is_document_tab, type sidebar_tab } from '../src/types';
import { is_export_payload } from '../src/export_format';
import type {
  appearance as terminal_appearance,
  client_message,
  host_message,
  session_info,
  shell_choice,
  sidebar_configuration,
  sidebar_side,
  terminal_profile,
  terminal_tab,
  export_format,
} from '../src/types';
import '@xterm/xterm/css/xterm.css';
import '@vscode/codicons/dist/codicon.css';
import './main.css';
import './search.css';

declare function acquireVsCodeApi(): { postMessage(message: client_message): void };

const vscode = acquireVsCodeApi();
const is_mac = /Mac|iPhone|iPad/.test(navigator.platform);
const maximum_profiles = 32;
const icons = {
  add: '<path d="M8 3v10M3 8h10"/>',
  restart: '<path d="M3.1 5.1a5.5 5.5 0 1 1-.6 5.1M3 1.8v3.8h3.8"/>',
  close: '<path d="m4 4 8 8M4 12l8-8"/>',
  save: '<path d="M3 2h8l3 3v9H2V2Zm2 0v4h5V2M5 14V9h6v5"/>',
  undo: '<path d="M6 3 2 7l4 4M2 7h7a4 4 0 0 1 4 4v2"/>',
  redo: '<path d="m10 3 4 4-4 4m4-4H7a4 4 0 0 0-4 4v2"/>',
  chevron: '<path d="m6 3 5 5-5 5"/>',
  warning: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5v4M8 11v.1"/>',
};

function send(message: client_message): void {
  vscode.postMessage(message);
}

const renderer_id = crypto.randomUUID();
const handshake = new startup_handshake(() => send({ type: 'ready', renderer_id }));

function icon(name: keyof typeof icons): string {
  return `<svg viewBox="0 0 16 16" aria-hidden="true">${icons[name]}</svg>`;
}

const app = document.getElementById('app') ?? document.body.appendChild(document.createElement('div'));
app.id = 'app';
app.innerHTML = `
  <header id="terminal-header">
    <div id="terminal-tabs" role="tablist" aria-label="Open tabs"></div>
    <span id="left-heading">Terminals</span>
    <div id="tab-actions"></div>
    <div id="configuration-toolbar" role="toolbar" aria-label="Configuration actions" hidden>
      <button id="save-action" class="icon-button" type="button" aria-label="Save startup configuration" title="Save startup configuration">${icon('save')}</button>
      <button id="undo-action" class="icon-button" type="button" aria-label="Undo configuration change" title="Undo configuration change">${icon('undo')}</button>
      <button id="redo-action" class="icon-button" type="button" aria-label="Redo configuration change" title="Redo configuration change">${icon('redo')}</button>
      <button id="close-action" class="icon-button" type="button" aria-label="Cancel configuration changes" title="Cancel configuration changes">${icon('close')}</button>
    </div>
  </header>
  <div id="error-banner" role="alert" aria-atomic="true" hidden><span id="error-icon" aria-hidden="true">${icon('warning')}</span><span id="error-message"></span><button id="dismiss-error" title="Dismiss error" type="button" aria-label="Dismiss error">×</button></div>
  <main id="terminal-content">
    <div id="trust-panel" class="empty-panel" hidden><p>Trust this workspace to run terminals.</p><button id="trust-button" title="Manage workspace trust" class="primary" type="button">Manage Workspace Trust</button></div>
    <div id="empty-panel" class="empty-panel" hidden>
      <p>No open terminals. Your startup configuration is unchanged.</p>
      <button id="add-first-tab" title="New terminal · Right-click for terminal or document preview" class="primary" type="button">New terminal</button>
      <button id="open-other-sidebar" class="secondary" type="button">Open primary side bar terminals</button>
      <button id="configure-empty" title="Configure startup terminals" class="secondary" type="button">Configure startup terminals</button>
    </div>
    <div id="terminal-host"></div>
  </main>
  <footer id="session-status" role="status" aria-live="polite"><span id="status-badge"><span id="status-dot"></span><span id="status-text">Loading terminals…</span></span></footer>
  <section id="configuration" aria-labelledby="configuration-title" hidden>
    <div class="configuration-heading"><h2 id="configuration-title">Startup terminals</h2><button id="refresh-shells" class="icon-button" type="button" aria-label="Detect shells again" title="Detect shells again">${icon('restart')}</button></div>
    <p class="configuration-intro">These profiles open at startup. Closing or adding a terminal during use does not change them. Blank Shell uses the default; keep secrets out of synced commands.</p>
    <form id="profile-form" novalidate>
      <div id="profile-groups"></div>
      <div class="configuration-actions"><button id="save-profiles" title="Save startup configuration" class="primary" type="submit">Save</button><button id="cancel-configuration" title="Discard configuration changes" class="secondary" type="button">Cancel</button><button id="return_to_terminals" title="Return to terminals and keep the configuration draft" class="secondary" type="button">Return to terminals</button></div>
    </form>
  </section>`;

new hover_hints();

function element<element_type extends HTMLElement = HTMLElement>(id: string): element_type {
  const found = document.getElementById(id);
  if (!found) {
    throw new Error(`Missing UI element: ${id}`);
  }
  return found as element_type;
}

const tab_strip = element('terminal-tabs');
const terminal_host = element('terminal-host');
const terminal_content = element('terminal-content');
const configuration_panel = element('configuration');
const profile_groups = element('profile-groups');
const status_bar = element('session-status');
const error_banner = element('error-banner');
const save_button = element<HTMLButtonElement>('save-profiles');

interface sidebar_pane {
  pane: HTMLDivElement;
  section?: HTMLElement;
  section_button?: HTMLButtonElement;
  section_label?: HTMLSpanElement;
  child_actions?: tab_actions;
}

interface terminal_view extends sidebar_pane {
  terminal: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  serialize: SerializeAddon;
  links: IDisposable;
  pane: HTMLDivElement;
  section?: HTMLElement;
  section_button?: HTMLButtonElement;
  section_label?: HTMLSpanElement;
}

const terminal_views = new Map<string, terminal_view>();
const pdf_views = new Map<string, pdf_view>();
const markdown_views = new Map<string, markdown_view>();
const document_views = new Map<string, document_view>();
const sessions = new Map<string, session_info>();
const activated_views = new Set<string>();
const unread_tabs = new Set<string>();
const tab_completions = new tab_completion_tracker();
let exporting = false;
const custom_shells = new Set<string>();
const configuration_group_expanded: Record<sidebar_side, boolean> = { left: true, right: true };
const draft = new configuration_draft();
let startup_configuration: sidebar_configuration = { left: [], right: [] };
let open_tabs: sidebar_tab[] = [];
let side: sidebar_side = 'right';
let active_id: string | undefined;
let expanded_ids = new Set<string>();
let trusted = false;
let received_state = false;
let configuring = false;
let saving = false;
let name_validation_error = false;
let shells: shell_choice[] = [];
let last_draft_state = '';
let focused_terminal: string | undefined;
let fit_frame = 0;
let pending_focus: { operation: 'add' | 'close'; id?: string; previous_ids: Set<string> } | undefined;
let appearance: terminal_appearance = {
  font_family: 'monospace', font_size: 13, cursor_blink: false, scrollback: 1000,
  editor_scrollbar_vertical: 'auto', editor_scrollbar_horizontal: 'auto',
  editor_scrollbar_vertical_size: 14, editor_scrollbar_horizontal_size: 12,
};

const action_menu = new terminal_menu();
const header_actions = create_tab_actions(() => active_id);
element('tab-actions').append(header_actions.root);
let menu_tab_id: string | undefined;
const rename_editor = new tab_rename({
  anchor: id => document.getElementById(`${side === 'left' ? 'section' : 'tab'}-${id}`) ?? undefined,
  commit: (id, name) => send({ type: 'rename_tab', id, name }),
  finished: id => focus_terminal(id),
});
const marker_picker = new tab_marker_picker({
  anchor: id => document.getElementById(`${side === 'left' ? 'section' : 'tab'}-${id}`) ?? undefined,
  commit: (id, marker) => send({ type: 'set_tab_marker', id, marker }),
  inactive_foreground: () => side === 'left'
    ? 'var(--vscode-sideBarSectionHeader-foreground, var(--view-foreground))'
    : 'var(--vscode-tab-inactiveForeground, var(--view-foreground))',
  finished: id => document.getElementById(`${side === 'left' ? 'section' : 'tab'}-${id}`)?.focus(),
});
let global_find_mode = false;
const all_tabs_search = new global_search(send);
terminal_content.insertBefore(all_tabs_search.root, terminal_host);
const pending_search_reveals = new Map<string, search_location>();
const find_widget = new terminal_search({
  parent: terminal_content,
  before: terminal_host,
  target: () => {
    if (global_find_mode && trusted && !configuring) return { id: 'all_open_tabs', search: all_tabs_search };
    const view = active_id && trusted && !configuring
      ? terminal_views.get(active_id) ?? pdf_views.get(active_id) ?? markdown_views.get(active_id) ?? document_views.get(active_id) : undefined;
    return view && active_id ? { id: active_id, search: view.search } : undefined;
  },
  focus: id => { const target = id === 'all_open_tabs' ? active_id : id; if (target) focus_terminal(target); },
  layout: schedule_fit,
  closed: () => { all_tabs_search.end(); global_find_mode = false; },
});

const reorder_controllers = (['left', 'right'] as const).map(sidebar => new tab_reordering({
  container: sidebar === 'left' ? terminal_host : tab_strip,
  axis: sidebar === 'left' ? 'vertical' : 'horizontal',
  get_ids: () => open_tabs.map(tab => tab.id),
  enabled: () => side === sidebar && trusted && !configuring && !saving && !rename_editor.editing,
  move: (id, target_id, placement) => {
    send({ type: 'move_tab', id, target_id, placement });
  },
}));

/** Resolve the same terminal colours for xterm and the selected tab. */
function terminal_theme(): ITheme {
  const styles = getComputedStyle(document.body);
  const colour = (name: string, fallback?: string): string | undefined => {
    return styles.getPropertyValue(`--vscode-${name}`).trim() || fallback;
  };
  const dark = !document.body.classList.contains('vscode-light') && !document.body.classList.contains('vscode-high-contrast-light');
  return {
    background: colour('terminal-background', colour('editor-background', dark ? '#1e1e1e' : '#ffffff')),
    foreground: colour('terminal-foreground', colour('foreground', dark ? '#cccccc' : '#333333')),
    cursor: colour('terminalCursor-foreground', colour('terminal-foreground', dark ? '#cccccc' : '#333333')),
    cursorAccent: colour('terminalCursor-background', colour('editor-background', dark ? '#1e1e1e' : '#ffffff')),
    selectionBackground: colour('terminal-selectionBackground', dark ? '#ffffff40' : '#00000030'),
    selectionInactiveBackground: colour('terminal-inactiveSelectionBackground', dark ? '#ffffff20' : '#00000018'),
    scrollbarSliderBackground: colour('scrollbarSlider-background'),
    scrollbarSliderHoverBackground: colour('scrollbarSlider-hoverBackground'),
    scrollbarSliderActiveBackground: colour('scrollbarSlider-activeBackground'),
    black: colour('terminal-ansiBlack'), red: colour('terminal-ansiRed'), green: colour('terminal-ansiGreen'),
    yellow: colour('terminal-ansiYellow'), blue: colour('terminal-ansiBlue'), magenta: colour('terminal-ansiMagenta'),
    cyan: colour('terminal-ansiCyan'), white: colour('terminal-ansiWhite'),
    brightBlack: colour('terminal-ansiBrightBlack'), brightRed: colour('terminal-ansiBrightRed'),
    brightGreen: colour('terminal-ansiBrightGreen'), brightYellow: colour('terminal-ansiBrightYellow'),
    brightBlue: colour('terminal-ansiBrightBlue'), brightMagenta: colour('terminal-ansiBrightMagenta'),
    brightCyan: colour('terminal-ansiBrightCyan'), brightWhite: colour('terminal-ansiBrightWhite'),
  };
}

function update_appearance(): void {
  const theme = terminal_theme();
  // Set this on #app, outside the theme observer, to avoid a mutation loop.
  app.style.setProperty('--view-background', theme.background ?? '#1e1e1e');
  app.style.setProperty('--terminal-foreground', theme.foreground ?? '#cccccc');
  app.style.setProperty('--terminal_font_family', appearance.font_family);
  if (appearance.markdown_font_family) app.style.setProperty('--markdown_font_family', appearance.markdown_font_family);
  else app.style.removeProperty('--markdown_font_family');
  for (const view of markdown_views.values()) view.set_font(appearance.markdown_font_choice ?? 'default');
  app.dataset.verticalScrollbar = appearance.editor_scrollbar_vertical_size === 0 ? 'hidden' : appearance.editor_scrollbar_vertical;
  app.dataset.horizontalScrollbar = appearance.editor_scrollbar_horizontal_size === 0 ? 'hidden' : appearance.editor_scrollbar_horizontal;
  app.style.setProperty('--scrollbar-vertical-size', `${app.dataset.verticalScrollbar === 'hidden' ? 0 : appearance.editor_scrollbar_vertical_size}px`);
  app.style.setProperty('--scrollbar-horizontal-size', `${app.dataset.horizontalScrollbar === 'hidden' ? 0 : appearance.editor_scrollbar_horizontal_size}px`);
  for (const { terminal } of terminal_views.values()) {
    terminal.options.fontFamily = appearance.font_family;
    terminal.options.fontSize = appearance.font_size;
    terminal.options.cursorBlink = appearance.cursor_blink;
    terminal.options.scrollback = appearance.scrollback;
    terminal.options.theme = theme;
    terminal.options.overviewRuler = terminal_scrollbar_options();
  }
  schedule_fit();
}

/** xterm and FitAddon share this public width option. Zero would select xterm's
 *  default width, so a hidden scrollbar retains a one-pixel, themed reservation. */
function terminal_scrollbar_options(): { width: number; showTopBorder: boolean; showBottomBorder: boolean } {
  const hidden = appearance.editor_scrollbar_vertical === 'hidden' || appearance.editor_scrollbar_vertical_size === 0;
  return {
    width: hidden ? 1 : appearance.editor_scrollbar_vertical_size,
    showTopBorder: false,
    showBottomBorder: false,
  };
}

function is_visible_tab(id: string): boolean {
  if (configuring || !trusted || document.hidden) {
    return false;
  }
  return side === 'left' ? expanded_ids.has(id) : active_id === id;
}

function ensure_terminal(tab: terminal_tab): terminal_view {
  const existing = terminal_views.get(tab.id);
  if (existing) {
    existing.pane.setAttribute('aria-label', tab.name);
    return existing;
  }

  const pane = document.createElement('div');
  pane.id = `terminal-${tab.id}`;
  pane.className = 'terminal-pane';
  pane.setAttribute('role', side === 'left' ? 'region' : 'tabpanel');
  pane.setAttribute('aria-label', tab.name);
  pane.hidden = !is_visible_tab(tab.id);
  pane.addEventListener('focusin', () => {
    if (!trusted) {
      return;
    }
    if (active_id !== tab.id) {
      select_tab(tab.id);
    }
    clear_unread(tab.id);
    if (focused_terminal !== tab.id) {
      focused_terminal = tab.id;
      send({ type: 'focus', id: tab.id });
    }
  });
  pane.addEventListener('focusout', event => {
    if (!pane.contains(event.relatedTarget as Node | null)) {
      focused_terminal = undefined;
    }
  });
  terminal_host.append(pane);

  const terminal = new Terminal({
    fontFamily: appearance.font_family,
    fontSize: appearance.font_size,
    cursorBlink: appearance.cursor_blink,
    scrollback: appearance.scrollback,
    screenReaderMode: false,
    // Unicode11 and search decorations use xterm's documented proposed APIs.
    allowProposedApi: true,
    theme: terminal_theme(),
    overviewRuler: terminal_scrollbar_options(),
    convertEol: false,
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  const serialize = new SerializeAddon();
  terminal.loadAddon(fit);
  terminal.loadAddon(search);
  terminal.loadAddon(serialize);
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = '11';
  terminal.open(pane);
  const links = install_terminal_links(terminal, is_mac,
    uri => send({ type: 'open_link', id: tab.id, uri }),
    link => send({ type: 'open_file', id: tab.id, path: link.path, line: link.line, ...(link.column === undefined ? {} : { column: link.column }) }));
  terminal.onData(data => {
    if (trusted) {
      send({ type: 'input', id: tab.id, data });
    }
  });
  terminal.onResize(({ cols, rows }) => {
    if (is_visible_tab(tab.id)) {
      send({ type: 'resize', id: tab.id, cols, rows });
    }
  });
  // A bell is terminal activity, not evidence that a command completed.
  terminal.onBell(() => {
    if (active_id !== tab.id || !is_visible_tab(tab.id) || !document.hasFocus()) {
      unread_tabs.add(tab.id);
      update_unread(tab.id);
    }
  });
  terminal.attachCustomKeyEventHandler(event => {
    if (event.type !== 'keydown') {
      return true;
    }
    const shortcut = is_mac
      ? event.metaKey && !event.ctrlKey && !event.altKey
      : event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey;
    if (!shortcut) {
      return true;
    }
    const key = event.key.toLowerCase();
    if (key !== 'c' && key !== 'v') {
      return true;
    }
    event.preventDefault();
    if (key === 'c') {
      copy_selection(tab.id);
    }
    else if (trusted) {
      send({ type: 'paste', id: tab.id });
    }
    return false;
  });

  const view = { terminal, fit, search, serialize, links, pane };
  terminal_views.set(tab.id, view);
  return view;
}

function ensure_pane(tab: sidebar_tab): sidebar_pane {
  if (is_terminal_tab(tab)) return ensure_terminal(tab);
  let view: pdf_view | markdown_view | document_view | undefined = pdf_views.get(tab.id) ?? markdown_views.get(tab.id) ?? document_views.get(tab.id);
  if (!view) {
    if (is_pdf_tab(tab)) {
      view = new pdf_view(tab, send);
      pdf_views.set(tab.id, view);
    } else if (is_document_tab(tab)) {
      view = new document_view(tab, send, () => run_action('find'));
      document_views.set(tab.id, view);
    } else {
      view = new markdown_view(tab, send);
      view.set_font(appearance.markdown_font_choice ?? 'default');
      markdown_views.set(tab.id, view);
    }
    view.pane.addEventListener('focusin', () => {
      if (active_id !== tab.id) select_tab(tab.id);
      send({ type: 'focus', id: tab.id });
    });
    terminal_host.append(view.pane);
  }
  view.pane.setAttribute('aria-label', tab.name);
  return view;
}

function set_pane_visible(id: string): void {
  const visible = is_visible_tab(id);
  const preview = pdf_views.get(id) ?? markdown_views.get(id) ?? document_views.get(id);
  if (preview) preview.set_visible(visible);
  else {
    const view = terminal_views.get(id);
    if (view) view.pane.hidden = !visible;
  }
}

/** Fit expanded left sections or the selected right tab, never a hidden pane. */
function schedule_fit(): void {
  if (fit_frame) {
    return;
  }
  fit_frame = requestAnimationFrame(() => {
    fit_frame = 0;
    if (configuring || !trusted || !terminal_host.clientWidth || !terminal_host.clientHeight) {
      return;
    }
    for (const tab of open_tabs) {
      if (!is_visible_tab(tab.id)) {
        continue;
      }
      const view = terminal_views.get(tab.id);
      if (!view || view.pane.hidden || !view.pane.clientWidth || !view.pane.clientHeight) {
        continue;
      }
      view.fit.fit();
      if (!activated_views.has(tab.id) && view.terminal.cols > 0 && view.terminal.rows > 0) {
        activated_views.add(tab.id);
        send({ type: 'activate', id: tab.id, cols: view.terminal.cols, rows: view.terminal.rows });
      }
    }
  });
}

function focus_terminal(id: string): void {
  requestAnimationFrame(() => {
    if (is_visible_tab(id)) {
      const preview = pdf_views.get(id) ?? markdown_views.get(id) ?? document_views.get(id);
      if (preview) preview.focus();
      else terminal_views.get(id)?.terminal.focus();
    } else if (!configuring) {
      document.getElementById(`${side === 'left' ? 'section' : 'tab'}-${id}`)?.focus();
    }
  });
}

/** User selection is sent once. Rendering a host selection does not send it back. */
function select_tab(id: string, focus = false): void {
  if (!open_tabs.some(tab => tab.id === id)) {
    return;
  }
  if (active_id !== id) {
    active_id = id;
    send({ type: 'select', id });
  }
  clear_unread(id);
  render_terminals();
  update_status();
  update_actions();
  schedule_fit();
  if (focus) {
    focus_terminal(id);
  }
}

function close_tab(id: string | undefined): void {
  if (!id || saving) {
    return;
  }
  if (id === active_id) {
    pending_focus = { operation: 'close', id, previous_ids: new Set() };
  }
  send({ type: 'close_tab', id });
}

function add_tab(): void {
  if (!trusted || configuring || saving) {
    return;
  }
  pending_focus = { operation: 'add', previous_ids: new Set(open_tabs.map(tab => tab.id)) };
  send({ type: 'add_tab' });
}

function create_tab_actions(target: () => string | undefined): tab_actions {
  return new tab_actions(action_menu, {
    create: add_tab,
    preview: () => { if (trusted && !saving) send({ type: 'open_preview' }); },
    find: () => {
      const id = target();
      if (!id) return;
      if (side === 'left') set_expanded(id, true); else select_tab(id);
      run_action('find');
    },
    find_all: () => { void open_global_find(); },
    close: () => close_tab(target()),
    close_all: () => { if (!saving) send({ type: 'close_all_tabs' }); },
  });
}

function request_rename(id: string | undefined): void {
  if (!id || configuring || saving || !open_tabs.some(tab => tab.id === id)) {
    return;
  }
  const tab = open_tabs.find(item => item.id === id)!;
  marker_picker.close(false);
  action_menu.close(false);
  find_widget.close(false);
  rename_editor.open(id, tab.name);
}

function restart_tab(id: string): void {
  const preview = pdf_views.get(id) ?? markdown_views.get(id) ?? document_views.get(id);
  if (trusted && preview) { preview.refresh(); return; }
  const view = terminal_views.get(id);
  if (trusted && view) {
    send({ type: 'restart', id, cols: view.terminal.cols, rows: view.terminal.rows });
    focus_terminal(id);
  }
}

function show_tab_menu(id: string, x: number, y: number): void {
  if (configuring || saving || !open_tabs.some(tab => tab.id === id)) {
    return;
  }
  rename_editor.close(false);
  marker_picker.close(false);
  menu_tab_id = id;
  const is_terminal = open_tabs.some(tab => tab.id === id && is_terminal_tab(tab));
  action_menu.show([
    { label: 'Rename', action: () => request_rename(id) },
    { label: 'Change tab marker…', action: () => {
      const tab = open_tabs.find(tab => tab.id === id);
      if (tab) marker_picker.open(id, tab.name, tab.marker);
    } },
    { label: 'Find in this tab', action: () => { select_tab(id); run_action('find'); } },
    { label: 'Find in all open tabs', action: () => { void open_global_find(); } },
    { label: is_terminal ? 'Restart' : 'Reload preview', disabled: !trusted, action: () => restart_tab(id) },
    { label: is_terminal ? 'Export…' : 'Save a copy…', disabled: !trusted, action: () => {
      if (is_terminal) export_output(id); else send({ type: 'save_document', id });
    } },
    { label: 'Close', action: () => close_tab(id) },
  ], x, y, () => document.getElementById(`${side === 'left' ? 'section' : 'tab'}-${id}`)?.focus());
}

function update_unread(id: string): void {
  acknowledge_viewed_completion(id);
  const header = document.getElementById(`${side === 'left' ? 'section' : 'tab'}-${id}`);
  const badge = header?.querySelector<HTMLElement>('.terminal_unread');
  if (badge) {
    const session = sessions.get(id);
    const status = terminal_indicator(session);
    badge.dataset.status = status;
    badge.hidden = !show_tab_indicator(session, unread_tabs.has(id), tab_completions.is_viewed(session));
    badge.title = `${indicator_label(status)}${unread_tabs.has(id) ? ' · Terminal bell' : ''}`;
    badge.setAttribute('aria-label', badge.title);
  }
}

function acknowledge_viewed_completion(id: string): void {
  if (active_id === id && is_visible_tab(id) && document.hasFocus()) {
    tab_completions.view(sessions.get(id));
  }
}

function clear_unread(id: string): void {
  unread_tabs.delete(id);
  update_unread(id);
}

function unread_badge(id: string): HTMLSpanElement {
  acknowledge_viewed_completion(id);
  const badge = document.createElement('span');
  badge.className = 'terminal_unread status_dot';
  const session = sessions.get(id);
  const status = terminal_indicator(session);
  badge.dataset.status = status;
  badge.title = `${indicator_label(status)}${unread_tabs.has(id) ? ' · Terminal bell' : ''}`;
  badge.setAttribute('aria-label', badge.title);
  badge.hidden = !show_tab_indicator(session, unread_tabs.has(id), tab_completions.is_viewed(session));
  return badge;
}

function set_expanded(id: string, expanded: boolean): void {
  if (expanded) {
    expanded_ids.add(id);
  }
  else {
    expanded_ids.delete(id);
  }
  send({ type: 'expanded', id, expanded });
  select_tab(id);
}

function attach_middle_close(button: HTMLElement, id: string): void {
  button.addEventListener('mousedown', event => {
    if (event.button === 1) {
      event.preventDefault();
    }
  });
  button.addEventListener('auxclick', event => {
    if (event.button !== 1) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    close_tab(id);
  });
}

function render_tabs(): void {
  const focused_id = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.tabId : undefined;
  tab_strip.replaceChildren(...open_tabs.map(tab => {
    const button = document.createElement('button');
    button.id = `tab-${tab.id}`;
    button.type = 'button';
    button.className = 'terminal-tab';
    button.dataset.tabId = tab.id;
    button.dataset.reorderId = tab.id;
    button.draggable = true;
    button.setAttribute('data-vscode-context', '{"preventDefaultContextMenuItems":true}');
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', `terminal-${tab.id}`);
    button.setAttribute('aria-selected', String(tab.id === active_id));
    button.tabIndex = tab.id === active_id ? 0 : -1;
    const label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = tab.name;
    if (tab.marker) button.append(create_tab_marker(tab.marker));
    button.append(unread_badge(tab.id));
    button.append(label);
    button.title = `${tab.name} · Right-click for actions · Drag to reorder · Alt+Shift+Left/Right to move · Middle-click to close`;
    button.dataset.status = sessions.get(tab.id)?.status ?? 'idle';
    button.addEventListener('click', () => select_tab(tab.id, true));
    attach_middle_close(button, tab.id);
    button.addEventListener('keydown', event => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) {
        return;
      }
      const current_index = open_tabs.findIndex(item => item.id === tab.id);
      let next_index: number;
      if (event.key === 'ArrowRight') {
        next_index = (current_index + 1) % open_tabs.length;
      }
      else if (event.key === 'ArrowLeft') {
        next_index = (current_index - 1 + open_tabs.length) % open_tabs.length;
      }
      else if (event.key === 'Home') {
        next_index = 0;
      }
      else if (event.key === 'End') {
        next_index = open_tabs.length - 1;
      }
      else if (event.key === 'Delete') {
        event.preventDefault();
        close_tab(tab.id);
        return;
      } else {
        return;
      }
      event.preventDefault();
      const next_id = open_tabs[next_index]!.id;
      select_tab(next_id);
      element(`tab-${next_id}`).focus();
    });
    return button;
  }));
  if (focused_id && open_tabs.some(tab => tab.id === focused_id)) {
    element(`tab-${focused_id}`).focus();
  }
  const visible_header_id = focused_id ?? active_id;
  if (visible_header_id) {
    document.getElementById(`tab-${visible_header_id}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

function ensure_section(tab: sidebar_tab, view: sidebar_pane): void {
  if (!view.section) {
    const section = document.createElement('section');
    section.className = 'terminal-section';
    section.dataset.tabId = tab.id;
    const heading = document.createElement('div');
    heading.className = 'section-heading';
    heading.setAttribute('data-vscode-context', '{"preventDefaultContextMenuItems":true}');
    const button = document.createElement('button');
    button.id = `section-${tab.id}`;
    button.className = 'section-toggle';
    button.type = 'button';
    button.dataset.tabId = tab.id;
    button.dataset.reorderId = tab.id;
    button.draggable = true;
    button.setAttribute('aria-controls', view.pane.id);
    const caption = document.createElement('span');
    caption.className = 'section_caption';
    caption.innerHTML = `<span class="section-chevron">${icon('chevron')}</span>`;
    const label = document.createElement('span');
    label.className = 'section-label';
    caption.append(unread_badge(tab.id), label);
    button.append(caption);
    button.addEventListener('click', () => set_expanded(tab.id, !expanded_ids.has(tab.id)));
    button.addEventListener('keydown', event => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) {
        return;
      }
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        set_expanded(tab.id, event.key === 'ArrowRight');
        return;
      }
      if (event.key === 'Delete') {
        event.preventDefault();
        close_tab(tab.id);
        return;
      }
      const visible_order = open_tabs;
      const index = visible_order.findIndex(item => item.id === tab.id);
      let next_index: number;
      if (event.key === 'ArrowDown') {
        next_index = (index + 1) % visible_order.length;
      }
      else if (event.key === 'ArrowUp') {
        next_index = (index - 1 + visible_order.length) % visible_order.length;
      }
      else if (event.key === 'Home') {
        next_index = 0;
      }
      else if (event.key === 'End') {
        next_index = visible_order.length - 1;
      }
      else {
        return;
      }
      event.preventDefault();
      element(`section-${visible_order[next_index]!.id}`).focus();
    });
    attach_middle_close(button, tab.id);
    view.child_actions = create_tab_actions(() => tab.id);
    heading.append(button, view.child_actions.root);
    section.append(heading, view.pane);
    view.section = section;
    view.section_button = button;
    view.section_label = label;
  }
  view.section_button!.setAttribute('aria-expanded', String(expanded_ids.has(tab.id)));
  view.section_button!.title = `${tab.name} · Right-click for actions · Drag to reorder · Alt+Shift+Up/Down to move · Middle-click to close`;
  view.section_label!.textContent = tab.name;
  const caption = view.section_label!.parentElement!;
  caption.querySelector('.tab_marker')?.remove();
  if (tab.marker) caption.insertBefore(create_tab_marker(tab.marker), caption.querySelector('.terminal_unread'));
  update_unread(tab.id);
  view.section!.dataset.active = String(active_id === tab.id);
  view.section!.dataset.expanded = String(expanded_ids.has(tab.id));
  view.section!.dataset.status = sessions.get(tab.id)?.status ?? 'idle';
  view.child_actions?.update(trusted, true, saving);
}

function render_terminals(): void {
  // Replacing or removing a drag source can prevent dragend from bubbling. An
  // authoritative redraw cancels the gesture before touching those DOM nodes.
  for (const controller of reorder_controllers) {
    controller.cancel();
  }
  const previous_focus = document.activeElement;
  let sections_moved = false;
  document.body.dataset.side = side;
  for (const [id, view] of terminal_views) {
    if (!open_tabs.some(tab => tab.id === id)) {
      find_widget.release(id);
      view.links.dispose();
      view.terminal.dispose();
      (view.section ?? view.pane).remove();
      terminal_views.delete(id);
      activated_views.delete(id);
      unread_tabs.delete(id);
      tab_completions.delete(id);
    }
  }
  for (const views of [pdf_views, markdown_views, document_views]) {
    for (const [id, view] of views) {
      if (!open_tabs.some(tab => tab.id === id)) {
        find_widget.release(id);
        view.dispose();
        (view.section ?? view.pane).remove();
        views.delete(id);
      }
    }
  }
  if (side === 'right') {
    render_tabs();
  }
  else {
    tab_strip.replaceChildren();
  }
  if (!trusted) {
    rename_editor.close(false);
    marker_picker.close(false);
    find_widget.close(false);
    action_menu.close(false);
    return;
  }
  for (const [index, tab] of open_tabs.entries()) {
    const view = ensure_pane(tab);
    if (side === 'left') {
      ensure_section(tab, view);
      // Preserve focused descendants when the section is already in place.
      const current_section = terminal_host.children[index] ?? null;
      if (current_section !== view.section) {
        terminal_host.insertBefore(view.section!, current_section);
        sections_moved = true;
      }
    }
    set_pane_visible(tab.id);
  }
  // Moving a section can blur its terminal textarea even though the process and
  // xterm instance are unchanged. Restore focus only if that same pane is visible.
  if (side === 'left' && previous_focus instanceof HTMLElement && previous_focus.isConnected
      && terminal_host.contains(previous_focus) && !previous_focus.closest('[hidden]')
      && document.activeElement !== previous_focus) {
    previous_focus.focus({ preventScroll: true });
  }
  if (sections_moved && previous_focus instanceof HTMLElement && previous_focus.dataset.reorderId
      && previous_focus.isConnected) {
    previous_focus.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  rename_editor.refresh();
  marker_picker.refresh();
  find_widget.refresh();
  if (menu_tab_id && !open_tabs.some(tab => tab.id === menu_tab_id)) {
    menu_tab_id = undefined;
    action_menu.close(false);
  }
}

function update_actions(): void {
  header_actions.update(trusted, !!active_id, saving);
  element<HTMLButtonElement>('save-action').disabled = saving;
  element<HTMLButtonElement>('close-action').disabled = saving;
  element<HTMLButtonElement>('undo-action').disabled = !draft.can_undo || saving;
  element<HTMLButtonElement>('redo-action').disabled = !draft.can_redo || saving;
  element<HTMLButtonElement>('refresh-shells').disabled = saving;
  element('tab-actions').hidden = configuring;
  element('configuration-toolbar').hidden = !configuring;
  element('terminal-header').hidden = side === 'left' && !configuring;
  tab_strip.hidden = configuring || side === 'left';
  element('left-heading').hidden = !configuring && side !== 'left';
  element('left-heading').textContent = configuring ? 'Startup configuration' : 'Terminals';
  const draft_state = {
    type: 'draft_state' as const,
    configuring,
    can_undo: configuring && draft.can_undo && !saving,
    can_redo: configuring && draft.can_redo && !saving,
  };
  const serialised = JSON.stringify(draft_state);
  if (received_state && serialised !== last_draft_state) {
    last_draft_state = serialised;
    send(draft_state);
  }
}

function update_status(): void {
  const session = active_id ? sessions.get(active_id) : undefined;
  const status = element('status-text');
  const selected = open_tabs.find(tab => tab.id === active_id);
  element('status-dot').hidden = Boolean(selected && !is_terminal_tab(selected));
  element('status-dot').classList.add('status_dot');
  element('status-dot').dataset.status = trusted ? terminal_indicator(session) : 'idle';
  if (!received_state) {
    status.textContent = 'Loading terminals…';
  }
  else if (!trusted) {
    status.textContent = 'Workspace trust required';
  }
  else if (!active_id) {
    status.textContent = 'No open terminals';
  }
  else if (selected && !is_terminal_tab(selected)) {
    status.textContent = `${is_pdf_tab(selected) ? 'PDF' : is_document_tab(selected) ? selected.format.toUpperCase() : 'Markdown'} preview`;
  }
  else if (session?.message) {
    status.textContent = session.message;
  }
  else if (session?.status === 'running' && session.command_status) {
    status.textContent = indicator_label(session.command_status)
      + (session.command_status === 'error' && session.command_exit_code !== undefined ? ` (${session.command_exit_code})` : '');
  }
  else if (session?.status === 'running') {
    status.textContent = 'Running';
  }
  else if (session?.status === 'exited') {
    status.textContent = session.exit_code === undefined
      ? 'Stopped · Restart to run again'
      : `Exited (${session.exit_code}) · Restart to run again`;
  } else if (session?.status === 'error') {
    status.textContent = 'Terminal could not start';
  }
  else {
    status.textContent = 'Starting terminal…';
  }
  status.title = status.textContent ?? '';
}

function render_content(): void {
  terminal_content.hidden = configuring;
  status_bar.hidden = configuring;
  configuration_panel.hidden = !configuring;
  element('trust-panel').hidden = trusted || !received_state;
  element('empty-panel').hidden = !trusted || open_tabs.length > 0;
  element('open-other-sidebar').textContent = `Open ${side_label(side === 'left' ? 'right' : 'left').toLowerCase()} terminals`;
  element('open-other-sidebar').title = element('open-other-sidebar').textContent ?? '';
  terminal_host.hidden = !trusted || open_tabs.length === 0;
  render_terminals();
  update_actions();
  update_status();
}

function show_error(message: string, is_name_validation = false): void {
  name_validation_error = Boolean(message) && is_name_validation;
  element('error-message').textContent = message;
  error_banner.hidden = !message;
}

/** Clear only a resolved name warning; unrelated terminal errors stay visible. */
function clear_resolved_name_error(): void {
  if (name_validation_error && [...draft.value.left, ...draft.value.right].every(profile => profile.name.trim())) {
    show_error('');
  }
}

function copy_selection(id = active_id): void {
  const selection = id ? terminal_views.get(id)?.terminal.getSelection() : undefined;
  if (selection) {
    send({ type: 'copy', text: selection });
  }
}

function new_profile(profile_side: sidebar_side): terminal_profile {
  let number = draft.value[profile_side].length;
  while (draft.value[profile_side].some(profile => profile.name === `${side_label(profile_side)} ${number}`)) {
    number++;
  }
  return { id: crypto.randomUUID(), name: `${side_label(profile_side)} ${number}`, command: '', shell: '' };
}

function side_label(profile_side: sidebar_side): string {
  return profile_side === 'left' ? 'Primary Side Bar' : 'Secondary Side Bar';
}

function open_configuration(): void {
  marker_picker.close(false);
  rename_editor.close(false);
  find_widget.close(false);
  action_menu.close(false);
  if (!configuring) {
    // Resume a suspended draft. A clean draft follows settings changed elsewhere;
    // a dirty draft keeps its original baseline for the host's conflict check.
    if (!draft.dirty && JSON.stringify(draft.base) !== JSON.stringify(startup_configuration)) {
      draft.reset(startup_configuration);
      custom_shells.clear();
    }
    configuring = true;
  }
  render_draft();
  render_content();
  (profile_groups.querySelector<HTMLInputElement>('.profile-group-content:not([hidden]) input')
    ?? element('toggle-left-profiles')).focus();
}

function return_to_terminals(): void {
  if (saving) {
    return;
  }
  configuring = false;
  draft.end_group();
  if (name_validation_error) {
    show_error('');
  }
  render_content();
  schedule_fit();
  if (active_id) {
    focus_terminal(active_id);
  } else {
    element(trusted ? 'add-first-tab' : 'trust-button').focus();
  }
}

function close_configuration(): void {
  if (saving) {
    return;
  }
  draft.reset(startup_configuration);
  custom_shells.clear();
  save_button.disabled = false;
  save_button.textContent = 'Save';
  return_to_terminals();
}

function restore_draft_focus(previous: Element | null, start: number | null, end: number | null): void {
  if (!(previous instanceof HTMLElement) || !previous.id) {
    return;
  }
  const next = document.getElementById(previous.id);
  next?.focus();
  if (start !== null && end !== null && (next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement)) {
    next.setSelectionRange(Math.min(start, next.value.length), Math.min(end, next.value.length));
  }
}

function update_draft(profile_side: sidebar_side, id: string, key: 'name' | 'command' | 'shell', value: string): void {
  draft.change(configuration => {
    const profile = configuration[profile_side].find(item => item.id === id);
    if (profile) {
      profile[key] = value;
    }
  }, `${profile_side}:${id}:${key}`);
  clear_resolved_name_error();
  update_actions();
}

function render_profile_row(profile_side: sidebar_side, profile: terminal_profile, index: number): HTMLFieldSetElement {
  const row = document.createElement('fieldset');
  row.className = 'profile-row';
  row.dataset.profileId = profile.id;
  const prefix = `${profile_side}-${profile.id}`;
  const legend = document.createElement('legend');
  const heading = document.createElement('span');
  heading.className = 'profile_heading';
  const title = document.createElement('span');
  title.id = `${prefix}_title`;
  title.className = 'profile_title';
  title.textContent = `${side_label(profile_side)} ${index}`;
  title.title = title.textContent;
  row.setAttribute('aria-labelledby', title.id);
  heading.append(title);
  legend.append(heading);
  row.append(legend);
  const actions = document.createElement('span');
  actions.className = 'row-actions';

  function row_action(text: string, label: string, disabled: boolean, action: (profiles: terminal_profile[]) => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = `${prefix}-${label.replaceAll(' ', '-')}`;
    button.className = 'icon-button row-button';
    button.textContent = text;
    button.title = label;
    button.setAttribute('aria-label', `${label}: ${profile.name || `profile ${index + 1}`}`);
    button.disabled = disabled || saving;
    button.addEventListener('click', () => {
      draft.change(configuration => action(configuration[profile_side]));
      render_draft();
      const remaining_profiles = draft.value[profile_side];
      const focus_id = remaining_profiles.some(item => item.id === profile.id)
        ? profile.id : remaining_profiles[Math.min(index, remaining_profiles.length - 1)]?.id;
      const focus_row = Array.from(profile_groups.querySelectorAll<HTMLElement>('.profile-row'))
        .find(item => item.dataset.profileId === focus_id && item.closest('[data-side]')?.getAttribute('data-side') === profile_side);
      const next_button = Array.from(focus_row?.querySelectorAll<HTMLButtonElement>('button') ?? [])
        .find(item => item.title === label && !item.disabled);
      (next_button ?? focus_row?.querySelector<HTMLInputElement>('input') ?? element(`add-${profile_side}-profile`)).focus();
    });
    actions.append(button);
    return button;
  }

  row_action('↑', 'Move up', index === 0, profiles => {
    [profiles[index - 1], profiles[index]] = [profiles[index]!, profiles[index - 1]!];
  });
  row_action('↓', 'Move down', index === draft.value[profile_side].length - 1, profiles => {
    [profiles[index + 1], profiles[index]] = [profiles[index]!, profiles[index + 1]!];
  });
  const remove_button = row_action('', 'Remove startup profile', false, profiles => profiles.splice(index, 1));
  remove_button.innerHTML = icon('close');
  heading.append(actions);

  function field(key: 'name' | 'command', title: string, placeholder: string): void {
    const label = document.createElement('label');
    const input = key === 'command' ? document.createElement('textarea') : document.createElement('input');
    input.id = `${prefix}-${key}`;
    input.name = key;
    input.value = profile[key];
    input.placeholder = placeholder;
    input.spellcheck = false;
    input.disabled = saving;
    input.setAttribute('autocomplete', 'off');
    if (key === 'name') {
      input.required = true;
      input.maxLength = 80;
    } else {
      input.maxLength = 8192;
      input.title = 'Runs once when a terminal is created from this startup profile, or restarted.';
    }
    if (input instanceof HTMLTextAreaElement) {
      input.rows = 1;
    }
    input.addEventListener('input', () => update_draft(profile_side, profile.id, key, input.value));
    input.addEventListener('blur', () => draft.end_group());
    label.htmlFor = input.id;
    label.textContent = title;
    const group = document.createElement('div');
    group.className = 'field';
    group.append(label, input);
    row.append(group);
  }

  field('name', 'Name', `${side_label(profile_side)} ${index}`);
  field('command', 'Command', 'Optional startup command');
  const shell_group = document.createElement('div');
  shell_group.className = 'field';
  const label = document.createElement('label');
  const select = document.createElement('select');
  select.id = `${prefix}-shell-select`;
  select.disabled = saving;
  label.htmlFor = select.id;
  label.textContent = 'Shell';

  function option(value: string, text: string, title?: string): void {
    const item = document.createElement('option');
    item.value = value;
    item.textContent = text;
    if (title) {
      item.title = title;
    }
    select.append(item);
  }

  option('', 'Default shell');
  for (const shell of shells) {
    option(shell.path, `${shell.name} — ${shell.path}`, `${shell.source}: ${shell.path}`);
  }
  const matched_path = shells.some(shell => shell.path === profile.shell);
  const matched_name = profile.shell && shells.some(shell => shell.name.toLowerCase() === profile.shell.toLowerCase());
  if (matched_name && !matched_path) {
    option(profile.shell, `${profile.shell} (configured)`);
  }
  const custom_key = `${profile_side}:${profile.id}`;
  const is_custom = custom_shells.has(custom_key) || Boolean(profile.shell && !matched_path && !matched_name);
  option('__custom__', 'Custom executable…');
  select.value = is_custom ? '__custom__' : profile.shell;
  select.addEventListener('change', () => {
    draft.end_group();
    if (select.value === '__custom__') {
      custom_shells.add(custom_key);
    }
    else {
      custom_shells.delete(custom_key);
      update_draft(profile_side, profile.id, 'shell', select.value);
    }
    render_draft();
    if (select.value === '__custom__') {
      element<HTMLInputElement>(`${prefix}-shell`).focus();
    }
  });
  shell_group.append(label, select);
  if (is_custom) {
    const input = document.createElement('input');
    input.id = `${prefix}-shell`;
    input.value = profile.shell;
    input.placeholder = 'Shell name or executable path';
    input.setAttribute('aria-label', `Custom shell for ${profile.name}`);
    input.setAttribute('autocomplete', 'off');
    input.className = 'custom-shell';
    input.spellcheck = false;
    input.maxLength = 1024;
    input.disabled = saving;
    input.addEventListener('input', () => update_draft(profile_side, profile.id, 'shell', input.value));
    input.addEventListener('blur', () => draft.end_group());
    shell_group.append(input);
  }
  row.append(shell_group);
  return row;
}

/** The draft covers both sides so Save, Undo and Redo remain atomic. */
function render_draft(): void {
  clear_resolved_name_error();
  const previous = document.activeElement;
  const text_input = previous instanceof HTMLInputElement || previous instanceof HTMLTextAreaElement ? previous : undefined;
  const start = text_input?.selectionStart ?? null;
  const end = text_input?.selectionEnd ?? null;
  profile_groups.replaceChildren();
  for (const profile_side of ['left', 'right'] as const) {
    const group = document.createElement('section');
    group.className = 'profile-group';
    group.dataset.side = profile_side;
    const heading = document.createElement('h3');
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.id = `toggle-${profile_side}-profiles`;
    toggle.className = 'profile-group-toggle';
    toggle.innerHTML = `<span class="section-chevron">${icon('chevron')}</span>`;
    const label = document.createElement('span');
    label.textContent = side_label(profile_side);
    toggle.append(label);
    const content = document.createElement('div');
    content.id = `${profile_side}-profile-content`;
    content.className = 'profile-group-content';
    toggle.setAttribute('aria-controls', content.id);

    function set_group_expanded(expanded: boolean): void {
      // Presentation state is separate from the draft and its undo history.
      configuration_group_expanded[profile_side] = expanded;
      toggle.setAttribute('aria-expanded', String(expanded));
      toggle.title = `${expanded ? 'Collapse' : 'Expand'} ${side_label(profile_side)} startup profiles`;
      content.hidden = !expanded;
    }

    set_group_expanded(configuration_group_expanded[profile_side]);
    toggle.addEventListener('click', () => set_group_expanded(!configuration_group_expanded[profile_side]));
    toggle.addEventListener('keydown', event => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        set_group_expanded(event.key === 'ArrowRight');
      }
    });
    heading.append(toggle);
    group.append(heading);
    if (!draft.value[profile_side].length) {
      const empty = document.createElement('p');
      empty.className = 'configuration-empty';
      empty.textContent = 'No startup profiles on this side.';
      content.append(empty);
    }
    draft.value[profile_side].forEach((profile, index) => content.append(render_profile_row(profile_side, profile, index)));
    const add_button = document.createElement('button');
    add_button.id = `add-${profile_side}-profile`;
    add_button.className = 'secondary add-profile';
    add_button.type = 'button';
    add_button.textContent = `+ Add ${profile_side} startup profile`;
    add_button.title = `Add startup profile to the ${side_label(profile_side)}`;
    add_button.disabled = saving || draft.value[profile_side].length >= maximum_profiles;
    add_button.addEventListener('click', () => {
      if (saving || draft.value[profile_side].length >= maximum_profiles) {
        return;
      }
      draft.change(configuration => configuration[profile_side].push(new_profile(profile_side)));
      render_draft();
      profile_groups.querySelector<HTMLInputElement>(`[data-side="${profile_side}"] .profile-row:last-of-type input`)?.focus();
    });
    content.append(add_button);
    if (draft.value[profile_side].length >= maximum_profiles) {
      const limit = document.createElement('p');
      limit.className = 'field-hint';
      limit.textContent = '32 startup profiles on this side. Remove one to add another.';
      content.append(limit);
    }
    group.append(content);
    profile_groups.append(group);
  }
  element<HTMLButtonElement>('cancel-configuration').disabled = saving;
  element<HTMLButtonElement>('return_to_terminals').disabled = saving;
  update_actions();
  restore_draft_focus(previous, start, end);
}

function save_configuration(): void {
  if (saving) {
    return;
  }
  for (const profile_side of ['left', 'right'] as const) {
    const unnamed_profile = draft.value[profile_side].find(profile => !profile.name.trim());
    if (unnamed_profile) {
      configuration_group_expanded[profile_side] = true;
      render_draft();
      show_error('Give each startup profile a name before saving.', true);
      element<HTMLInputElement>(`${profile_side}-${unnamed_profile.id}-name`).focus();
      return;
    }
  }
  const normalise = (entries: readonly terminal_profile[]): terminal_profile[] => entries.map(profile => ({
    ...profile, name: profile.name.trim(), shell: profile.shell.trim(),
  }));
  saving = true;
  save_button.disabled = true;
  save_button.textContent = 'Saving…';
  show_error('');
  render_draft();
  send({
    type: 'save',
    configuration: { left: normalise(draft.value.left), right: normalise(draft.value.right) },
    base_configuration: draft.base,
  });
}

function export_output(id = active_id): void {
  if (!id || !terminal_views.has(id)) {
    return;
  }
  marker_picker.close(false);
  const anchor = document.getElementById(`${side === 'left' ? 'section' : 'tab'}-${id}`)?.getBoundingClientRect();
  menu_tab_id = id;
  action_menu.show([
    { label: 'HTML', action: () => { void save_output(id, 'html'); } },
    { label: 'PDF', action: () => { void save_output(id, 'pdf'); } },
    { label: 'Markdown', action: () => { void save_output(id, 'markdown'); } },
    { label: 'Plain text', action: () => { void save_output(id, 'text'); } },
  ], anchor?.left ?? 8, anchor?.bottom ?? 8, () => focus_terminal(id));
}

async function save_output(id: string, format: export_format): Promise<void> {
  const view = terminal_views.get(id);
  const tab = open_tabs.find(item => item.id === id);
  if (!view || !tab || !trusted || exporting) {
    return;
  }
  exporting = true;
  try {
    const text = format === 'pdf' ? await terminal_pdf(view.terminal, tab.name)
      : format === 'html' ? terminal_html(view.serialize, tab.name)
      : format === 'markdown' ? terminal_markdown(view.serialize, tab.name) : terminal_text(view.terminal);
    if (!is_export_payload(format, text)) throw new Error('Terminal export exceeds the size limit. Reduce scrollback before exporting.');
    if (!trusted || !open_tabs.some(item => item.id === id)) return;
    send({ type: 'export', id, text, format });
    focus_terminal(id);
  } catch (error) {
    show_error(error instanceof Error ? error.message : 'Terminal export failed.');
  } finally {
    exporting = false;
  }
}

function reveal_document_match(id: string): void {
  const location = pending_search_reveals.get(id);
  const view = pdf_views.get(id) ?? markdown_views.get(id) ?? document_views.get(id);
  if (location && view?.reveal_match(location)) pending_search_reveals.delete(id);
}

async function open_global_find(): Promise<void> {
  if (!trusted || configuring) return;
  find_widget.close(false);
  global_find_mode = true;
  try {
    await all_tabs_search.prepare();
    find_widget.set_scope('Find in all open tabs');
    find_widget.open();
  } catch {
    show_error('Global search could not start. Try again.');
  }
}

function run_action(action: 'save' | 'undo' | 'redo' | 'close' | 'add' | 'find'): void {
  if (saving) {
    return;
  }
  if (action === 'find') {
    if (global_find_mode) find_widget.close(false);
    global_find_mode = false;
    find_widget.set_scope('Find in active tab');
    marker_picker.close(false);
    if (!configuring && trusted) {
      if (active_id && side === 'left' && !expanded_ids.has(active_id)) set_expanded(active_id, true);
      find_widget.open();
    }
  } else if (action === 'add') {
    add_tab();
  }
  else if (action === 'save') {
    if (configuring) {
      save_configuration();
    }
    else {
      export_output();
    }
  } else if (action === 'close') {
    if (configuring) {
      close_configuration();
    }
    else {
      close_tab(active_id);
    }
  } else if (configuring && draft[action]()) {
    custom_shells.clear();
    render_draft();
  }
}

// Suppress VS Code's default editing menu only over terminal tab headings.
app.addEventListener('contextmenu', event => {
  const target = event.target instanceof Element ? event.target.closest<HTMLElement>('.terminal-tab, .section-heading') : null;
  const id = target?.dataset.tabId ?? target?.closest<HTMLElement>('.terminal-section')?.dataset.tabId;
  if (!target || !id || configuring) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  const bounds = target.getBoundingClientRect();
  show_tab_menu(id, event.clientX || bounds.left, event.clientY || bounds.bottom);
});
app.addEventListener('keydown', event => {
  const target = event.target instanceof Element ? event.target.closest<HTMLElement>('.terminal-tab, .section-heading') : null;
  const id = target?.dataset.tabId ?? target?.closest<HTMLElement>('.terminal-section')?.dataset.tabId;
  if (!target || !id || event.isComposing) {
    return;
  }
  if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey)) {
    event.preventDefault();
    const bounds = target.getBoundingClientRect();
    show_tab_menu(id, bounds.left, bounds.bottom);
  } else if (event.key === 'F2' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    request_rename(id);
  }
});
document.addEventListener('keydown', event => {
  if (configuring || rename_editor.editing || !trusted) {
    return;
  }
  const target = event.target instanceof Element ? event.target : null;
  const in_find = target && find_widget.root.contains(target);
  const in_terminal = Boolean(target?.closest('.terminal-pane, .terminal-tab, .section-heading'));
  if (!(in_find || in_terminal)) {
    return;
  }
  if (is_find_shortcut(event, is_mac)) {
    marker_picker.close(false);
    event.preventDefault();
    event.stopPropagation();
    const heading = target?.closest<HTMLElement>('.terminal-tab, .section-heading');
    const id = heading?.dataset.tabId ?? heading?.closest<HTMLElement>('.terminal-section')?.dataset.tabId;
    if (id) {
      if (side === 'left' && !expanded_ids.has(id)) {
        set_expanded(id, true);
      } else {
        select_tab(id);
      }
    }
    run_action('find');
  } else if (event.key === 'Escape' && !event.isComposing && find_widget.visible) {
    event.preventDefault();
    event.stopPropagation();
    find_widget.close();
  }
}, true);

// Empty strip space opens a terminal. Tabs and the action buttons are excluded.
tab_strip.addEventListener('dblclick', event => {
  if (event.target === tab_strip) {
    event.preventDefault();
    add_tab();
  }
});
tab_strip.addEventListener('wheel', event => {
  if (tab_strip.scrollWidth > tab_strip.clientWidth && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
    event.preventDefault();
    tab_strip.scrollLeft += event.deltaY;
  }
}, { passive: false });
element('add-first-tab').addEventListener('click', add_tab);
element('add-first-tab').addEventListener('contextmenu', event => header_actions.new_menu(event, element('add-first-tab')));
element('open-other-sidebar').addEventListener('click', () => send({ type: 'open_other_sidebar' }));
element('configure-empty').addEventListener('click', () => send({ type: 'configure' }));
element('trust-button').addEventListener('click', () => send({ type: 'trust' }));
element('dismiss-error').addEventListener('click', () => show_error(''));
for (const action of ['save', 'undo', 'redo', 'close'] as const) {
  element(`${action}-action`).addEventListener('click', () => run_action(action));
}
element('refresh-shells').addEventListener('click', () => send({ type: 'refresh_shells' }));
element('cancel-configuration').addEventListener('click', close_configuration);
element('return_to_terminals').addEventListener('click', return_to_terminals);
element<HTMLFormElement>('profile-form').addEventListener('submit', event => {
  event.preventDefault();
  save_configuration();
});
configuration_panel.addEventListener('keydown', event => {
  const modifier = is_mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!modifier || event.altKey || event.isComposing || saving) {
    return;
  }
  const key = event.key.toLowerCase();
  if (key === 's') {
    event.preventDefault();
    save_configuration();
  } else if (key === 'z') {
    event.preventDefault();
    run_action(event.shiftKey ? 'redo' : 'undo');
  } else if (!is_mac && key === 'y') {
    event.preventDefault();
    run_action('redo');
  }
});

window.addEventListener('message', (event: MessageEvent<host_message>) => {
  const message = event.data;
  if (!message || typeof message.type !== 'string') {
    return;
  }
  switch (message.type) {
    case 'search_catalog': case 'search_source':
      all_tabs_search.receive(message);
      break;
    case 'search_snapshot': {
      const view = terminal_views.get(message.id);
      if (view) send({ type: 'search_snapshot', request: message.request, snapshot: snapshot_terminal(view.terminal) });
      break;
    }
    case 'search_reveal': {
      if (configuring) return_to_terminals();
      select_tab(message.id, true);
      if (side === 'left') set_expanded(message.id, true);
      const terminal = terminal_views.get(message.id);
      if (terminal) reveal_terminal(terminal.terminal, message.location);
      else {
        pending_search_reveals.set(message.id, message.location);
        reveal_document_match(message.id);
      }
      break;
    }
    case 'state': {
      handshake.acknowledge();
      const previous_active_id = active_id;
      received_state = true;
      side = message.side;
      startup_configuration = message.configuration;
      open_tabs = message.tabs;
      active_id = open_tabs.some(tab => tab.id === message.active_id) ? message.active_id : open_tabs[0]?.id;
      expanded_ids = new Set(message.expanded_ids);
      trusted = message.trusted;
      appearance = message.appearance;
      shells = message.shells;
      sessions.clear();
      for (const session of message.sessions) {
        sessions.set(session.id, session);
        tab_completions.observe(session);
      }
      if (active_id && active_id !== previous_active_id) {
        clear_unread(active_id);
      }
      if (configuring && !saving) {
        if (!draft.dirty && JSON.stringify(draft.base) !== JSON.stringify(startup_configuration)) {
          draft.reset(startup_configuration);
        }
        render_draft();
      }
      render_content();
      update_appearance();
      schedule_fit();
      if (pending_focus) {
        const operation_finished = pending_focus.operation === 'add'
          ? Boolean(active_id && !pending_focus.previous_ids.has(active_id))
          : !open_tabs.some(tab => tab.id === pending_focus?.id);
        if (operation_finished) {
          pending_focus = undefined;
          if (active_id && !configuring) {
            focus_terminal(active_id);
          } else if (!configuring) {
          element(side === 'left' ? 'add-first-tab' : 'add-tab').focus();
          }
        }
      }
      break;
    }
    case 'output': {
      const tab = open_tabs.find(item => item.id === message.id);
      if (tab && is_terminal_tab(tab) && trusted) {
        ensure_terminal(tab).terminal.write(message.data);
      }
      break;
    }
    case 'pdf_source':
      void pdf_views.get(message.id)?.load(message.url).then(() => reveal_document_match(message.id));
      break;
    case 'pdf_error':
      pdf_views.get(message.id)?.error(message.message);
      break;
    case 'document_source':
      void document_views.get(message.id)?.load(message.source).then(() => reveal_document_match(message.id));
      break;
    case 'document_error':
      document_views.get(message.id)?.error(message.message);
      break;
    case 'markdown_source':
      markdown_views.get(message.id)?.load(message.source);
      reveal_document_match(message.id);
      break;
    case 'markdown_error':
      markdown_views.get(message.id)?.error(message.message);
      break;
    case 'session': {
      sessions.set(message.session.id, message.session);
      tab_completions.observe(message.session);
      update_status();
      update_unread(message.session.id);
      const tab = document.getElementById(`tab-${message.session.id}`);
      if (tab) {
        tab.dataset.status = message.session.status;
      }
      const section = terminal_views.get(message.session.id)?.section;
      if (section) {
        section.dataset.status = message.session.status;
      }
      break;
    }
    case 'reset':
      clear_unread(message.id);
      tab_completions.delete(message.id);
      terminal_views.get(message.id)?.search.clearDecorations();
      terminal_views.get(message.id)?.terminal.reset();
      break;
    case 'paste':
      if (trusted) {
        terminal_views.get(message.id)?.terminal.paste(message.data);
      }
      break;
    case 'saved':
      startup_configuration = message.configuration;
      saving = false;
      close_configuration();
      show_error('');
      break;
    case 'error':
      pending_focus = undefined;
      show_error(message.message);
      if (saving) {
        saving = false;
        save_button.disabled = false;
        save_button.textContent = 'Save';
        render_draft();
      }
      break;
    case 'configure': open_configuration(); break;
    case 'action': run_action(message.action); break;
  }
});

const resize_observer = new ResizeObserver(schedule_fit);
resize_observer.observe(terminal_host);
const theme_observer = new MutationObserver(update_appearance);
theme_observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
theme_observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
document.fonts?.ready.then(schedule_fit).catch(() => undefined);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) handshake.request();
  for (const tab of open_tabs) set_pane_visible(tab.id);
  if (active_id) update_unread(active_id);
  schedule_fit();
});
window.addEventListener('focus', () => {
  handshake.request();
  if (active_id) update_unread(active_id);
  if (focused_terminal && is_visible_tab(focused_terminal)) {
    clear_unread(focused_terminal);
  }
});
window.addEventListener('beforeunload', () => {
  handshake.dispose();
  for (const controller of reorder_controllers) {
    controller.cancel();
  }
  resize_observer.disconnect();
  theme_observer.disconnect();
  rename_editor.dispose();
  marker_picker.dispose();
  find_widget.dispose();
  all_tabs_search.dispose();
  action_menu.dispose();
  for (const view of [...pdf_views.values(), ...markdown_views.values(), ...document_views.values()]) view.dispose();
  for (const view of terminal_views.values()) {
    view.links.dispose();
    view.terminal.dispose();
  }
});
render_content();
handshake.request();
