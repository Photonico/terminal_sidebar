import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { shell_integration } from '../src/shell_integration';
import { session_manager, type session_launch } from '../src/sessions';
import { resolve_shell } from '../src/shell';

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "side_terminal_integration_"));
  const scripts = path.join(root, 'out/vs/workbench/contrib/terminal/common/scripts');
  mkdirSync(scripts, { recursive: true });
  for (const file of ['shellIntegration-env.zsh', 'shellIntegration-profile.zsh', 'shellIntegration-rc.zsh',
    'shellIntegration-login.zsh', 'shellIntegration-bash.sh', 'shellIntegration.fish', 'shellIntegration.ps1']) {
    writeFileSync(path.join(scripts, file), `# ${file}`);
  }
  const integration = new shell_integration(root);
  const launch: session_launch = { file: '/bin/zsh', args: ['-l'], cwd: root,
    env: { HOME: root, ZDOTDIR: path.join(root, 'original rc'), VSCODE_SHELL_INTEGRATION: '1' } };
  return { root, scripts, integration, launch, dispose: () => {
    integration.dispose(); rmSync(root, { recursive: true, force: true });
  } };
}

test('zsh integration preserves user startup location, isolates hooks, and cleans up only its private directory', t => {
  const f = fixture();
  t.after(f.dispose);
  const original = structuredClone(f.launch);
  const result = f.integration.prepare(f.launch);
  assert.deepEqual(f.launch, original);
  assert.deepEqual(result.args, ['-il']);
  assert.equal(result.env.USER_ZDOTDIR, original.env.ZDOTDIR);
  assert.equal(result.env.TERM_PROGRAM, 'vscode');
  assert.equal(result.env.VSCODE_SHELL_INTEGRATION, undefined);
  assert.notEqual(result.env.ZDOTDIR, original.env.ZDOTDIR);
  assert.equal(readFileSync(path.join(result.env.ZDOTDIR, '.zshrc'), 'utf8'), '# shellIntegration-rc.zsh');
  if (process.platform !== 'win32') assert.equal(statSync(result.env.ZDOTDIR).mode & 0o077, 0);
  const second = f.integration.prepare({ ...f.launch, args: [] });
  assert.deepEqual(second.args, ['-i']);
  assert.equal(second.env.ZDOTDIR, result.env.ZDOTDIR);
  assert.notEqual(second.env.VSCODE_NONCE, result.env.VSCODE_NONCE);
  f.integration.dispose();
  assert.equal(existsSync(result.env.ZDOTDIR), false);
  assert.equal(existsSync(f.scripts), true);
});

