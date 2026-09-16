import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ProfileDraft } from '../src/draft';
import type { Appearance, ClientMessage, HostMessage, Profile, SessionInfo } from '../src/types';
import '@xterm/xterm/css/xterm.css';
import './main.css';

declare function acquireVsCodeApi(): { postMessage(message: ClientMessage): void };

const vscode = acquireVsCodeApi();
const send = (message: ClientMessage): void => vscode.postMessage(message);
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const MAX_PROFILES = 32;
const icons = {
  restart: '<path d="M3.1 5.1a5.5 5.5 0 1 1-.6 5.1M3 1.8v3.8h3.8"/>',
  close: '<path d="m4 4 8 8M4 12l8-8"/>',
  save: '<path d="M3 2h8l3 3v9H2V2Zm2 0v4h5V2M5 14V9h6v5"/>',
  undo: '<path d="M6 3 2 7l4 4M2 7h7a4 4 0 0 1 4 4v2"/>',
  redo: '<path d="m10 3 4 4-4 4m4-4H7a4 4 0 0 0-4 4v2"/>',
};
const icon = (name: keyof typeof icons): string => `<svg viewBox="0 0 16 16" aria-hidden="true">${icons[name]}</svg>`;
const app = document.getElementById('app') ?? document.body.appendChild(document.createElement('div'));
app.id = 'app';
app.innerHTML = `
  <header id="terminal-header">
    <div id="profile-tabs" role="tablist" aria-label="Terminal profiles"></div>
    <div id="toolbar" role="toolbar" aria-label="Terminal actions">
      <button id="save-action" class="icon-button" type="button" aria-label="Save terminal output" title="Save terminal output">${icon('save')}</button>
      <button id="undo-action" class="icon-button" type="button" aria-label="Undo configuration change" title="Undo configuration change">${icon('undo')}</button>
      <button id="redo-action" class="icon-button" type="button" aria-label="Redo configuration change" title="Redo configuration change">${icon('redo')}</button>
      <button id="close-action" class="icon-button" type="button" aria-label="Close terminal" title="Close terminal">${icon('close')}</button>
    </div>
  </header>
  <div id="error-banner" role="alert" hidden><span id="error-message"></span><button id="dismiss-error" type="button" aria-label="Dismiss error">×</button></div>
  <main id="terminal-content">
    <div id="trust-panel" class="empty-panel" hidden><p>Trust this workspace to start terminal profiles.</p><button id="trust-button" class="primary" type="button">Manage Workspace Trust</button></div>
    <div id="empty-panel" class="empty-panel" hidden><p>Add a profile to open a terminal here.</p><button id="add-first-profile" class="primary" type="button">Add a profile</button></div>
    <div id="terminal-host"></div>
  </main>
  <footer id="session-status" role="status" aria-live="polite"><span id="status-dot"></span><span id="status-text">Loading profiles…</span></footer>
  <section id="configuration" aria-labelledby="configuration-title" hidden>
    <div class="configuration-heading"><h2 id="configuration-title">Terminal profiles</h2><button id="refresh-shells" class="icon-button" type="button" aria-label="Detect shells again" title="Detect shells again">${icon('restart')}</button></div>
    <p class="configuration-intro">Name, startup command, and shell. Blank uses your default shell. Keep secrets out of synced commands.</p>
    <form id="profile-form">
      <div id="profile-rows"></div>
      <button id="add-profile" class="secondary" type="button" aria-describedby="profile-limit">+ Add profile</button>
      <p id="profile-limit" class="field-hint" hidden>32 profiles added. Remove one to add another.</p>
      <div class="configuration-actions"><button id="save-profiles" class="primary" type="submit">Save</button><button id="cancel-configuration" class="secondary" type="button">Cancel</button></div>
    </form>
  </section>`;

