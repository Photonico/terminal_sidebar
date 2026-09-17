import * as file_system from 'node:fs/promises';
import { constants } from 'node:fs';
import * as operating_system from 'node:os';
import * as path from 'node:path';

export interface discover_shells_options {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home_directory?: string;
  configured_profiles?: Record<string, { path?: string | string[]; source?: string } | null>;
}

export interface discovered_shell {
  name: string;
  path: string;
  source: 'profile' | 'environment' | 'path' | 'system';
}

const shell_names: Record<string, string> = {
  pwsh: 'PowerShell', powershell: 'Windows PowerShell', cmd: 'Command Prompt',
  bash: 'Bash', zsh: 'Zsh', fish: 'Fish', sh: 'Sh', dash: 'Dash', ksh: 'Ksh', nu: 'Nushell',
};
const maximum_candidates = 1024;
const maximum_directories = 64;
const maximum_duration_milliseconds = 3000;

/**
 * Return installed shell choices for this extension host, preserving discovery priority.
 * Inspection executes no shell or login script. It stops after three seconds and
 * probes at most 1,024 candidates across 64 PATH directories with eight workers.
 */
export async function discover_shells(options: discover_shells_options = {}): Promise<discovered_shell[]> {
  const windows = (options.platform ?? process.platform) === 'win32';
  const path_operations = windows ? path.win32 : path.posix;
  const environment = options.env ?? process.env;
  const get_environment_value = (name: string): string | undefined => {
    const key = windows
      ? Object.keys(environment).find(value => value.toLowerCase() === name.toLowerCase())
      : name;
    return key === undefined ? undefined : environment[key];
  };
  const home_directory = options.home_directory ?? get_environment_value(windows ? 'USERPROFILE' : 'HOME') ?? operating_system.homedir();
  const clean_path = (input: unknown): string | undefined => {
    if (typeof input !== 'string' || input.length > 4096 || /[\0\r\n]/.test(input)) return undefined;
    let value = input.trim().replace(/^"(.*)"$/, '$1');
    value = value.replace(/\$\{userHome\}/g, () => home_directory);
    value = value.replace(/\$\{env:([^}]+)\}/g, (_, name: string) => get_environment_value(name) ?? '${unresolved}');
    if (windows) {
      value = value.replace(/%([^%]+)%/g, (_, name: string) => get_environment_value(name) ?? '${unresolved}');
    }
    if (/^~(?:[/\\]|$)/.test(value)) value = home_directory + value.slice(1);
    if (!value || /[\0\r\n]/.test(value) || /\$\{[^}]*\}/.test(value)) return undefined;
    return value;
  };
  const path_entries = (get_environment_value('PATH') ?? '').split(windows ? ';' : ':');
  const absolute_directories = path_entries.slice(0, maximum_directories).map(clean_path)
    .filter((value): value is string => Boolean(value && path_operations.isAbsolute(value)));
  const directories = [...new Set(absolute_directories)];
  const extensions = windows
    ? [...new Set(['.exe', ...(get_environment_value('PATHEXT') ?? '.COM').split(';')]
      .filter(value => /^\.(exe|com)$/i.test(value)).map(value => value.toLowerCase()))]
    : [''];
  const candidates = new Map<string, discovered_shell>();
  const add_candidate = (requested: unknown, source: discovered_shell['source'], name?: string): void => {
    const value = clean_path(requested);
    if (!value || candidates.size >= maximum_candidates) return;
    const absolute = path_operations.isAbsolute(value);
    // Never discover executables relative to the current workspace, including empty PATH entries.
    if (!absolute && (value.includes('/') || value.includes('\\') || value.includes(':'))) return;
    const suffixes = windows && !path_operations.extname(value) ? extensions : [''];
    for (const directory of absolute ? [''] : directories) {
      for (const suffix of suffixes) {
        const file = path_operations.normalize((absolute ? value : path_operations.join(directory, value)) + suffix);
        if (windows && !/\.(exe|com)$/i.test(file)) continue; // CreateProcess cannot start batch scripts directly.
        const key = windows ? file.toLowerCase() : file;
        const base = path_operations.basename(file).toLowerCase().replace(/\.(exe|com)$/i, '');
        if (!candidates.has(key)) {
          candidates.set(key, { name: name || shell_names[base] || path_operations.basename(file), path: file, source });
        }
        if (candidates.size >= maximum_candidates) return;
      }
    }
  };

  for (const [label, profile] of Object.entries(options.configured_profiles ?? {}).slice(0, 64)) {
    if (!profile || typeof profile !== 'object') continue;
    const name = typeof label === 'string' && !/[\0\r\n]/.test(label) ? label.slice(0, 80) : undefined;
    const paths = Array.isArray(profile.path) ? profile.path.slice(0, 8) : [profile.path];
    for (const file of paths) add_candidate(file, 'profile', name);
    if (profile.source === 'PowerShell') {
      add_candidate('pwsh', 'profile', name);
      if (windows) add_candidate('powershell', 'profile', name);
    }
    if (windows && profile.source === 'Git Bash') {
      for (const root of [get_environment_value('ProgramFiles'), get_environment_value('ProgramFiles(x86)')]) {
        if (root) add_candidate(path_operations.join(root, 'Git', 'bin', 'bash.exe'), 'profile', name);
      }
    }
  }
  add_candidate(get_environment_value(windows ? 'COMSPEC' : 'SHELL'), 'environment');
  if (windows) {
    const system_root = clean_path(get_environment_value('SystemRoot') ?? get_environment_value('WINDIR'));
    if (system_root) {
      add_candidate(path_operations.join(system_root, 'System32', 'cmd.exe'), 'system');
      add_candidate(path_operations.join(system_root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), 'system');
    }
    for (const root of [get_environment_value('ProgramFiles'), get_environment_value('ProgramFiles(x86)')]) {
      if (!root) continue;
      add_candidate(path_operations.join(root, 'PowerShell', '7', 'pwsh.exe'), 'system');
      add_candidate(path_operations.join(root, 'Git', 'bin', 'bash.exe'), 'system', 'Git Bash');
    }
    const local_application_data = get_environment_value('LOCALAPPDATA');
    if (local_application_data) {
      add_candidate(path_operations.join(local_application_data, 'Programs', 'Git', 'bin', 'bash.exe'), 'system', 'Git Bash');
    }
  } else {
    for (const directory of ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin', '/opt/local/bin']) {
      for (const name of Object.keys(shell_names).filter(value => !['powershell', 'cmd'].includes(value))) {
        add_candidate(path_operations.join(directory, name), 'system');
      }
    }
  }
  for (const name of Object.keys(shell_names)) add_candidate(name, 'path');

  // Collect results by candidate index; filesystem completion order must not reorder the picker.
  let stopped = false;
  let timeout_handle: ReturnType<typeof setTimeout> | undefined;
  const found = new Map<number, { shell: discovered_shell; key: string }>();
  const scan = async (): Promise<void> => {
    if (!windows) {
      // Read at most 32 KiB, even when /etc/shells is malformed or unexpectedly large.
      let file: Awaited<ReturnType<typeof file_system.open>> | undefined;
      try {
        file = await file_system.open('/etc/shells', 'r');
        if (stopped) return;
        const buffer = Buffer.alloc(32768);
        const { bytesRead: bytes_read } = await file.read(buffer, 0, buffer.length, 0);
        if (stopped) return;
        for (const line of buffer.toString('utf8', 0, bytes_read).split(/\r?\n/).slice(0, 256)) {
          const entry = line.split('#', 1)[0].trim();
          if (path_operations.isAbsolute(entry)) add_candidate(entry, 'system');
        }
      } catch { /* /etc/shells is optional, including in containers and remote hosts. */ }
      finally { await file?.close().catch(() => undefined); }
    }
    const entries = [...candidates.values()];
    let next_index = 0;
    const worker = async (): Promise<void> => {
      while (!stopped && next_index < entries.length) {
        const index = next_index++;
        const shell = entries[index];
        try {
          await file_system.access(shell.path, windows ? constants.F_OK : constants.X_OK);
          if (stopped) return;
          if (!(await file_system.stat(shell.path)).isFile() || stopped) continue;
          const canonical_path = await file_system.realpath(shell.path);
          if (stopped) return;
          // Preserve sh versus bash: argv[0] can change shell behaviour even for a symlink.
          const identity = canonical_path + '\0' + path_operations.basename(shell.path);
          found.set(index, { shell, key: windows ? identity.toLowerCase() : identity });
        } catch { /* Broken links, missing files and permission errors are not choices. */ }
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
  };
  try {
    await Promise.race([
      scan(),
      new Promise<void>(resolve => {
        timeout_handle = setTimeout(() => {
          stopped = true;
          resolve();
        }, maximum_duration_milliseconds);
      }),
    ]);
  } finally {
    stopped = true;
    clearTimeout(timeout_handle);
  }
  const seen_paths = new Set<string>();
  const discovered_shells: discovered_shell[] = [];
  const ordered_results = [...found.entries()].sort(([first_index], [second_index]) => first_index - second_index);
  for (const [, { shell, key }] of ordered_results) {
    if (seen_paths.has(key)) continue;
    seen_paths.add(key);
    discovered_shells.push(shell);
  }
  return discovered_shells;
}
