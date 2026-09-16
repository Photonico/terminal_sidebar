import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface DiscoverShellsOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  configuredProfiles?: Record<string, { path?: string | string[]; source?: string } | null>;
}

export interface DiscoveredShell {
  name: string;
  path: string;
  source: 'profile' | 'environment' | 'path' | 'system';
}

const PRESETS: Record<string, string> = {
  pwsh: 'PowerShell', powershell: 'Windows PowerShell', cmd: 'Command Prompt',
  bash: 'Bash', zsh: 'Zsh', fish: 'Fish', sh: 'Sh', dash: 'Dash', ksh: 'Ksh', nu: 'Nushell',
};
const MAX_CANDIDATES = 1024;
const MAX_DIRECTORIES = 64;
const MAX_DURATION_MS = 3000;

/** Inspect this extension host only. No shell, login script, or subprocess is executed. */
export async function discoverShells(options: DiscoverShellsOptions = {}): Promise<DiscoveredShell[]> {
  const windows = (options.platform ?? process.platform) === 'win32';
  const pathApi = windows ? path.win32 : path.posix;
  const env = options.env ?? process.env;
  const getEnv = (name: string): string | undefined => {
    const key = windows ? Object.keys(env).find(value => value.toLowerCase() === name.toLowerCase()) : name;
    return key === undefined ? undefined : env[key];
  };
  const home = options.homeDir ?? getEnv(windows ? 'USERPROFILE' : 'HOME') ?? os.homedir();
  const clean = (input: unknown): string | undefined => {
    if (typeof input !== 'string' || input.length > 4096 || /[\0\r\n]/.test(input)) return undefined;
    let value = input.trim().replace(/^"(.*)"$/, '$1');
    value = value.replace(/\$\{userHome\}/g, () => home);
    value = value.replace(/\$\{env:([^}]+)\}/g, (_, name: string) => getEnv(name) ?? '${unresolved}');
    if (windows) value = value.replace(/%([^%]+)%/g, (_, name: string) => getEnv(name) ?? '${unresolved}');
    if (/^~(?:[/\\]|$)/.test(value)) value = home + value.slice(1);
    if (!value || /[\0\r\n]/.test(value) || /\$\{[^}]*\}/.test(value)) return undefined;
    return value;
  };
  const directories = [...new Set((getEnv('PATH') ?? '').split(windows ? ';' : ':')
    .slice(0, MAX_DIRECTORIES).map(clean)
    .filter((value): value is string => Boolean(value && pathApi.isAbsolute(value))))];
  const extensions = windows
    ? [...new Set(['.exe', ...(getEnv('PATHEXT') ?? '.COM').split(';')]
      .filter(value => /^\.(exe|com)$/i.test(value)).map(value => value.toLowerCase()))]
    : [''];
  const candidates = new Map<string, DiscoveredShell>();
  const add = (requested: unknown, source: DiscoveredShell['source'], name?: string): void => {
    const value = clean(requested);
    if (!value || candidates.size >= MAX_CANDIDATES) return;
    const absolute = pathApi.isAbsolute(value);
    // Never discover executables relative to the current workspace, including empty PATH entries.
    if (!absolute && (value.includes('/') || value.includes('\\') || value.includes(':'))) return;
    const suffixes = windows && !pathApi.extname(value) ? extensions : [''];
    for (const directory of absolute ? [''] : directories) {
      for (const suffix of suffixes) {
        const file = pathApi.normalize((absolute ? value : pathApi.join(directory, value)) + suffix);
        if (windows && !/\.(exe|com)$/i.test(file)) continue; // CreateProcess cannot start batch scripts directly.
        const key = windows ? file.toLowerCase() : file;
        const base = pathApi.basename(file).toLowerCase().replace(/\.(exe|com)$/i, '');
        if (!candidates.has(key)) candidates.set(key, { name: name || PRESETS[base] || pathApi.basename(file), path: file, source });
        if (candidates.size >= MAX_CANDIDATES) return;
      }
    }
  };

  for (const [label, profile] of Object.entries(options.configuredProfiles ?? {}).slice(0, 64)) {
    if (!profile || typeof profile !== 'object') continue;
    const name = typeof label === 'string' && !/[\0\r\n]/.test(label) ? label.slice(0, 80) : undefined;
    const paths = Array.isArray(profile.path) ? profile.path.slice(0, 8) : [profile.path];
    for (const file of paths) add(file, 'profile', name);
    if (profile.source === 'PowerShell') {
      add('pwsh', 'profile', name);
      if (windows) add('powershell', 'profile', name);
    }
    if (windows && profile.source === 'Git Bash') {
      for (const root of [getEnv('ProgramFiles'), getEnv('ProgramFiles(x86)')]) {
        if (root) add(pathApi.join(root, 'Git', 'bin', 'bash.exe'), 'profile', name);
      }
    }
  }
  add(getEnv(windows ? 'COMSPEC' : 'SHELL'), 'environment');
  if (windows) {
    const systemRoot = clean(getEnv('SystemRoot') ?? getEnv('WINDIR'));
    if (systemRoot) {
      add(pathApi.join(systemRoot, 'System32', 'cmd.exe'), 'system');
      add(pathApi.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), 'system');
    }
    for (const root of [getEnv('ProgramFiles'), getEnv('ProgramFiles(x86)')]) {
      if (!root) continue;
      add(pathApi.join(root, 'PowerShell', '7', 'pwsh.exe'), 'system');
      add(pathApi.join(root, 'Git', 'bin', 'bash.exe'), 'system', 'Git Bash');
    }
    const local = getEnv('LOCALAPPDATA');
    if (local) add(pathApi.join(local, 'Programs', 'Git', 'bin', 'bash.exe'), 'system', 'Git Bash');
  } else {
    for (const directory of ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin', '/opt/local/bin']) {
      for (const name of Object.keys(PRESETS).filter(value => !['powershell', 'cmd'].includes(value))) {
        add(pathApi.join(directory, name), 'system');
      }
    }
  }
  for (const name of Object.keys(PRESETS)) add(name, 'path');

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const found = new Map<number, { shell: DiscoveredShell; key: string }>();
  const scan = async (): Promise<void> => {
    if (!windows) {
      // Read at most 32 KiB, even when /etc/shells is malformed or unexpectedly large.
      let file: Awaited<ReturnType<typeof fs.open>> | undefined;
      try {
        file = await fs.open('/etc/shells', 'r');
        if (stopped) return;
        const buffer = Buffer.alloc(32768);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (stopped) return;
        for (const line of buffer.toString('utf8', 0, bytesRead).split(/\r?\n/).slice(0, 256)) {
          const entry = line.split('#', 1)[0].trim();
          if (pathApi.isAbsolute(entry)) add(entry, 'system');
        }
      } catch { /* /etc/shells is optional, including in containers and remote hosts. */ }
      finally { await file?.close().catch(() => undefined); }
    }
    const entries = [...candidates.values()];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (!stopped && next < entries.length) {
        const index = next++;
        const shell = entries[index];
        try {
          await fs.access(shell.path, windows ? constants.F_OK : constants.X_OK);
          if (stopped) return;
          if (!(await fs.stat(shell.path)).isFile() || stopped) continue;
          const canonical = await fs.realpath(shell.path);
          if (stopped) return;
          // Preserve sh versus bash: argv[0] can change shell behaviour even for a symlink.
          const identity = canonical + '\0' + pathApi.basename(shell.path);
          found.set(index, { shell, key: windows ? identity.toLowerCase() : identity });
        } catch { /* Broken links, missing files and permission errors are not choices. */ }
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
  };
  try {
    await Promise.race([
      scan(),
      new Promise<void>(resolve => { timer = setTimeout(() => { stopped = true; resolve(); }, MAX_DURATION_MS); }),
    ]);
  } finally {
    stopped = true;
    clearTimeout(timer);
  }
  const seen = new Set<string>();
  return [...found.entries()].sort(([a], [b]) => a - b).flatMap(([, { shell, key }]) => {
    if (seen.has(key)) return [];
    seen.add(key);
    return [shell];
  });
}
