import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { Appearance, ClientMessage, HostMessage, Profile, SessionInfo } from '../src/types';
import '@xterm/xterm/css/xterm.css';
import './main.css';

declare function acquireVsCodeApi(): { postMessage(message: ClientMessage): void };

const vscode = acquireVsCodeApi();
const send = (message: ClientMessage): void => vscode.postMessage(message);
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const MAX_PROFILES = 32;
const icons = {
  settings: '<path d="m9.6 2 .4 1.7 1.5.9 1.7-.5 1.4 2.4-1.3 1.2v1.7l1.3 1.2-1.4 2.4-1.7-.5-1.5.9-.4 1.7H6.8l-.4-1.7-1.5-.9-1.7.5-1.4-2.4 1.3-1.2V7.7L1.8 6.5l1.4-2.4 1.7.5 1.5-.9.4-1.7Z"/><circle cx="8.2" cy="8.5" r="2.2"/>',
  restart: '<path d="M3.1 5.1a5.5 5.5 0 1 1-.6 5.1M3 1.8v3.8h3.8"/>',
  stop: '<rect x="4" y="4" width="8" height="8" rx=".5"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M10.5 3H3v7.5"/>',
  paste: '<path d="M6 3H3v11h10V3h-3M6 2h4v3H6Z"/>',
};
const icon = (name: keyof typeof icons): string => `<svg viewBox="0 0 16 16" aria-hidden="true">${icons[name]}</svg>`;
const app = document.getElementById('app') ?? document.body.appendChild(document.createElement('div'));
app.id = 'app';
app.innerHTML = `
  <header id="terminal-header">
    <div id="profile-tabs" role="tablist" aria-label="Terminal profiles"></div>
    <div id="toolbar" role="toolbar" aria-label="Terminal actions">
      <button id="copy-button" class="icon-button" type="button" aria-label="Copy selection" title="Copy selection">${icon('copy')}</button>
      <button id="paste-button" class="icon-button" type="button" aria-label="Paste" title="Paste">${icon('paste')}</button>
      <button id="restart-button" class="icon-button" type="button" aria-label="Restart terminal" title="Restart terminal">${icon('restart')}</button>
      <button id="stop-button" class="icon-button" type="button" aria-label="Stop terminal" title="Stop terminal">${icon('stop')}</button>
      <button id="configure-button" class="icon-button" type="button" aria-label="Configure profiles" title="Configure profiles">${icon('settings')}</button>
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
    <div class="configuration-heading"><h2 id="configuration-title">Terminal profiles</h2><p>Each profile has its own terminal tab. Profiles can sync with your user settings; keep secrets out of commands.</p></div>
    <form id="profile-form">
      <div id="profile-rows"></div>
      <button id="add-profile" class="secondary" type="button" aria-describedby="profile-limit">+ Add profile</button>
      <p id="profile-limit" class="field-hint" hidden>32 profiles added. Remove one to add another.</p>
      <datalist id="shell-options"><option value="powershell"><option value="cmd"><option value="bash"><option value="zsh"><option value="fish"></datalist>
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
let draft: Profile[] = [];
let draftDirty = false;
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
  if (existing) return existing;
  const pane = document.createElement('div');
  pane.id = `terminal-${profile.id}`;
  pane.className = 'terminal-pane';
  pane.setAttribute('role', 'tabpanel');
  pane.setAttribute('aria-labelledby', `tab-${profile.id}`);
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
  element<HTMLButtonElement>('copy-button').disabled = !hasTerminal || !terminals.get(activeId!)?.terminal.hasSelection();
  element<HTMLButtonElement>('paste-button').disabled = !hasTerminal || sessions.get(activeId!)?.status !== 'running';
  element<HTMLButtonElement>('restart-button').disabled = !hasTerminal;
  element<HTMLButtonElement>('stop-button').disabled = !hasTerminal || sessions.get(activeId!)?.status !== 'running';
  element<HTMLButtonElement>('configure-button').setAttribute('aria-pressed', String(configuring));
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
  let number = draft.length;
  while (draft.some(profile => profile.name === `Customized sidebar #${number}`)) number++;
  return { id: crypto.randomUUID(), name: `Customized sidebar #${number}`, command: '', shell: '' };
}

function openConfiguration(add = false): void {
  if (!configuring) {
    draft = profiles.map(profile => ({ ...profile }));
    draftDirty = false;
    configuring = true;
  }
  if (add && draft.length < MAX_PROFILES) {
    draft.push(newProfile());
    draftDirty = true;
  }
  renderDraft();
  renderContent();
  const firstInput = configuration.querySelector<HTMLInputElement>(add ? '.profile-row:last-child input' : 'input');
  (firstInput ?? element('add-profile')).focus();
}

function closeConfiguration(): void {
  configuring = false;
  draftDirty = false;
  saving = false;
  saveButton.disabled = false;
  saveButton.textContent = 'Save';
  renderContent();
  scheduleFit();
  requestAnimationFrame(() => terminals.get(activeId ?? '')?.terminal.focus());
}