const element = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing UI element: ${id}`);
  return found as T;
};
const tabs = element('profile-tabs');
const terminalHost = element('terminal-host');
const content = element('terminal-content');
const configuration = element('configuration');
const profileRows = element('profile-rows');
const statusBar = element('session-status');
const errorBanner = element('error-banner');
const saveButton = element<HTMLButtonElement>('save-profiles');

interface TerminalView { terminal: Terminal; fit: FitAddon; pane: HTMLDivElement }
const terminals = new Map<string, TerminalView>();
const sessions = new Map<string, SessionInfo>();
let profiles: Profile[] = [];
let activeId: string | undefined;
let trusted = false;
let receivedState = false;
let configuring = false;
const draft = new ProfileDraft();
let shells: Array<{ name: string; path: string; source: string }> = [];
const customShells = new Set<string>();
let lastDraftState = '';
let focusedTerminal: string | undefined;
let saving = false;
let fitFrame = 0;
let needsActivation = false;
let appearance: Appearance = { fontFamily: 'monospace', fontSize: 13, cursorBlink: false, scrollback: 1000 };

function theme(): ITheme {
  const css = getComputedStyle(document.body);
  const color = (name: string, fallback?: string): string | undefined => css.getPropertyValue(`--vscode-${name}`).trim() || fallback;
  const dark = !document.body.classList.contains('vscode-light') && !document.body.classList.contains('vscode-high-contrast-light');
  return {
    background: color('terminal-background', color('editor-background', dark ? '#1e1e1e' : '#ffffff')),
    foreground: color('terminal-foreground', color('foreground', dark ? '#cccccc' : '#333333')),
    cursor: color('terminalCursor-foreground', color('terminal-foreground', dark ? '#cccccc' : '#333333')),
    cursorAccent: color('terminalCursor-background', color('editor-background', dark ? '#1e1e1e' : '#ffffff')),
    selectionBackground: color('terminal-selectionBackground', dark ? '#ffffff40' : '#00000030'),
    selectionInactiveBackground: color('terminal-inactiveSelectionBackground', dark ? '#ffffff20' : '#00000018'),
    black: color('terminal-ansiBlack'), red: color('terminal-ansiRed'), green: color('terminal-ansiGreen'),
    yellow: color('terminal-ansiYellow'), blue: color('terminal-ansiBlue'), magenta: color('terminal-ansiMagenta'),
    cyan: color('terminal-ansiCyan'), white: color('terminal-ansiWhite'),
    brightBlack: color('terminal-ansiBrightBlack'), brightRed: color('terminal-ansiBrightRed'),
    brightGreen: color('terminal-ansiBrightGreen'), brightYellow: color('terminal-ansiBrightYellow'),
    brightBlue: color('terminal-ansiBrightBlue'), brightMagenta: color('terminal-ansiBrightMagenta'),
    brightCyan: color('terminal-ansiBrightCyan'), brightWhite: color('terminal-ansiBrightWhite'),
  };
}

function updateAppearance(): void {
  for (const { terminal } of terminals.values()) {
    terminal.options.fontFamily = appearance.fontFamily;
    terminal.options.fontSize = appearance.fontSize;
    terminal.options.cursorBlink = appearance.cursorBlink;
    terminal.options.scrollback = appearance.scrollback;
    terminal.options.theme = theme();
  }
  scheduleFit();
}

function ensureTerminal(profile: Profile): TerminalView {
  const existing = terminals.get(profile.id);
  if (existing) { existing.pane.setAttribute('aria-label', profile.name); return existing; }
  const pane = document.createElement('div');
  pane.id = `terminal-${profile.id}`;
  pane.className = 'terminal-pane';
  pane.setAttribute('role', 'tabpanel');
  pane.setAttribute('aria-label', profile.name);
  pane.addEventListener('focusin', () => {
    if (trusted && focusedTerminal !== profile.id) { focusedTerminal = profile.id; send({ type: 'focus', id: profile.id }); }
  });
  pane.addEventListener('focusout', event => {
    if (!pane.contains(event.relatedTarget as Node | null)) focusedTerminal = undefined;
  });
  pane.hidden = profile.id !== activeId;
  terminalHost.append(pane);
  const terminal = new Terminal({
    fontFamily: appearance.fontFamily,
    fontSize: appearance.fontSize,
    cursorBlink: appearance.cursorBlink,
    scrollback: appearance.scrollback,
    screenReaderMode: false,
    allowProposedApi: false,
    theme: theme(),
    convertEol: false,
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(pane);
  terminal.onData(data => { if (trusted) send({ type: 'input', id: profile.id, data }); });
  terminal.onResize(({ cols, rows }) => {
    if (trusted && profile.id === activeId && !configuring) send({ type: 'resize', id: profile.id, cols, rows });
  });
  terminal.onSelectionChange(updateActions);
  // xterm has no audible bell without an audio integration; no bell handler or addon is installed.
  terminal.attachCustomKeyEventHandler(event => {
    if (event.type !== 'keydown') return true;
    const shortcut = isMac ? event.metaKey && !event.ctrlKey && !event.altKey : event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey;
    if (!shortcut) return true;
    const key = event.key.toLowerCase();
    if (key !== 'c' && key !== 'v') return true;
    event.preventDefault();
    if (key === 'c') copySelection(profile.id);
    else if (trusted) send({ type: 'paste', id: profile.id });
    return false;
  });
  const view = { terminal, fit, pane };
  terminals.set(profile.id, view);
  return view;
}

function scheduleFit(): void {
  if (fitFrame) return;
  fitFrame = requestAnimationFrame(() => {
    fitFrame = 0;
    if (!activeId || !trusted || configuring || !terminalHost.clientWidth || !terminalHost.clientHeight) return;
    const profile = profiles.find(item => item.id === activeId);
    if (!profile) return;
    const view = ensureTerminal(profile);
    if (view.pane.hidden) return;
    view.fit.fit();
    if (needsActivation && view.terminal.cols > 0 && view.terminal.rows > 0) {
      needsActivation = false;
      send({ type: 'activate', id: profile.id, cols: view.terminal.cols, rows: view.terminal.rows });
    }
  });
}

function selectProfile(id: string, focus = false): void {
  if (!profiles.some(profile => profile.id === id)) return;
  if (activeId !== id) {
    activeId = id;
    needsActivation = true;
  }
  if (trusted) ensureTerminal(profiles.find(profile => profile.id === id)!);
  for (const [profileId, view] of terminals) view.pane.hidden = profileId !== id;
  renderTabs();
  updateStatus();
  updateActions();
  scheduleFit();
  if (focus) requestAnimationFrame(() => terminals.get(id)?.terminal.focus());
}

function renderTabs(): void {
  const focusedId = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.profileId : undefined;
  tabs.replaceChildren(...profiles.map(profile => {
    const tab = document.createElement('button');
    tab.id = `tab-${profile.id}`;
    tab.type = 'button';
    tab.className = 'profile-tab';
    tab.dataset.profileId = profile.id;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', `terminal-${profile.id}`);
    tab.setAttribute('aria-selected', String(profile.id === activeId));
    tab.tabIndex = profile.id === activeId ? 0 : -1;
    tab.textContent = profile.name;
    tab.title = profile.name;
    const session = sessions.get(profile.id);
    if (session) tab.dataset.status = session.status;
    tab.addEventListener('click', () => selectProfile(profile.id, true));
    tab.addEventListener('keydown', event => {
      const index = profiles.findIndex(item => item.id === profile.id);
      let next: number;
      if (event.key === 'ArrowRight') next = (index + 1) % profiles.length;
      else if (event.key === 'ArrowLeft') next = (index - 1 + profiles.length) % profiles.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = profiles.length - 1;
      else return;
      event.preventDefault();
      selectProfile(profiles[next]!.id);
      element(`tab-${profiles[next]!.id}`).focus();
    });
    return tab;
  }));
  if (focusedId && profiles.some(profile => profile.id === focusedId)) element(`tab-${focusedId}`).focus();
  const selected = activeId ? document.getElementById(`tab-${activeId}`) : undefined;
  selected?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function updateActions(): void {
  const hasTerminal = Boolean(activeId && trusted && !configuring);
  element<HTMLButtonElement>('close-action').disabled = saving || (!configuring && !hasTerminal);
  const saveAction = element<HTMLButtonElement>('save-action');
  saveAction.disabled = saving || (!configuring && !hasTerminal);
  saveAction.title = configuring ? 'Save profiles' : 'Save terminal output';
  saveAction.setAttribute('aria-label', saveAction.title);
  element<HTMLButtonElement>('undo-action').disabled = !configuring || !draft.canUndo || saving;
  element<HTMLButtonElement>('redo-action').disabled = !configuring || !draft.canRedo || saving;
  element('undo-action').hidden = !configuring;
  element('redo-action').hidden = !configuring;
  element<HTMLButtonElement>('refresh-shells').disabled = saving;
  element('toolbar').hidden = !configuring;
  const state = { type: 'draftState' as const, configuring, canUndo: configuring && draft.canUndo && !saving, canRedo: configuring && draft.canRedo && !saving };
  const serialised = JSON.stringify(state);
  if (receivedState && serialised !== lastDraftState) { lastDraftState = serialised; send(state); }
}

function updateStatus(): void {
  const session = activeId ? sessions.get(activeId) : undefined;
  const status = element('status-text');
  element('status-dot').dataset.status = trusted ? session?.status ?? 'idle' : 'idle';
  if (!receivedState) status.textContent = 'Loading profiles…';
  else if (!trusted) status.textContent = 'Workspace trust required';
  else if (!activeId) status.textContent = 'No profiles';
  else if (session?.message) status.textContent = session.message;
  else if (session?.status === 'running') status.textContent = 'Running';
  else if (session?.status === 'exited') status.textContent = session.exitCode === undefined ? 'Stopped · Restart to run again' : `Exited (${session.exitCode}) · Restart to run again`;
  else if (session?.status === 'error') status.textContent = 'Terminal could not start';
  else status.textContent = 'Starting terminal…';
  status.title = status.textContent ?? '';
}

function renderContent(): void {
  content.hidden = configuring;
  statusBar.hidden = configuring;
  configuration.hidden = !configuring;
  element('trust-panel').hidden = trusted || !receivedState;
  element('empty-panel').hidden = !trusted || profiles.length > 0;
  terminalHost.hidden = !trusted || profiles.length === 0;
  updateActions();
  updateStatus();
}

function showError(message: string): void {
  element('error-message').textContent = message;
  errorBanner.hidden = !message;
}

function copySelection(id = activeId): void {
  const text = id ? terminals.get(id)?.terminal.getSelection() : undefined;
  if (text) send({ type: 'copy', text });
}

function newProfile(): Profile {
  let number = draft.value.length;
  while (draft.value.some(profile => profile.name === `Customised sidebar #${number}`)) number++;
  return { id: crypto.randomUUID(), name: `Customised sidebar #${number}`, command: '', shell: '' };
}

