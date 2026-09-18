import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import type { session_launch } from './sessions';

/** Use the host's own integration scripts, following VS Code's supported launch forms.
 * Custom commands/rc files are left alone; no user startup file is modified.
 * https://github.com/microsoft/vscode/blob/main/src/vs/platform/terminal/node/terminalEnvironment.ts
 */
export class shell_integration {
  private zsh_directory?: string;
  private readonly scripts?: string;

  constructor(app_root: string | undefined, private readonly platform: NodeJS.Platform = process.platform) {
    if (app_root) this.scripts = path.join(app_root, 'out/vs/workbench/contrib/terminal/common/scripts');
  }

  prepare(launch: session_launch, enabled = true): session_launch {
    if (!enabled || !this.scripts) return launch;
    const file_name = (this.platform === 'win32' ? path.win32 : path.posix).basename(launch.file);
    const shell = this.platform === 'win32' ? file_name.toLowerCase().replace(/\.exe$/, '') : file_name;
    const args = launch.args.map(argument => argument.toLowerCase());
    const posix_flags = new Set(['-i', '--interactive', '-l', '--login', '-il', '-li']);
    const powershell_flags = new Set(['-nologo', '-nol', '-noprofile', '-noexit', '-l', '-login']);
    const powershell = shell === 'pwsh' || shell === 'powershell';
    if (!(powershell || ['zsh', 'bash', 'fish'].includes(shell))
      || args.some(argument => !(powershell ? powershell_flags : posix_flags).has(argument))) return launch;
    const login = args.some(argument => ['-l', '--login', '-login', '-il', '-li'].includes(argument));
    const script = path.join(this.scripts, powershell ? 'shellIntegration.ps1'
      : shell === 'bash' ? 'shellIntegration-bash.sh' : shell === 'fish' ? 'shellIntegration.fish' : 'shellIntegration-rc.zsh');
    if (!existsSync(script)) return launch;

    const env: Record<string, string> = { ...launch.env, TERM_PROGRAM: 'vscode', VSCODE_INJECTION: '1', VSCODE_NONCE: randomBytes(16).toString('hex') };
    // A child shell must not inherit another shell's already-initialized guard.
    for (const key of ['VSCODE_SHELL_INTEGRATION', 'VSCODE_SHELL_LOGIN', 'VSCODE_SHELL_ENV_REPORTING']) delete env[key];
    let integrated_args: string[];
    try {
      if (shell === 'zsh') {
        const directory = this.prepare_zsh();
        if (!directory) return launch;
        env.USER_ZDOTDIR = launch.env.ZDOTDIR || launch.env.HOME || homedir();
        env.ZDOTDIR = directory;
        integrated_args = [login ? '-il' : '-i'];
      } else if (shell === 'bash') {
        if (login) env.VSCODE_SHELL_LOGIN = '1';
        integrated_args = ['--init-file', script, '-i'];
      } else if (shell === 'fish') {
        const quoted = "'" + script.replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "'";
        integrated_args = [...(login ? ['-l'] : []), '-i', '--init-command', `source ${quoted}`];
      } else {
        const quoted = "'" + script.replaceAll("'", "''") + "'";
        integrated_args = [...launch.args.filter(argument => argument.toLowerCase() !== '-noexit'),
          '-NoExit', '-Command', `try { . ${quoted} } catch {}`];
      }
      return { ...launch, args: integrated_args, env };
    } catch {
      // A restricted temp directory or missing host script must not prevent a terminal opening.
      return launch;
    }
  }

  dispose(): void {
    if (!this.zsh_directory) return;
    try { rmSync(this.zsh_directory, { recursive: true, force: true }); } catch { /* Best effort at shutdown. */ }
    this.zsh_directory = undefined;
  }

  private prepare_zsh(): string | undefined {
    if (this.zsh_directory) return this.zsh_directory;
    const files = [
      ['shellIntegration-env.zsh', '.zshenv'], ['shellIntegration-profile.zsh', '.zprofile'],
      ['shellIntegration-rc.zsh', '.zshrc'], ['shellIntegration-login.zsh', '.zlogin'],
    ];
    if (files.some(([source]) => !existsSync(path.join(this.scripts!, source)))) return;
    const directory = mkdtempSync(path.join(tmpdir(), 'terminal_sidebar_zsh_'));
    try {
      for (const [source, destination] of files) copyFileSync(path.join(this.scripts!, source), path.join(directory, destination));
      this.zsh_directory = directory;
      return directory;
    } catch (error) {
      try { rmSync(directory, { recursive: true, force: true }); } catch { /* Preserve the original error. */ }
      throw error;
    }
  }
}
