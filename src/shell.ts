import * as file_system from 'node:fs';
import * as operating_system from 'node:os';
import * as path from 'node:path';

export interface shell_options {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  default_profile?: {
    path: string | string[];
    args?: string[] | string;
    env?: Record<string, string | null>;
  };
}

/** Arguments and environment remain separate from the executable path. */
export interface resolved_shell {
  file: string;
  args: string[];
  env: Record<string, string>;
}

function environment_value(environment: Record<string, string>, key: string, windows: boolean): string | undefined {
  const actual_key = windows
    ? Object.keys(environment).find((entry) => entry.toLowerCase() === key.toLowerCase())
    : key;
  return actual_key === undefined ? undefined : environment[actual_key];
}

function is_executable(candidate: string, windows: boolean): boolean {
  try {
    const access_mode = windows ? file_system.constants.F_OK : file_system.constants.X_OK;
    file_system.accessSync(candidate, access_mode);
    return file_system.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function find_executable(requested: string, environment: Record<string, string>, windows: boolean): string | undefined {
  if (!requested || /[\0\r\n]/.test(requested)) return undefined;
  const path_operations = windows ? path.win32 : path.posix;
  const has_directory = requested.includes('/')
    || (windows && (requested.includes('\\') || /^[a-z]:/i.test(requested)));
  const directories = has_directory
    ? ['']
    : (environment_value(environment, 'PATH', windows) ?? '').split(windows ? ';' : ':');
  const extensions = windows && !path_operations.extname(requested)
    ? ['', ...(environment_value(environment, 'PATHEXT', true) ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
    : [''];

  for (const directory of directories) {
    const unquoted_directory = directory.replace(/^"(.*)"$/, '$1');
    const executable_base = has_directory ? requested : path_operations.join(unquoted_directory || '.', requested);
    for (const extension of extensions) {
      const candidate = executable_base + extension;
      if (is_executable(candidate, windows)) return path_operations.resolve(candidate);
    }
  }
  return undefined;
}

function default_arguments(file: string, windows: boolean): string[] {
  const path_operations = windows ? path.win32 : path.posix;
  const executable_name = path_operations.basename(file).toLowerCase().replace(/\.exe$/, '');
  if (executable_name === 'pwsh' || executable_name === 'powershell') return ['-NoLogo'];
  if (['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh'].includes(executable_name)) return ['-l'];
  return [];
}

/**
 * Resolve an executable name or path without interpreting a shell command line.
 * A blank request uses the supplied VS Code default profile, then the system shell.
 * The returned arguments and environment are copied, so caller configuration is unchanged.
 */
export function resolve_shell(requested: string, options: shell_options = {}): resolved_shell {
  if (typeof requested !== 'string' || /[\0\r\n]/.test(requested)) {
    throw new Error('The shell must be an executable name or path without NUL characters or line breaks.');
  }
  const windows = (options.platform ?? process.platform) === 'win32';
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.env ?? process.env)) {
    if (typeof value === 'string') environment[key] = value;
  }

  const trimmed_request = requested.trim();
  const known_shell = ['powershell', 'pwsh', 'cmd', 'bash', 'zsh', 'fish'].includes(trimmed_request.toLowerCase());
  const selection = known_shell ? trimmed_request.toLowerCase() : trimmed_request;
  const profile = selection ? undefined : options.default_profile;

  // VS Code profile values override the inherited environment; null removes a value.
  if (profile?.env) {
    for (const [key, value] of Object.entries(profile.env)) {
      if (windows) {
        for (const existing_key of Object.keys(environment)) {
          if (existing_key.toLowerCase() === key.toLowerCase()) delete environment[existing_key];
        }
      }
      if (value === null) delete environment[key];
      else environment[key] = value;
    }
  }

  // Preserve the default profile's candidate order, including Windows fallback paths.
  let candidates: string[];
  if (profile) {
    candidates = Array.isArray(profile.path) ? profile.path : [profile.path];
  } else if (selection === 'powershell' || selection === 'pwsh') {
    const system_root = environment_value(environment, 'SystemRoot', windows);
    candidates = ['pwsh'];
    if (windows) {
      if (system_root) {
        candidates.push(path.win32.join(system_root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
      }
      candidates.push('powershell');
    }
  } else if (selection === 'cmd') {
    candidates = windows ? [environment_value(environment, 'COMSPEC', true) ?? 'cmd.exe', 'cmd.exe'] : ['cmd'];
  } else if (selection) {
    candidates = [selection];
  } else if (windows) {
    candidates = ['pwsh', environment_value(environment, 'COMSPEC', true) ?? 'cmd.exe'];
  } else {
    let login_shell: string | undefined;
    try {
      login_shell = operating_system.userInfo().shell ?? undefined;
    } catch { /* Minimal containers may lack a user entry. */ }
    candidates = [environment.SHELL, login_shell, '/bin/sh'].filter((candidate): candidate is string => Boolean(candidate));
  }

  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || /[\0\r\n]/.test(candidate)) {
      throw new Error('The configured shell path contains an invalid character.');
    }
    const executable_path = find_executable(candidate, environment, windows);
    if (!executable_path) continue;

    // A string represents one argument. Executable paths are never split on spaces.
    let arguments_list: string[];
    if (profile?.args === undefined) arguments_list = default_arguments(executable_path, windows);
    else if (Array.isArray(profile.args)) arguments_list = [...profile.args];
    else arguments_list = [profile.args];
    if (arguments_list.some((argument) => typeof argument !== 'string' || argument.includes('\0'))) {
      throw new Error('The configured shell arguments contain an invalid value.');
    }
    return { file: executable_path, args: arguments_list, env: environment };
  }

  if (selection === 'powershell' || selection === 'pwsh') {
    throw new Error('PowerShell was not found. Install pwsh or choose another installed shell.');
  }
  throw new Error('The configured shell executable was not found or is not executable. Choose an installed shell or a full executable path; do not include arguments in the shell setting.');
}
