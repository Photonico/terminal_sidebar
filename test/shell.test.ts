import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { resolve_shell } from '../src/shell';

function fixture(t: TestContext, names: string[]): string {
  if (process.platform === 'win32') {
    // These tests exercise the POSIX resolver, so do not feed it host Windows paths.
    // Keep their PATH, argument, and environment assertions active on Windows CI.
    const directory = '/terminal-sidebar-shell-fixture';
    const present = new Set(names.map(name => path.posix.join(directory, name)));
    const fs = require('node:fs') as typeof import('node:fs');
    t.mock.method(fs, 'accessSync', (candidate: string) => {
      if (!present.has(candidate)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    t.mock.method(fs, 'statSync', () => ({ isFile: () => true }));
    return directory;
  }
  const directory = mkdtempSync(path.join(os.tmpdir(), 'terminal-sidebar-shell-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const name of names) {
    const file = path.join(directory, name);
    writeFileSync(file, '#!/bin/sh\nexit 0\n');
    chmodSync(file, 0o755);
  }
  return directory;
}

test('known shells resolve through PATH with interactive login arguments', (t) => {
  const directory = fixture(t, ['bash', 'fish', 'pwsh']);
  for (const name of ['bash', 'fish']) {
    const result = resolve_shell(name, { platform: 'linux', env: { PATH: directory } });
    assert.equal(result.file, path.posix.join(directory, name));
    assert.deepEqual(result.args, ['-l']);
  }
  assert.deepEqual(resolve_shell('powershell', { platform: 'linux', env: { PATH: directory } }).args, ['-NoLogo']);
});

test('an executable path containing spaces remains one path; shell strings are not parsed', (t) => {
  const directory = fixture(t, ['custom shell']);
  const file = path.posix.join(directory, 'custom shell');
  assert.equal(resolve_shell(file, { platform: 'linux', env: {} }).file, file);
  assert.throws(() => resolve_shell(file + ' --login', { platform: 'linux', env: {} }), /do not include arguments/);
  assert.throws(() => resolve_shell('bash -c echo secret', { platform: 'linux', env: { PATH: directory } }), /not found/);
  assert.throws(() => resolve_shell('bash\nanything'), /line breaks/);
  assert.throws(() => resolve_shell('bash\0anything'), /NUL/);
});

test('VS Code default profile chooses an available candidate and overlays or removes environment values', (t) => {
  const directory = fixture(t, ['custom shell', 'bash']);
  const env = { PATH: directory, KEEP: 'yes', REMOVE: 'private', REPLACE: 'old' };
  const result = resolve_shell('', {
    platform: 'linux', env,
    default_profile: {
      path: ['missing-shell', 'custom shell'], args: ['--interactive', 'an argument with spaces'],
      env: { REMOVE: null, REPLACE: 'new', ADD: 'added' },
    },
  });
  assert.equal(result.file, path.posix.join(directory, 'custom shell'));
  assert.deepEqual(result.args, ['--interactive', 'an argument with spaces']);
  assert.deepEqual(result.env, { PATH: directory, KEEP: 'yes', REPLACE: 'new', ADD: 'added' });
  assert.equal(env.REMOVE, 'private', 'the caller environment is not mutated');
  assert.deepEqual(resolve_shell('bash', {
    platform: 'linux', env, default_profile: { path: 'missing-shell', env: { KEEP: null }, args: ['--bad'] },
  }).args, ['-l'], 'an explicit choice overrides the default profile');
});

test('startup arguments override default profile arguments and login defaults without splitting', (t) => {
  const directory = fixture(t, ['bash']);
  const args = ['-c', 'echo first\necho second', 'argument with spaces', ''];
  const options = { platform: 'linux' as const, env: { PATH: directory }, profile_args: args };
  const result = resolve_shell('bash', options);
  assert.deepEqual(result.args, args);
  result.args.push('changed');
  assert.equal(args.length, 4, 'returned arguments do not mutate the startup profile');
  assert.deepEqual(resolve_shell('', {
    ...options, default_profile: { path: 'bash', args: ['--noprofile'] },
  }).args, args);
  assert.deepEqual(resolve_shell('bash', { ...options, profile_args: [] }).args, []);
  assert.deepEqual(resolve_shell('', {
    ...options, profile_args: [], default_profile: { path: 'bash', args: '--noprofile' },
  }).args, []);
});

test('startup environment applies after VS Code profile values and before PATH lookup', (t) => {
  const directory = fixture(t, ['custom shell']);
  const env = { PATH: '/missing-inherited-path', KEEP: 'inherited', REMOVE: 'inherited', CHANGE: 'inherited' };
  const default_env = { PATH: '/missing-default-path', REMOVE: 'default', CHANGE: 'default', FROM_DEFAULT: 'yes' };
  const profile_env = { PATH: directory, REMOVE: null, CHANGE: 'startup', EMPTY: '', MULTILINE: 'first\nsecond' };
  const result = resolve_shell('', {
    platform: 'linux', env, default_profile: { path: 'custom shell', env: default_env }, profile_env,
  });
  assert.equal(result.file, path.posix.join(directory, 'custom shell'));
  assert.deepEqual(result.env, {
    PATH: directory, KEEP: 'inherited', CHANGE: 'startup', FROM_DEFAULT: 'yes', EMPTY: '', MULTILINE: 'first\nsecond',
  });
  assert.equal(env.REMOVE, 'inherited');
  assert.equal(default_env.REMOVE, 'default');
  assert.equal(profile_env.REMOVE, null);
  result.env.CHANGE = 'mutated';
  assert.equal(profile_env.CHANGE, 'startup');
  const explicit_shell = resolve_shell('custom shell', {
    platform: 'linux', env, default_profile: { path: 'missing', env: default_env }, profile_env,
  });
  assert.equal(explicit_shell.file, result.file);
  assert.equal(explicit_shell.env.FROM_DEFAULT, undefined, 'explicit shell skips the VS Code default profile');
  assert.throws(() => resolve_shell('custom shell', {
    platform: 'linux', env: { PATH: directory }, profile_env: { PATH: null },
  }), /not found/);
});

test('startup environment names are case-sensitive on POSIX and safe from object prototype keys', (t) => {
  const directory = fixture(t, ['bash']);
  const env = { PATH: directory, VALUE: 'upper', value: 'lower' };
  const result = resolve_shell('bash', { platform: 'linux', env, profile_env: { VALUE: null } });
  assert.equal(result.env.VALUE, undefined);
  assert.equal(result.env.value, 'lower');
  const inherited = JSON.parse('{"__proto__":"literal","constructor":"value"}');
  const safe_result = resolve_shell('bash', { platform: 'linux', env: { PATH: directory, ...inherited } });
  assert.equal(Object.getPrototypeOf(safe_result.env), Object.prototype);
  assert.equal(Object.getOwnPropertyDescriptor(safe_result.env, '__proto__')?.value, 'literal');
  assert.equal(safe_result.env.constructor, 'value');
});

test('resolver validates startup options before attempting executable lookup', () => {
  for (const profile_args of [['a\0b'], ['x'.repeat(8193)], new Array(129).fill('')]) {
    assert.throws(() => resolve_shell('missing', { env: {}, profile_args }), /arguments?/);
  }
  for (const profile_env of [{ 'BAD=KEY': 'value' }, { VALID: 'a\0b' }, JSON.parse('{"__proto__":"value"}')]) {
    assert.throws(() => resolve_shell('missing', { env: {}, profile_env }), /environment/);
  }
});

test('default shell can use SHELL and non-executable files are rejected', (t) => {
  const directory = fixture(t, ['login-shell', 'not-executable']);
  const file = path.posix.join(directory, 'login-shell');
  assert.equal(resolve_shell('', { platform: 'linux', env: { SHELL: file, PATH: directory } }).file, file);
  if (process.platform !== 'win32') {
    chmodSync(path.join(directory, 'not-executable'), 0o644);
    assert.throws(() => resolve_shell('not-executable', { platform: 'linux', env: { PATH: directory } }), /not executable/);
  }
});

test('Windows resolves PATHEXT, pwsh preference, COMSPEC, and legacy PowerShell using case-insensitive env names', (t) => {
  // Mock only filesystem availability, so Windows path construction is exercised on every host.
  const fs = require('node:fs') as typeof import('node:fs');
  const present = new Set<string>();
  t.mock.method(fs, 'accessSync', (candidate: string) => {
    if (!present.has(candidate.toLowerCase())) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  });
  t.mock.method(fs, 'statSync', () => ({ isFile: () => true }));
  const env = { Path: 'C:\\Tools;C:\\Windows', PathExt: '.EXE;.CMD', ComSpec: 'C:\\Windows\\cmd.exe', SYSTEMROOT: 'C:\\Windows' };
  present.add('c:\\tools\\pwsh.exe');
  present.add('c:\\windows\\cmd.exe');
  assert.equal(resolve_shell('', { platform: 'win32', env }).file.toLowerCase(), 'c:\\tools\\pwsh.exe');
  present.delete('c:\\tools\\pwsh.exe');
  assert.equal(resolve_shell('', { platform: 'win32', env }).file.toLowerCase(), 'c:\\windows\\cmd.exe');
  present.add('c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe');
  const powershell = resolve_shell('powershell', { platform: 'win32', env });
  assert.match(powershell.file, /WindowsPowerShell/);
  assert.deepEqual(powershell.args, ['-NoLogo']);
  const result = resolve_shell('', {
    platform: 'win32', env,
    default_profile: { path: 'cmd', env: { PATH: 'C:\\Windows', comspec: null }, args: [] },
  });
  assert.equal(result.env.PATH, 'C:\\Windows');
  assert.equal(result.env.Path, undefined);
  assert.equal(result.env.ComSpec, undefined);
  assert.deepEqual(result.args, []);

  present.add('d:\\custom\\cmd.exe');
  const startup = resolve_shell('', {
    platform: 'win32', env,
    default_profile: { path: 'cmd', env: { PATH: 'C:\\Windows', REMOVE: 'default', FLAG: 'default' } },
    profile_env: { path: 'D:\\Custom', remove: null, flag: 'startup', COMSPEC: null },
    profile_args: ['/d'],
  });
  assert.equal(startup.file.toLowerCase(), 'd:\\custom\\cmd.exe');
  assert.equal(startup.env.path, 'D:\\Custom');
  assert.equal(startup.env.Path, undefined);
  assert.equal(startup.env.PATH, undefined);
  assert.equal(startup.env.REMOVE, undefined);
  assert.equal(startup.env.ComSpec, undefined);
  assert.equal(startup.env.flag, 'startup');
  assert.equal(startup.env.FLAG, undefined);
  assert.deepEqual(startup.args, ['/d']);
});