function openConfiguration(add = false): void {
  if (!configuring) {
    draft.reset(profiles);
    customShells.clear();
    configuring = true;
  }
  if (add && draft.value.length < MAX_PROFILES) draft.change(items => items.push(newProfile()));
  renderDraft();
  renderContent();
  const firstInput = configuration.querySelector<HTMLInputElement>(add ? '.profile-row:last-child input' : 'input');
  (firstInput ?? element('add-profile')).focus();
}

function closeConfiguration(): void {
  if (saving) return;
  configuring = false;
  draft.reset(profiles);
  customShells.clear();
  saveButton.disabled = false;
  saveButton.textContent = 'Save';
  renderContent();
  scheduleFit();
  requestAnimationFrame(() => terminals.get(activeId ?? '')?.terminal.focus());
}

function restoreDraftFocus(previous: Element | null, start: number | null, end: number | null): void {
  if (!(previous instanceof HTMLElement) || !previous.id) return;
  const next = document.getElementById(previous.id);
  next?.focus();
  if (start !== null && end !== null && (next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement)) {
    next.setSelectionRange(Math.min(start, next.value.length), Math.min(end, next.value.length));
  }
}

function updateDraft(id: string, key: 'name' | 'command' | 'shell', value: string): void {
  draft.change(items => { const profile = items.find(item => item.id === id); if (profile) profile[key] = value; }, `${id}:${key}`);
  updateActions();
}

