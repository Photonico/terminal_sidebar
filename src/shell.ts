import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface ShellOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  defaultProfile?: {
    path: string | string[];
    args?: string[] | string;
    env?: Record<string, string | null>;
  };
}

export interface ResolvedShell {
  file: string;
  args: string[];
  env: Record<string, string>;
}

function environmentValue(env: Record<string, string>, key: string, windows: boolean): string | undefined {
  const actualKey = windows ? Object.keys(env).find((entry) => entry.toLowerCase() === key.toLowerCase()) : key;
  return actualKey === undefined ? undefined : env[actualKey];
}

function executable(candidate: string, windows: boolean): boolean {
  try {
    fs.accessSync(candidate, windows ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function findExecutable(requested: string, env: Record<string, string>, windows: boolean): string | undefined {
  if (!requested || /[\0\r\n]/.test(requested)) return undefined;
  const pathApi = windows ? path.win32 : path.posix;
  const hasDirectory = requested.includes('/') || (windows && (requested.includes('\\') || /^[a-z]:/i.test(requested)));
  const directories = hasDirectory ? [''] : (environmentValue(env, 'PATH', windows) ?? '').split(windows ? ';' : ':');
  const extensions = windows && !pathApi.extname(requested)
    ? ['', ...(environmentValue(env, 'PATHEXT', true) ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
    : [''];
  for (const directory of directories) {
    const unquotedDirectory = directory.replace(/^"(.*)"$/, '$1');
    const base = hasDirectory ? requested : pathApi.join(unquotedDirectory || '.', requested);
    for (const extension of extensions) {
      const candidate = base + extension;
      if (executable(candidate, windows)) return pathApi.resolve(candidate);
    }
  }
  return undefined;
}

function defaultArguments(file: string, windows: boolean): string[] {
  const name = (windows ? path.win32 : path.posix).basename(file).toLowerCase().replace(/\.exe$/, '');
  if (name === 'pwsh' || name === 'powershell') return ['-NoLogo'];
  if (['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh'].includes(name)) return ['-l'];
  return [];
}

/** Resolve a shell executable, never treating the shell setting as a command line. */
export function resolveShell(requested: string, options: ShellOptions = {}): ResolvedShell {
  if (typeof requested !== 'string' || /[\0\r\n]/.test(requested)) {
    throw new Error('The shell must be an executable name or path without NUL characters or line breaks.');
  }
  const windows = (options.platform ?? process.platform) === 'win32';
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.env ?? process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  const trimmed = requested.trim();
  const selection = ['powershell', 'pwsh', 'cmd', 'bash', 'zsh', 'fish'].includes(trimmed.toLowerCase()) ? trimmed.toLowerCase() : trimmed;
  const profile = selection ? undefined : options.defaultProfile;
  if (profile?.env) {
    for (const [key, value] of Object.entries(profile.env)) {
      if (windows) {
        for (const existing of Object.keys(env)) {
          if (existing.toLowerCase() === key.toLowerCase()) delete env[existing];
        }
      }
      if (value === null) delete env[key];
      else env[key] = value;
    }
  }

  let candidates: string[];
  if (profile) {
    candidates = Array.isArray(profile.path) ? profile.path : [profile.path];
  } else if (selection === 'powershell' || selection === 'pwsh') {
    const systemRoot = environmentValue(env, 'SystemRoot', windows);
    candidates = ['pwsh'];
    if (windows) {
      if (systemRoot) candidates.push(path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
      candidates.push('powershell');
    }
  } else if (selection === 'cmd') {
    candidates = windows ? [environmentValue(env, 'COMSPEC', true) ?? 'cmd.exe', 'cmd.exe'] : ['cmd'];
  } else if (selection) {
    candidates = [selection];
  } else if (windows) {
    candidates = ['pwsh', environmentValue(env, 'COMSPEC', true) ?? 'cmd.exe'];
  } else {
    let loginShell: string | undefined;
    try { loginShell = os.userInfo().shell ?? undefined; } catch { /* Minimal containers may lack a user entry. */ }
    candidates = [env.SHELL, loginShell, '/bin/sh'].filter((candidate): candidate is string => Boolean(candidate));
  }

  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || /[\0\r\n]/.test(candidate)) {
      throw new Error('The configured shell path contains an invalid character.');
    }
    const file = findExecutable(candidate, env, windows);
    if (!file) continue;
    // A string represents one argument. In particular, executable paths are never split on spaces.
    const args = profile?.args === undefined ? defaultArguments(file, windows)
      : Array.isArray(profile.args) ? [...profile.args] : [profile.args];
    if (args.some((argument) => typeof argument !== 'string' || argument.includes('\0'))) {
      throw new Error('The configured shell arguments contain an invalid value.');
    }
    return { file, args, env };
  }
  if (selection === 'powershell' || selection === 'pwsh') {
    throw new Error('PowerShell was not found. Install pwsh or choose another installed shell.');
  }
  throw new Error('The configured shell executable was not found or is not executable. Choose an installed shell or a full executable path; do not include arguments in the shell setting.');
}