test('integration supports interactive launch forms without rewriting custom commands or startup arguments', t => {
  const f = fixture();
  t.after(f.dispose);
  const bash = f.integration.prepare({ ...f.launch, file: '/bin/bash', args: ['--login', '-i'] });
  assert.deepEqual(bash.args, ['--init-file', path.join(f.scripts, 'shellIntegration-bash.sh'), '-i']);
  assert.equal(bash.env.VSCODE_SHELL_LOGIN, '1');
  const fish = f.integration.prepare({ ...f.launch, file: '/bin/fish' });
  assert.deepEqual(fish.args.slice(0, 3), ['-l', '-i', '--init-command']);
  const pwsh = f.integration.prepare({ ...f.launch, file: '/bin/pwsh', args: ['-NoLogo', '-NoProfile'] });
  assert.deepEqual(pwsh.args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NoExit', '-Command']);
  for (const [file, args] of [
    ['/bin/zsh', ['-f']], ['/bin/zsh', ['-c', 'printf custom']], ['/bin/bash', ['--rcfile', 'custom']],
    ['/bin/fish', ['-C', 'custom']], ['/bin/pwsh', ['-File', 'custom.ps1']], ['/bin/sh', []],
  ] as Array<[string, string[]]>) {
    const launch = { ...f.launch, file, args };
    assert.equal(f.integration.prepare(launch), launch);
  }
  assert.equal(f.integration.prepare(f.launch, false), f.launch);
  assert.equal(new shell_integration(undefined).prepare(f.launch), f.launch);
  rmSync(path.join(f.scripts, 'shellIntegration-env.zsh'));
  assert.equal(f.integration.prepare(f.launch), f.launch, 'incomplete zsh support falls back without changing startup');
});

test('PowerShell paths quote apostrophes and Windows argument matching is case-insensitive', t => {
  const f = fixture();
  t.after(f.dispose);
  const moved_root = path.join(f.root, "host's copy");
  const moved_scripts = path.join(moved_root, 'out/vs/workbench/contrib/terminal/common/scripts');
  mkdirSync(moved_scripts, { recursive: true });
  writeFileSync(path.join(moved_scripts, 'shellIntegration.ps1'), '# test');
  const integration = new shell_integration(moved_root, 'win32');
  t.after(() => integration.dispose());
  const result = integration.prepare({ ...f.launch, file: 'C:\\Program Files\\PowerShell\\pwsh.exe', args: ['-NOLOGO'] });
  assert.match(result.args.at(-1)!, /host''s copy/);
  assert.equal(result.args[0], '-NOLOGO');
});

// Run against the actual host scripts when available; CI still covers the launch planner above.
const host_root = process.env.TERMINAL_SIDEBAR_TEST_APP_ROOT
  ?? (process.platform === 'darwin' ? '/Applications/Visual Studio Code.app/Contents/Resources/app' : '');
for (const shell of ['zsh', 'bash']) {
  test(`real ${shell} reports idle, running, success and failure through host integration`,
    { skip: !host_root || !existsSync(path.join(host_root, 'out/vs/workbench/contrib/terminal/common/scripts')), timeout: 15000 }, async t => {
      let resolved;
      try { resolved = resolve_shell(shell); } catch { t.skip(`${shell} is unavailable`); return; }
      const home = mkdtempSync(path.join(os.tmpdir(), 'side_terminal_shell_test_'));
      const integration = new shell_integration(host_root);
      let output = '';
      const manager = new session_manager({
        resolve: () => integration.prepare({ ...resolved, args: ['-l'], cwd: home,
          env: { ...resolved.env, HOME: home, ZDOTDIR: home, HISTFILE: path.join(home, 'history') } }),
        on_output: (_id, data) => { output += data; }, on_state: () => {},
      });
      t.after(() => { manager.dispose(); integration.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
      writeFileSync(path.join(home, '.zshrc'), 'export SIDE_TERMINAL_RC_PROBE=loaded\n');
      writeFileSync(path.join(home, '.bash_profile'), 'export SIDE_TERMINAL_RC_PROBE=loaded\n');
      const wait_for = async (condition: () => boolean, label: string) => {
        const deadline = Date.now() + 8000;
        while (!condition()) {
          if (Date.now() > deadline) assert.fail(`${label}: ${JSON.stringify(manager.shell_state('test'))}`);
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      };
      manager.start({ id: 'test', name: 'Test', command: '', shell }, 80, 24);
      await wait_for(() => manager.shell_state('test')?.command_state === 'idle', 'initial prompt');
      assert.equal(manager.get('test')?.command_status, undefined);
      manager.input('test', 'sleep 0.3; test "$SIDE_TERMINAL_RC_PROBE" = loaded\r');
      await wait_for(() => manager.get('test')?.command_status === 'running', 'running command');
      await wait_for(() => manager.get('test')?.command_status === 'completed', 'successful command');
      assert.equal(manager.shell_state('test')?.command_state, 'idle');
      manager.input('test', 'false\r');
      await wait_for(() => manager.get('test')?.command_status === 'error', 'failed command');
      assert.equal(manager.get('test')?.command_exit_code, 1);
      manager.input('test', 'typed but not submitted');
      assert.equal(manager.shell_state('test')?.command_state, 'idle');
      assert.ok(output.includes('633;C'), 'the shell, not guessed output, reported execution');
      manager.input('test', '\x15exit\r');
      await wait_for(() => manager.get('test')?.status === 'exited', 'clean shell exit');
    });
}
