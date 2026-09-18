import type { client_message, sidebar_configuration, terminal_profile } from './types';
import { is_tab_marker } from './tab_marker';
import { is_export_payload } from './export_format';

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

const maximum_launch_entries = 128;
const maximum_launch_value_bytes = 8192;
const maximum_launch_bytes = 32768;
const utf8_encoder = new TextEncoder();

/** Copy literal arguments without interpreting quotes, spaces, or shell syntax. */
export function parse_profile_args(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > maximum_launch_entries) {
    throw new Error('Shell arguments must be an array with at most 128 strings.');
  }
  let total_bytes = 0;
  return Array.from(value, (argument: unknown) => {
    if (typeof argument !== 'string' || argument.length > maximum_launch_value_bytes || argument.includes('\0')) {
      throw new Error('Each shell argument must be a string without NUL characters and at most 8192 UTF-8 bytes.');
    }
    const argument_bytes = utf8_encoder.encode(argument).length;
    total_bytes += argument_bytes + 1;
    if (argument_bytes > maximum_launch_value_bytes || total_bytes > maximum_launch_bytes) {
      throw new Error('Shell arguments must use at most 8192 UTF-8 bytes each and 32768 bytes in total.');
    }
    return argument;
  });
}

/** Copy bounded environment overrides. Null explicitly removes an inherited value. */
export function parse_profile_env(value: unknown): Record<string, string | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error('Shell environment overrides must be an object of string or null values.');
  }
  const entries = Object.entries(value);
  if (entries.length > maximum_launch_entries) {
    throw new Error('Shell environment overrides accept at most 128 variables.');
  }
  let total_bytes = 0;
  for (const [key, environment_value] of entries) {
    if (!key || key.length > 256 || /[=\x00-\x1f\x7f]/.test(key)
      || ['__proto__', 'constructor', 'prototype'].includes(key.toLowerCase())) {
      throw new Error('Shell environment variable names must be nonempty, at most 256 UTF-8 bytes, and contain no equals signs, control characters, or reserved prototype names.');
    }
    if (environment_value !== null && (typeof environment_value !== 'string'
      || environment_value.length > maximum_launch_value_bytes || environment_value.includes('\0'))) {
      throw new Error('Shell environment values must be null or strings without NUL characters and at most 8192 UTF-8 bytes.');
    }
    const key_bytes = utf8_encoder.encode(key).length;
    const value_bytes = environment_value === null ? 0 : utf8_encoder.encode(environment_value).length;
    total_bytes += key_bytes + value_bytes + 2;
    if (key_bytes > 256 || value_bytes > maximum_launch_value_bytes || total_bytes > maximum_launch_bytes) {
      throw new Error('Shell environment overrides exceed the 256-byte name, 8192-byte value, or 32768-byte total UTF-8 limit.');
    }
  }
  return Object.fromEntries(entries);
}

/** Parse one side atomically. Commands may contain newlines; names and paths may not. */
export function parse_profiles(value: unknown): terminal_profile[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error('Each sidebar accepts an array with at most 32 startup terminals.');
  }
  const identifiers = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Sidebar ${index} must be an object.`);
    }
    const { id, name, command = '', shell = '', args, env } = entry as Record<string, unknown>;
    if (!is_identifier(id) || identifiers.has(id)) {
      throw new Error(`Sidebar ${index} needs a unique ID containing letters, numbers, underscores, or hyphens.`);
    }
    if (!is_tab_name(name)) {
      throw new Error(`Sidebar ${index} needs a name of 1–80 characters on one line.`);
    }
    if (typeof command !== 'string' || command.length > 8192 || command.includes('\0')) {
      throw new Error(`Sidebar ${index} has an invalid startup command.`);
    }
    if (typeof shell !== 'string' || shell.length > 1024 || /[\0\r\n]/.test(shell)) {
      throw new Error(`Sidebar ${index} needs a shell executable name or path on one line.`);
    }
    identifiers.add(id);
    return {
      id, name: name.trim(), command, shell: shell.trim(),
      ...(args === undefined ? {} : { args: parse_profile_args(args) }),
      ...(env === undefined ? {} : { env: parse_profile_env(env) }),
    };
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

function is_link_uri(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)
    || !/^https?:\/\//i.test(value)) return false;
  try {
    const uri = new URL(value);
    return (uri.protocol === 'http:' || uri.protocol === 'https:') && Boolean(uri.hostname);
  } catch {
    return false;
  }
}

function is_file_position(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 10_000_000;
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
    case 'open_other_sidebar':
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
    case 'request_rename':
    case 'paste':
    case 'focus':
    case 'select':
      return valid_identifier;
    case 'rename_tab':
      return valid_identifier && is_tab_name(message.name);
    case 'set_tab_marker':
      return valid_identifier && (message.marker === undefined || is_tab_marker(message.marker));
    case 'move_tab':
      return valid_identifier && is_identifier(message.target_id) && message.id !== message.target_id
        && (message.placement === 'before' || message.placement === 'after');
    case 'expanded':
      return valid_identifier && typeof message.expanded === 'boolean';
    case 'export':
      return valid_identifier && is_export_payload(message.format, message.text);
    case 'replace_copy':
      return valid_identifier && is_export_payload('text', message.text);
    case 'open_link':
      return valid_identifier && is_link_uri(message.uri);
    case 'open_file':
      return valid_identifier && typeof message.path === 'string' && message.path.trim().length > 0
        && message.path.length <= 4096 && !/[\x00-\x1f\x7f]/.test(message.path)
        && is_file_position(message.line) && (message.column === undefined || is_file_position(message.column));
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
