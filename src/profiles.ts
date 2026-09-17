import type { client_message, sidebar_configuration, terminal_profile } from './types';

export const default_configuration: sidebar_configuration = {
  left: [],
  right: [{ id: 'default', name: 'Terminal', command: '', shell: '' }],
};

export function is_identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

export function is_tab_name(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 80 && !/[\x00-\x1f\x7f]/.test(value);
}

/** Parse one side atomically. Commands may contain newlines; names and paths may not. */
export function parse_profiles(value: unknown): terminal_profile[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error('Each sidebar accepts an array with at most 32 startup terminals.');
  }
  const identifiers = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Sidebar #${index} must be an object.`);
    }
    const { id, name, command = '', shell = '' } = entry as Record<string, unknown>;
    if (!is_identifier(id) || identifiers.has(id)) {
      throw new Error(`Sidebar #${index} needs a unique ID containing letters, numbers, underscores, or hyphens.`);
    }
    if (!is_tab_name(name)) {
      throw new Error(`Sidebar #${index} needs a name of 1–80 characters on one line.`);
    }
    if (typeof command !== 'string' || command.length > 8192 || command.includes('\0')) {
      throw new Error(`Sidebar #${index} has an invalid startup command.`);
    }
    if (typeof shell !== 'string' || shell.length > 1024 || /[\0\r\n]/.test(shell)) {
      throw new Error(`Sidebar #${index} needs a shell executable name or path on one line.`);
    }
    identifiers.add(id);
    return { id, name: name.trim(), command, shell: shell.trim() };
  });
}

/** Validate both sides before accepting an update. Duplicate IDs across sides are safe. */
export function parse_configuration(value: unknown): sidebar_configuration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Sidebar configuration must contain left and right startup arrays.');
  }
  const configuration = value as Record<string, unknown>;
  return { left: parse_profiles(configuration.left), right: parse_profiles(configuration.right) };
}

/** Explicit empty arrays remain empty; legacy settings belong to the right sidebar. */
export function read_configuration(value: unknown, legacy_value?: unknown): sidebar_configuration {
  if (value !== undefined) {
    return parse_configuration(value);
  }
  if (legacy_value !== undefined) {
    return { left: [], right: parse_profiles(legacy_value) };
  }
  return parse_configuration(default_configuration);
}

/** A webview is a runtime message boundary, even when its source is written in TypeScript. */
export function is_client_message(value: unknown): value is client_message {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const message = value as Record<string, unknown>;
  const valid_identifier = is_identifier(message.id);
  const valid_size = Number.isInteger(message.cols) && Number.isInteger(message.rows)
    && Number(message.cols) > 0 && Number(message.cols) <= 1000 && Number(message.rows) > 0 && Number(message.rows) <= 1000;
  switch (message.type) {
    case 'ready':
    case 'settings':
    case 'trust':
    case 'select_profile':
    case 'configure':
    case 'refresh_shells':
    case 'add_tab':
      return true;
    case 'activate':
    case 'restart':
    case 'resize':
      return valid_identifier && valid_size;
    case 'input':
      return valid_identifier && typeof message.data === 'string' && message.data.length <= 1024 * 1024;
    case 'close_tab':
    case 'paste':
    case 'focus':
    case 'select':
      return valid_identifier;
    case 'rename_tab':
      return valid_identifier && is_tab_name(message.name);
    case 'expanded':
      return valid_identifier && typeof message.expanded === 'boolean';
    case 'export':
      return valid_identifier && typeof message.text === 'string' && message.text.length <= 1024 * 1024;
    case 'draft_state':
      return typeof message.configuring === 'boolean' && typeof message.can_undo === 'boolean' && typeof message.can_redo === 'boolean';
    case 'copy':
      return typeof message.text === 'string' && message.text.length <= 1024 * 1024;
    case 'save':
      try {
        parse_configuration(message.configuration);
        parse_configuration(message.base_configuration);
        return true;
      } catch {
        return false;
      }
    default:
      return false;
  }
}
