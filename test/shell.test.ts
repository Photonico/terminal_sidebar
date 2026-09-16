import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { resolveShell } from '../src/shell';

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
    const result = resolveShell(name, { platform: 'linux', env: { PATH: directory } });
    assert.equal(result.file, path.posix.join(directory, name));
    assert.deepEqual(result.args, ['-l']);
  }
  assert.deepEqual(resolveShell('powershell', { platform: 'linux', env: { PATH: directory } }).args, ['-NoLogo']);
});

test('an executable path containing spaces remains one path; shell strings are not parsed', (t) => {
  const directory = fixture(t, ['custom shell']);
  const file = path.posix.join(directory, 'custom shell');
  assert.equal(resolveShell(file, { platform: 'linux', env: {} }).file, file);
  assert.throws(() => resolveShell(file + ' --login', { platform: 'linux', env: {} }), /do not include arguments/);
  assert.throws(() => resolveShell('bash -c echo secret', { platform: 'linux', env: { PATH: directory } }), /not found/);
  assert.throws(() => resolveShell('bash\nanything'), /line breaks/);
  assert.throws(() => resolveShell('bash\0anything'), /NUL/);
});

test('VS Code default profile chooses an available candidate and overlays or removes environment values', (t) => {
  const directory = fixture(t, ['custom shell', 'bash']);
  const env = { PATH: directory, KEEP: 'yes', REMOVE: 'private', REPLACE: 'old' };
  const result = resolveShell('', {
    platform: 'linux', env,
    defaultProfile: {
      path: ['missing-shell', 'custom shell'], args: ['--interactive', 'an argument with spaces'],
      env: { REMOVE: null, REPLACE: 'new', ADD: 'added' },
    },
  });
  assert.equal(result.file, path.posix.join(directory, 'custom shell'));
  assert.deepEqual(result.args, ['--interactive', 'an argument with spaces']);
  assert.deepEqual(result.env, { PATH: directory, KEEP: 'yes', REPLACE: 'new', ADD: 'added' });
  assert.equal(env.REMOVE, 'private', 'the caller environment is not mutated');
  assert.deepEqual(resolveShell('bash', {
    platform: 'linux', env, defaultProfile: { path: 'missing-shell', env: { KEEP: null }, args: ['--bad'] },
  }).args, ['-l'], 'an explicit choice overrides the default profile');
});

test('default shell can use SHELL and non-executable files are rejected', (t) => {
  const directory = fixture(t, ['login-shell', 'not-executable']);
  const file = path.posix.join(directory, 'login-shell');
  assert.equal(resolveShell('', { platform: 'linux', env: { SHELL: file, PATH: directory } }).file, file);
  if (process.platform !== 'win32') {
    chmodSync(path.join(directory, 'not-executable'), 0o644);
    assert.throws(() => resolveShell('not-executable', { platform: 'linux', env: { PATH: directory } }), /not executable/);
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
  assert.equal(resolveShell('', { platform: 'win32', env }).file.toLowerCase(), 'c:\\tools\\pwsh.exe');
  present.delete('c:\\tools\\pwsh.exe');
  assert.equal(resolveShell('', { platform: 'win32', env }).file.toLowerCase(), 'c:\\windows\\cmd.exe');
  present.add('c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe');
  const powershell = resolveShell('powershell', { platform: 'win32', env });
  assert.match(powershell.file, /WindowsPowerShell/);
  assert.deepEqual(powershell.args, ['-NoLogo']);
  const result = resolveShell('', {
    platform: 'win32', env,
    defaultProfile: { path: 'cmd', env: { PATH: 'C:\\Windows', comspec: null }, args: [] },
  });
  assert.equal(result.env.PATH, 'C:\\Windows');
  assert.equal(result.env.Path, undefined);
  assert.equal(result.env.ComSpec, undefined);
  assert.deepEqual(result.args, []);
});