function renderDraft(): void {
  const previous = document.activeElement;
  const textInput = previous instanceof HTMLInputElement || previous instanceof HTMLTextAreaElement ? previous : undefined;
  const start = textInput?.selectionStart ?? null;
  const end = textInput?.selectionEnd ?? null;
  profileRows.replaceChildren();
  if (!draft.value.length) {
    const empty = document.createElement('p');
    empty.className = 'configuration-empty';
    empty.textContent = 'No profiles yet. Add one below.';
    profileRows.append(empty);
  }
  draft.value.forEach((profile, index) => {
    const row = document.createElement('fieldset');
    row.className = 'profile-row';
    row.dataset.profileId = profile.id;
    const legend = document.createElement('legend');
    legend.textContent = `Customised sidebar #${index}`;
    row.append(legend);
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    const rowAction = (text: string, label: string, disabled: boolean, action: (items: Profile[]) => void): void => {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = `${profile.id}-${label.replaceAll(' ', '-')}`;
      button.className = 'row-button';
      button.textContent = text;
      button.title = label;
      button.setAttribute('aria-label', `${label}: ${profile.name || `profile ${index + 1}`}`);
      button.disabled = disabled || saving;
      button.addEventListener('click', () => {
        draft.change(action);
        renderDraft();
        const focusId = draft.value.some(item => item.id === profile.id) ? profile.id : draft.value[Math.min(index, draft.value.length - 1)]?.id;
        const nextRow = Array.from(profileRows.querySelectorAll<HTMLElement>('.profile-row')).find(item => item.dataset.profileId === focusId);
        const nextButton = Array.from(nextRow?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(item => item.textContent === text && !item.disabled);
        (nextButton ?? nextRow?.querySelector<HTMLInputElement>('input') ?? element('add-profile')).focus();
      });
      actions.append(button);
    };
    rowAction('↑', 'Move up', index === 0, items => { [items[index - 1], items[index]] = [items[index]!, items[index - 1]!]; });
    rowAction('↓', 'Move down', index === draft.value.length - 1, items => { [items[index + 1], items[index]] = [items[index]!, items[index + 1]!]; });
    rowAction('×', 'Remove profile', false, items => { items.splice(index, 1); });
    row.append(actions);
    const field = (key: 'name' | 'command', title: string, placeholder: string): void => {
      const label = document.createElement('label');
      const input = key === 'command' ? document.createElement('textarea') : document.createElement('input');
      input.id = `${profile.id}-${key}`;
      input.name = key;
      input.value = profile[key];
      input.placeholder = placeholder;
      input.spellcheck = false;
      input.disabled = saving;
      input.setAttribute('autocomplete', 'off');
      if (key === 'name') { input.required = true; input.maxLength = 80; }
      if (key === 'command') { input.maxLength = 8192; input.title = 'Runs once when this profile starts or restarts.'; }
      if (input instanceof HTMLTextAreaElement) input.rows = 1;
      input.addEventListener('input', () => updateDraft(profile.id, key, input.value));
      input.addEventListener('blur', () => draft.endGroup());
      label.htmlFor = input.id;
      label.textContent = title;
      const group = document.createElement('div');
      group.className = 'field';
      group.append(label, input);
      row.append(group);
    };
    field('name', 'Name', `Customised sidebar #${index}`);
    field('command', 'Command', 'Optional startup command');
    const shellGroup = document.createElement('div');
    shellGroup.className = 'field';
    const label = document.createElement('label');
    const select = document.createElement('select');
    select.id = `${profile.id}-shell-select`;
    select.disabled = saving;
    label.htmlFor = select.id;
    label.textContent = 'Shell';
    const option = (value: string, text: string, title?: string): void => {
      const item = document.createElement('option');
      item.value = value;
      item.textContent = text;
      if (title) item.title = title;
      select.append(item);
    };
    option('', 'Default shell');
    for (const shell of shells) option(shell.path, `${shell.name} — ${shell.path}`, `${shell.source}: ${shell.path}`);
    // Preserve a configured short name exactly until the user explicitly chooses another shell.
    const matchedPath = shells.some(shell => shell.path === profile.shell);
    const matchedName = profile.shell && shells.some(shell => shell.name.toLowerCase() === profile.shell.toLowerCase());
    if (matchedName && !matchedPath) option(profile.shell, `${profile.shell} (configured)`);
    const isCustom = customShells.has(profile.id) || Boolean(profile.shell && !matchedPath && !matchedName);
    option('__custom__', 'Custom executable…');
    select.value = isCustom ? '__custom__' : profile.shell;
    select.addEventListener('change', () => {
      draft.endGroup();
      if (select.value === '__custom__') customShells.add(profile.id);
      else { customShells.delete(profile.id); updateDraft(profile.id, 'shell', select.value); }
      renderDraft();
      if (select.value === '__custom__') element<HTMLInputElement>(`${profile.id}-shell`).focus();
    });
    shellGroup.append(label, select);
    if (isCustom) {
      const input = document.createElement('input');
      input.id = `${profile.id}-shell`;
      input.value = profile.shell;
      input.placeholder = 'Shell name or executable path';
      input.setAttribute('aria-label', `Custom shell for ${profile.name}`);
      input.setAttribute('autocomplete', 'off');
      input.className = 'custom-shell';
      input.spellcheck = false;
      input.maxLength = 1024;
      input.disabled = saving;
      input.addEventListener('input', () => updateDraft(profile.id, 'shell', input.value));
      input.addEventListener('blur', () => draft.endGroup());
      shellGroup.append(input);
    }
    row.append(shellGroup);
    profileRows.append(row);
  });
  element<HTMLButtonElement>('add-profile').disabled = saving || draft.value.length >= MAX_PROFILES;
  element('profile-limit').hidden = draft.value.length < MAX_PROFILES;
  element<HTMLButtonElement>('cancel-configuration').disabled = saving;
  updateActions();
  restoreDraftFocus(previous, start, end);
}

function saveProfiles(): void {
  if (saving) return;
  if (draft.value.some(profile => !profile.name.trim())) { showError('Give each profile a name before saving.'); return; }
  saving = true;
  saveButton.disabled = true;
  saveButton.textContent = 'Saving…';
  showError('');
  renderDraft();
  send({ type: 'save', profiles: draft.value.map(profile => ({ ...profile, name: profile.name.trim(), shell: profile.shell.trim() })), baseProfiles: draft.base });
}

function exportOutput(): void {
  if (!activeId) return;
  const buffer = terminals.get(activeId)?.terminal.buffer.active;
  if (!buffer) return;
  // Join wrapped rows without introducing line breaks into long commands.
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (!line) continue;
    const text = line.translateToString(!buffer.getLine(i + 1)?.isWrapped);
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  const text = lines.join('\n') + (lines.length ? '\n' : '');
  if (text.length > 1024 * 1024) { showError('Terminal text exceeds the 1 MiB export limit. Reduce scrollback before exporting.'); return; }
  send({ type: 'export', id: activeId, text });
}

function runAction(action: 'save' | 'undo' | 'redo' | 'close'): void {
  if (saving) return;
  if (action === 'save') { if (configuring) saveProfiles(); else exportOutput(); }
  else if (action === 'close') { if (configuring) closeConfiguration(); else if (activeId) send({ type: 'stop', id: activeId }); }
  else if (configuring && draft[action]()) { customShells.clear(); renderDraft(); }
}

tabs.addEventListener('wheel', event => {
  if (tabs.scrollWidth > tabs.clientWidth && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
    event.preventDefault();
    tabs.scrollLeft += event.deltaY;
  }
}, { passive: false });
element('add-first-profile').addEventListener('click', () => send({ type: 'configure' }));
element('trust-button').addEventListener('click', () => send({ type: 'trust' }));
element('dismiss-error').addEventListener('click', () => showError(''));
for (const action of ['save', 'undo', 'redo', 'close'] as const) element(`${action}-action`).addEventListener('click', () => runAction(action));
element('refresh-shells').addEventListener('click', () => send({ type: 'refreshShells' }));
element('add-profile').addEventListener('click', () => {
  if (saving || draft.value.length >= MAX_PROFILES) return;
  draft.change(items => items.push(newProfile()));
  renderDraft();
  profileRows.querySelector<HTMLInputElement>('.profile-row:last-child input')?.focus();
});
element('cancel-configuration').addEventListener('click', closeConfiguration);
element<HTMLFormElement>('profile-form').addEventListener('submit', event => {
  event.preventDefault();
  saveProfiles();
});
configuration.addEventListener('keydown', event => {
  const modifier = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!modifier || event.altKey || event.isComposing || saving) return;
  const key = event.key.toLowerCase();
  if (key === 's') { event.preventDefault(); saveProfiles(); }
  else if (key === 'z') { event.preventDefault(); runAction(event.shiftKey ? 'redo' : 'undo'); }
  else if (!isMac && key === 'y') { event.preventDefault(); runAction('redo'); }
});

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  if (!message || typeof message.type !== 'string') return;
  switch (message.type) {
    case 'state': {
      const becameTrusted = !trusted && message.trusted;
      receivedState = true;
      profiles = message.profiles;
      trusted = message.trusted;
      appearance = message.appearance;
      shells = message.shells;
      sessions.clear();
      message.sessions.forEach(session => sessions.set(session.id, session));
      for (const [id, view] of terminals) {
        if (!profiles.some(profile => profile.id === id)) { view.terminal.dispose(); view.pane.remove(); terminals.delete(id); }
      }
      const selectedId = profiles.some(profile => profile.id === message.activeId) ? message.activeId
        : profiles.some(profile => profile.id === activeId) ? activeId : profiles[0]?.id;
      if (selectedId !== activeId || becameTrusted) needsActivation = true;
      activeId = selectedId;
      if (activeId) selectProfile(activeId);
      else renderTabs();
      if (configuring && !saving) {
        if (!draft.dirty && JSON.stringify(draft.base) !== JSON.stringify(profiles)) draft.reset(profiles);
        renderDraft();
      }
      updateAppearance();
      renderContent();
      scheduleFit();
      break;
    }
    case 'output': {
      const profile = profiles.find(item => item.id === message.id);
      if (profile) ensureTerminal(profile).terminal.write(message.data);
      break;
    }
    case 'session':
      sessions.set(message.session.id, message.session);
      updateStatus();
      updateActions();
      // Session events must not rebuild the tab bar or disturb keyboard focus.
      if (document.getElementById(`tab-${message.session.id}`)) element(`tab-${message.session.id}`).dataset.status = message.session.status;
      break;
    case 'reset': terminals.get(message.id)?.terminal.reset(); break;
    case 'paste':
      if (trusted) terminals.get(message.id)?.terminal.paste(message.data);
      break;
    case 'saved':
      profiles = message.profiles;
      for (const [id, view] of terminals) {
        if (!profiles.some(profile => profile.id === id)) { view.terminal.dispose(); view.pane.remove(); terminals.delete(id); }
      }
      if (!profiles.some(profile => profile.id === activeId)) { activeId = profiles[0]?.id; needsActivation = true; }
      if (activeId) selectProfile(activeId);
      else renderTabs();
      saving = false;
      closeConfiguration();
      showError('');
      break;
    case 'error':
      showError(message.message);
      if (saving) { saving = false; saveButton.disabled = false; saveButton.textContent = 'Save'; renderDraft(); }
      break;
    case 'configure': openConfiguration(); break;
    case 'action': runAction(message.action); break;
  }
});

new ResizeObserver(scheduleFit).observe(terminalHost);
const themeObserver = new MutationObserver(updateAppearance);
themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
document.fonts?.ready.then(scheduleFit).catch(() => undefined);
window.addEventListener('beforeunload', () => {
  themeObserver.disconnect();
  for (const view of terminals.values()) view.terminal.dispose();
});
renderContent();
send({ type: 'ready' });
