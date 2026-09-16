import type { ClientMessage, Profile } from './types';

export const DEFAULT_PROFILES: Profile[] = [{ id: 'default', name: 'Terminal', command: '', shell: '' }];

/** Reject the entire update so a malformed setting never launches a partial profile. */
export function parseProfiles(value: unknown): Profile[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error('Profiles must be an array with at most 32 entries.');
  const ids = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`Sidebar #${index} must be an object.`);
    const { id, name, command = '', shell = '' } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || ids.has(id)) {
      throw new Error(`Sidebar #${index} needs a unique ID containing letters, numbers, underscores, or hyphens.`);
    }
    if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\0\r\n]/.test(name)) {
      throw new Error(`Sidebar #${index} needs a name of 1–80 characters on one line.`);
    }
    if (typeof command !== 'string' || command.length > 8192 || command.includes('\0')) {
      throw new Error(`Sidebar #${index} has an invalid startup command.`);
    }
    if (typeof shell !== 'string' || shell.length > 1024 || /[\0\r\n]/.test(shell)) {
      throw new Error(`Sidebar #${index} needs a shell executable name or path on one line.`);
    }
    ids.add(id);
    return { id, name: name.trim(), command, shell: shell.trim() };
  });
}

/** Webviews are a message boundary; do not rely on TypeScript types at runtime. */
export function isClientMessage(value: unknown): value is ClientMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const m = value as Record<string, unknown>;
  const id = typeof m.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(m.id);
  const size = Number.isInteger(m.cols) && Number.isInteger(m.rows)
    && Number(m.cols) > 0 && Number(m.cols) <= 1000 && Number(m.rows) > 0 && Number(m.rows) <= 1000;
  switch (m.type) {
    case 'ready': case 'settings': case 'trust': case 'selectProfile': case 'configure': case 'refreshShells': return true;
    case 'activate': case 'restart': case 'resize': return id && size;
    case 'input': return id && typeof m.data === 'string' && m.data.length <= 1024 * 1024;
    case 'stop': case 'paste': case 'focus': return id;
    case 'export': return id && typeof m.text === 'string' && m.text.length <= 1024 * 1024;
    case 'draftState': return typeof m.configuring === 'boolean' && typeof m.canUndo === 'boolean' && typeof m.canRedo === 'boolean';
    case 'copy': return typeof m.text === 'string' && m.text.length <= 1024 * 1024;
    case 'save': return Array.isArray(m.profiles) && m.profiles.length <= 32 && Array.isArray(m.baseProfiles) && m.baseProfiles.length <= 32;
    default: return false;
  }
}
