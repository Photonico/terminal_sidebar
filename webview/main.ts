import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { configuration_draft } from '../src/draft';
import { tab_reordering } from './reordering';
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
} from '../src/types';
import '@xterm/xterm/css/xterm.css';
import './main.css';

declare function acquireVsCodeApi(): { postMessage(message: client_message): void };

const vscode = acquireVsCodeApi();
const is_mac = /Mac|iPhone|iPad/.test(navigator.platform);
const maximum_profiles = 32;
const maximum_export_characters = 1024 * 1024;
/*! Codicons edit icon, unmodified path, Copyright Microsoft Corporation.
 * Source: https://github.com/microsoft/vscode-codicons/blob/main/src/icons/edit.svg
 * Licensed under CC BY 4.0: https://creativecommons.org/licenses/by/4.0/
 */
const icons = {
  add: '<path d="M8 3v10M3 8h10"/>',
  edit: '<path fill="currentColor" stroke="none" d="M14.236 1.76386C13.2123 0.740172 11.5525 0.740171 10.5289 1.76386L2.65722 9.63549C2.28304 10.0097 2.01623 10.4775 1.88467 10.99L1.01571 14.3755C0.971767 14.5467 1.02148 14.7284 1.14646 14.8534C1.27144 14.9783 1.45312 15.028 1.62432 14.9841L5.00978 14.1151C5.52234 13.9836 5.99015 13.7168 6.36433 13.3426L14.236 5.47097C15.2596 4.44728 15.2596 2.78755 14.236 1.76386ZM11.236 2.47097C11.8691 1.8378 12.8957 1.8378 13.5288 2.47097C14.162 3.10413 14.162 4.1307 13.5288 4.76386L12.75 5.54269L10.4571 3.24979L11.236 2.47097ZM9.75002 3.9569L12.0429 6.24979L5.65722 12.6355C5.40969 12.883 5.10023 13.0595 4.76117 13.1465L2.19447 13.8053L2.85327 11.2386C2.9403 10.8996 3.1168 10.5901 3.36433 10.3426L9.75002 3.9569Z"/>',
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

function icon(name: keyof typeof icons): string {
  return `<svg viewBox="0 0 16 16" aria-hidden="true">${icons[name]}</svg>`;
}

const app = document.getElementById('app') ?? document.body.appendChild(document.createElement('div'));
app.id = 'app';
app.innerHTML = `
  <header id="terminal-header">
    <div id="terminal-tabs" role="tablist" aria-label="Open terminals"></div>
    <span id="left-heading">Terminals</span>
    <div id="tab-actions" role="toolbar" aria-label="Tab actions">
      <button id="add-tab" class="icon-button" type="button" aria-label="New terminal" title="New terminal">${icon('add')}</button>
      <button id="rename_tab" class="icon-button" type="button" aria-label="Rename terminal" title="Rename terminal" disabled>${icon('edit')}</button>
      <button id="close-tab" class="icon-button" type="button" aria-label="Close active terminal" title="Close active terminal">${icon('close')}</button>
    </div>
    <div id="configuration-toolbar" role="toolbar" aria-label="Configuration actions" hidden>
      <button id="save-action" class="icon-button" type="button" aria-label="Save startup configuration" title="Save startup configuration">${icon('save')}</button>
      <button id="undo-action" class="icon-button" type="button" aria-label="Undo configuration change" title="Undo configuration change">${icon('undo')}</button>
      <button id="redo-action" class="icon-button" type="button" aria-label="Redo configuration change" title="Redo configuration change">${icon('redo')}</button>
      <button id="close-action" class="icon-button" type="button" aria-label="Cancel configuration changes" title="Cancel configuration changes">${icon('close')}</button>
    </div>
  </header>
  <div id="error-banner" role="alert" aria-atomic="true" hidden><span id="error-icon" aria-hidden="true">${icon('warning')}</span><span id="error-message"></span><button id="dismiss-error" type="button" aria-label="Dismiss error">×</button></div>
  <main id="terminal-content">
    <div id="trust-panel" class="empty-panel" hidden><p>Trust this workspace to run terminals.</p><button id="trust-button" class="primary" type="button">Manage Workspace Trust</button></div>
    <div id="empty-panel" class="empty-panel" hidden>
      <p>No open terminals. Your startup configuration is unchanged.</p>
      <button id="add-first-tab" class="primary" type="button">New terminal</button>
      <button id="open-other-sidebar" class="secondary" type="button">Open primary side bar terminals</button>
      <button id="configure-empty" class="secondary" type="button">Configure startup terminals</button>
    </div>
    <div id="terminal-host"></div>
  </main>
  <footer id="session-status" role="status" aria-live="polite"><span id="status-badge"><span id="status-dot"></span><span id="status-text">Loading terminals…</span></span></footer>
  <section id="configuration" aria-labelledby="configuration-title" hidden>
    <div class="configuration-heading"><h2 id="configuration-title">Startup terminals</h2><button id="refresh-shells" class="icon-button" type="button" aria-label="Detect shells again" title="Detect shells again">${icon('restart')}</button></div>
    <p class="configuration-intro">These profiles open at startup. Closing or adding a terminal during use does not change them. Blank Shell uses the default; keep secrets out of synced commands.</p>
    <form id="profile-form" novalidate>
      <div id="profile-groups"></div>
      <div class="configuration-actions"><button id="save-profiles" class="primary" type="submit">Save</button><button id="cancel-configuration" class="secondary" type="button">Cancel</button><button id="return_to_terminals" class="secondary" type="button">Return to terminals</button></div>
    </form>
  </section>`;

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

interface terminal_view {
  terminal: Terminal;
  fit: FitAddon;
  pane: HTMLDivElement;
  section?: HTMLElement;
  section_button?: HTMLButtonElement;
  section_label?: HTMLSpanElement;
}

const terminal_views = new Map<string, terminal_view>();
const sessions = new Map<string, session_info>();
const activated_views = new Set<string>();
const custom_shells = new Set<string>();
const configuration_group_expanded: Record<sidebar_side, boolean> = { left: true, right: true };
const draft = new configuration_draft();
let startup_configuration: sidebar_configuration = { left: [], right: [] };
let open_tabs: terminal_tab[] = [];
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

const reorder_controllers = (['left', 'right'] as const).map(sidebar => new tab_reordering({
  container: sidebar === 'left' ? terminal_host : tab_strip,
  axis: sidebar === 'left' ? 'vertical' : 'horizontal',
  get_ids: () => open_tabs.map(tab => tab.id),
  enabled: () => side === sidebar && trusted && !configuring && !saving,
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
    allowProposedApi: false,
    theme: terminal_theme(),
    overviewRuler: terminal_scrollbar_options(),
    convertEol: false,
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(pane);
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
  // No audible bell handler or audio addon is installed.
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

  const view = { terminal, fit, pane };
  terminal_views.set(tab.id, view);
  return view;
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
      terminal_views.get(id)?.terminal.focus();
    } else if (side === 'left' && !configuring) {
      terminal_views.get(id)?.section_button?.focus();
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

function request_rename(id: string | undefined): void {
  if (!id || configuring || saving || !open_tabs.some(tab => tab.id === id)) {
    return;
  }
  send({ type: 'request_rename', id });
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
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', `terminal-${tab.id}`);
    button.setAttribute('aria-selected', String(tab.id === active_id));
    button.tabIndex = tab.id === active_id ? 0 : -1;
    const label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = tab.name;
    button.append(label);
    button.title = `${tab.name} · Drag to reorder · Alt+Shift+Left/Right to move · Middle-click to close`;
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

function ensure_section(tab: terminal_tab, view: terminal_view): void {
  if (!view.section) {
    const section = document.createElement('section');
    section.className = 'terminal-section';
    section.dataset.tabId = tab.id;
    const heading = document.createElement('div');
    heading.className = 'section-heading';
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
    caption.append(label);
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
    const rename_button = document.createElement('button');
    rename_button.type = 'button';
    rename_button.className = 'icon-button section_rename';
    rename_button.title = 'Rename terminal';
    rename_button.innerHTML = icon('edit');
    rename_button.addEventListener('click', () => request_rename(tab.id));
    const close_button = document.createElement('button');
    close_button.type = 'button';
    close_button.className = 'icon-button section-close';
    close_button.innerHTML = icon('close');
    close_button.addEventListener('click', () => close_tab(tab.id));
    heading.append(button, rename_button, close_button);
    section.append(heading, view.pane);
    view.section = section;
    view.section_button = button;
    view.section_label = label;
  }
  view.section_button!.setAttribute('aria-expanded', String(expanded_ids.has(tab.id)));
  view.section_button!.title = `${tab.name} · Drag to reorder · Alt+Shift+Up/Down to move · Middle-click to close`;
  view.section_label!.textContent = tab.name;
  view.section!.dataset.active = String(active_id === tab.id);
  view.section!.dataset.expanded = String(expanded_ids.has(tab.id));
  view.section!.dataset.status = sessions.get(tab.id)?.status ?? 'idle';
  const rename_button = view.section!.querySelector<HTMLButtonElement>('.section_rename')!;
  rename_button.setAttribute('aria-label', `Rename terminal: ${tab.name}`);
  rename_button.disabled = saving;
  const close_button = view.section!.querySelector<HTMLButtonElement>('.section-close')!;
  close_button.title = `Close ${tab.name}`;
  close_button.setAttribute('aria-label', close_button.title);
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
      view.terminal.dispose();
      (view.section ?? view.pane).remove();
      terminal_views.delete(id);
      activated_views.delete(id);
    }
  }
  if (side === 'right') {
    render_tabs();
  }
  else {
    tab_strip.replaceChildren();
  }
  if (!trusted) {
    return;
  }
  for (const [index, tab] of open_tabs.entries()) {
    const view = ensure_terminal(tab);
    if (side === 'left') {
      ensure_section(tab, view);
      // Preserve focused descendants when the section is already in place.
      const current_section = terminal_host.children[index] ?? null;
      if (current_section !== view.section) {
        terminal_host.insertBefore(view.section!, current_section);
        sections_moved = true;
      }
    }
    view.pane.hidden = !is_visible_tab(tab.id);
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
}

function update_actions(): void {
  element<HTMLButtonElement>('add-tab').disabled = !trusted || saving;
  element<HTMLButtonElement>('rename_tab').disabled = !active_id || saving;
  element<HTMLButtonElement>('close-tab').disabled = !active_id || saving;
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
  element('status-dot').dataset.status = trusted ? session?.status ?? 'idle' : 'idle';
  if (!received_state) {
    status.textContent = 'Loading terminals…';
  }
  else if (!trusted) {
    status.textContent = 'Workspace trust required';
  }
  else if (!active_id) {
    status.textContent = 'No open terminals';
  }
  else if (session?.message) {
    status.textContent = session.message;
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

function export_output(): void {
  if (!active_id) {
    return;
  }
  const buffer = terminal_views.get(active_id)?.terminal.buffer.active;
  if (!buffer) {
    return;
  }
  // Join wrapped rows without inserting line breaks into long commands.
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index++) {
    const line = buffer.getLine(index);
    if (!line) {
      continue;
    }
    const text = line.translateToString(!buffer.getLine(index + 1)?.isWrapped);
    if (line.isWrapped && lines.length) {
      lines[lines.length - 1] += text;
    }
    else {
      lines.push(text);
    }
  }
  while (lines.length && !lines[lines.length - 1]) {
    lines.pop();
  }
  const text = lines.join('\n') + (lines.length ? '\n' : '');
  if (text.length > maximum_export_characters) {
    show_error('Terminal text exceeds the 1 MiB export limit. Reduce scrollback before exporting.');
    return;
  }
  send({ type: 'export', id: active_id, text });
}

function run_action(action: 'save' | 'undo' | 'redo' | 'close' | 'add'): void {
  if (saving) {
    return;
  }
  if (action === 'add') {
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
element('add-tab').addEventListener('click', add_tab);
element('rename_tab').addEventListener('click', () => request_rename(active_id));
element('close-tab').addEventListener('click', () => close_tab(active_id));
element('add-first-tab').addEventListener('click', add_tab);
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
    case 'state': {
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
      if (tab && trusted) {
        ensure_terminal(tab).terminal.write(message.data);
      }
      break;
    }
    case 'session': {
      sessions.set(message.session.id, message.session);
      update_status();
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
    case 'reset': terminal_views.get(message.id)?.terminal.reset(); break;
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
  for (const [id, view] of terminal_views) {
    view.pane.hidden = !is_visible_tab(id);
  }
  schedule_fit();
});
window.addEventListener('beforeunload', () => {
  for (const controller of reorder_controllers) {
    controller.cancel();
  }
  resize_observer.disconnect();
  theme_observer.disconnect();
  for (const view of terminal_views.values()) {
    view.terminal.dispose();
  }
});
render_content();
send({ type: 'ready' });
