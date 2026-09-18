import * as path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath as file_url_to_path } from 'node:url';
import type { export_format } from './types';
import { export_extensions } from './export_format';

/** Terminal output is untrusted: only ordinary web URLs may leave the editor. */
export function web_link(value: string): string | undefined {
  if (!value || value.length > 8192 || /[\x00-\x20\x7f]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

/** Resolve a clicked compiler location against this terminal's reported cwd. */
export function terminal_file(value: string, cwd: string, platform: NodeJS.Platform = process.platform, home = homedir()): string | undefined {
  if (!value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) return undefined;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  let file = value;
  if (value.startsWith('file:')) {
    try {
      const url = new URL(value);
      if (url.hostname && url.hostname !== 'localhost') return undefined;
      file = file_url_to_path(url, { windows: platform === 'win32' });
    } catch {
      return undefined;
    }
  } else if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) {
    return undefined;
  }
  // Network shares can authenticate on access; terminal text must not initiate that.
  if (/^[\\/]{2}/.test(file) || /[\x00-\x1f\x7f]/.test(file)) return undefined;
  if (file.startsWith('~/') || (platform === 'win32' && file.startsWith('~\\'))) {
    file = paths.join(home, file.slice(2));
  }
  if (!paths.isAbsolute(cwd)) return undefined;
  return paths.resolve(cwd, file);
}

export function export_filename(name: string, format: export_format): string {
  let stem = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || 'terminal';
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) stem = `_${stem}`;
  return `${stem}.${export_extensions[format]}`;
}