function renderDraft(): void {
  profileRows.replaceChildren();
  if (!draft.length) {
    const empty = document.createElement('p');
    empty.className = 'configuration-empty';
    empty.textContent = 'No profiles yet. Add a profile below.';
    profileRows.append(empty);
  }
  draft.forEach((profile, index) => {
    const row = document.createElement('fieldset');
    row.className = 'profile-row';
    row.dataset.profileId = profile.id;
    const legend = document.createElement('legend');
    legend.textContent = `Customized sidebar #${index}`;
    row.append(legend);
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    const rowAction = (text: string, label: string, disabled: boolean, action: () => void): void => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'row-button';
      button.textContent = text;
      button.title = label;
      button.setAttribute('aria-label', `${label}: ${profile.name || `profile ${index + 1}`}`);
      button.disabled = disabled || saving;
      button.addEventListener('click', () => {
        action();
        draftDirty = true;
        renderDraft();
        const focusId = draft.some(item => item.id === profile.id) ? profile.id : draft[Math.min(index, draft.length - 1)]?.id;
        const nextRow = Array.from(profileRows.querySelectorAll<HTMLElement>('.profile-row')).find(item => item.dataset.profileId === focusId);
        const nextButton = Array.from(nextRow?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(item => item.textContent === text && !item.disabled);
        (nextButton ?? nextRow?.querySelector<HTMLInputElement>('input') ?? element('add-profile')).focus();
      });
      actions.append(button);
    };
    rowAction('↑', 'Move up', index === 0, () => { [draft[index - 1], draft[index]] = [draft[index]!, draft[index - 1]!]; });
    rowAction('↓', 'Move down', index === draft.length - 1, () => { [draft[index + 1], draft[index]] = [draft[index]!, draft[index + 1]!]; });
    rowAction('Remove', 'Remove profile', false, () => { draft.splice(index, 1); });
    row.append(actions);
    const field = (key: 'name' | 'command' | 'shell', title: string, hint: string, placeholder: string): void => {
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
      if (key === 'command') input.maxLength = 8192;
      if (key === 'shell') input.maxLength = 1024;
      if (key === 'shell') input.setAttribute('list', 'shell-options');
      if (input instanceof HTMLTextAreaElement) input.rows = 2;
      input.addEventListener('input', () => { profile[key] = input.value; draftDirty = true; });
      label.htmlFor = input.id;
      label.textContent = title;
      row.append(label, input);
      if (hint) {
        const note = document.createElement('p');
        note.id = `${input.id}-hint`;
        note.className = 'field-hint';
        note.textContent = hint;
        input.setAttribute('aria-describedby', note.id);
        row.append(note);
      }
    };
    field('name', 'Name', '', `Customized sidebar #${index}`);
    field('command', 'Automatic command', 'Runs once when this profile starts or restarts.', 'Optional command');
    field('shell', 'Shell', 'Leave blank to use the default shell. A shell name or executable path is supported.', 'Default shell');
    profileRows.append(row);
  });
  element<HTMLButtonElement>('add-profile').disabled = saving || draft.length >= MAX_PROFILES;
  element('profile-limit').hidden = draft.length < MAX_PROFILES;
  element<HTMLButtonElement>('cancel-configuration').disabled = saving;
}

tabs.addEventListener('wheel', event => {
  if (tabs.scrollWidth > tabs.clientWidth && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
    event.preventDefault();
    tabs.scrollLeft += event.deltaY;
  }
}, { passive: false });
element('configure-button').addEventListener('click', () => { if (!configuring) openConfiguration(); });
element('add-first-profile').addEventListener('click', () => openConfiguration(true));
element('trust-button').addEventListener('click', () => send({ type: 'trust' }));
element('dismiss-error').addEventListener('click', () => showError(''));
element('copy-button').addEventListener('click', () => copySelection());
element('paste-button').addEventListener('click', () => {
  if (trusted && activeId) { send({ type: 'paste', id: activeId }); terminals.get(activeId)?.terminal.focus(); }
});
element('restart-button').addEventListener('click', () => {
  if (!trusted || !activeId) return;
  const view = terminals.get(activeId);
  if (view) {
    view.fit.fit();
    send({ type: 'restart', id: activeId, cols: view.terminal.cols, rows: view.terminal.rows });
    view.terminal.focus();
  }
});
element('stop-button').addEventListener('click', () => { if (activeId) send({ type: 'stop', id: activeId }); });
element('add-profile').addEventListener('click', () => {
  if (saving || draft.length >= MAX_PROFILES) return;
  draft.push(newProfile());
  draftDirty = true;
  renderDraft();
  profileRows.querySelector<HTMLInputElement>('.profile-row:last-child input')?.focus();
});
element('cancel-configuration').addEventListener('click', closeConfiguration);
element<HTMLFormElement>('profile-form').addEventListener('submit', event => {
  event.preventDefault();
  if (saving) return;
  if (draft.some(profile => !profile.name.trim())) { showError('Give each profile a name before saving.'); return; }
  saving = true;
  saveButton.disabled = true;
  saveButton.textContent = 'Saving…';
  showError('');
  renderDraft();
  send({ type: 'save', profiles: draft.map(profile => ({ ...profile, name: profile.name.trim(), shell: profile.shell.trim() })) });
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
      if (configuring && !draftDirty && !saving) { draft = profiles.map(profile => ({ ...profile })); renderDraft(); }
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
      closeConfiguration();
      showError('');
      break;
    case 'error':
      showError(message.message);
      if (saving) { saving = false; saveButton.disabled = false; saveButton.textContent = 'Save'; renderDraft(); }
      break;
    case 'configure': openConfiguration(); break;
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
