import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { test, type TestContext } from 'node:test';
import { discover_shells } from '../src/discovery';

interface file_entry {
  real?: string;
  executable?: boolean;
  directory?: boolean;
}

function mock_file_system(t: TestContext, entries: Record<string, file_entry>, windows = false, shell_list = '') {
  const file_system = require('node:fs/promises') as typeof import('node:fs/promises');
  const normalize = (value: string) => windows ? value.toLowerCase() : value;
  const files = new Map(Object.entries(entries).map(([file, entry]) => [normalize(file), entry]));
  const probes: Array<{ file: string; mode: number }> = [];
  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
  let read_length = 0;
  let closed = false;
  t.mock.method(file_system, 'access', async (file: string, mode: number) => {
    probes.push({ file, mode });
    const entry = files.get(normalize(file));
    if (!entry || (mode === constants.X_OK && entry.executable === false)) throw missing();
  });
  t.mock.method(file_system, 'stat', async (file: string) => {
    const entry = files.get(normalize(file));
    if (!entry) throw missing();
    return { isFile: () => !entry.directory };
  });
  t.mock.method(file_system, 'realpath', async (file: string) => {
    const entry = files.get(normalize(file));
    if (!entry) throw missing();
    return entry.real ?? file;
  });
  t.mock.method(file_system, 'open', async (file: string) => {
    assert.equal(file, '/etc/shells');
    return {
      read: async (buffer: Buffer, offset: number, length: number) => {
        read_length = length;
        const bytes_read = Buffer.from(shell_list).copy(buffer, offset, 0, length);
        return { bytesRead: bytes_read, buffer };
      },
      close: async () => { closed = true; },
    };
  });
  return { probes, get read_length() { return read_length; }, get closed() { return closed; } };
}

test('discovery preserves configured labels and deduplicates equivalent executable paths', async t => {
  mock_file_system(t, {
    '/tools/bash': { real: '/usr/bin/bash' },
    '/usr/bin/bash': {},
    '/bin/sh': { real: '/usr/bin/bash' },
    '/tools/fish': {},
  });
  const result = await discover_shells({
    platform: 'linux', env: { PATH: '/tools:/tools:/usr/bin' },
    configured_profiles: { 'My Bash': { path: ['/missing/bash', '/tools/bash'] } },
  });
  assert.deepEqual(result, [
    { name: 'My Bash', path: '/tools/bash', source: 'profile' },
    { name: 'Sh', path: '/bin/sh', source: 'system' },
    { name: 'Fish', path: '/tools/fish', source: 'path' },
  ], 'sh remains a distinct invocation even when it shares a binary with bash');
});

test('POSIX discovery reads a bounded /etc/shells, accepts custom shells, and rejects non-executables', async t => {
  const file_system = mock_file_system(t, {
    '/custom/my-shell': {}, '/custom/not-executable': { executable: false },
    '/custom/directory': { directory: true }, '/custom/fish': {},
  }, false, '# User shells\r\n/custom/my-shell # comment\n/custom/not-executable\n/custom/directory\nrelative-shell\n/custom/fish\n');
  const result = await discover_shells({ platform: 'darwin', env: {} });
  assert.deepEqual(result.map(shell => shell.path), ['/custom/my-shell', '/custom/fish']);
  assert.equal(file_system.read_length, 32768);
  assert.equal(file_system.closed, true);
  assert.ok(file_system.probes.every(probe => probe.mode === constants.X_OK));
});

test('environment and configured paths expand safely without interpreting shell commands', async t => {
  const file_system = mock_file_system(t, {
    '/home/person/Shell Tools/custom shell': {}, '/home/person/bin/fish': {}, '/home/person/bin/nu': {}, '/login/zsh': {},
    '/workspace/bash': {},
  });
  const result = await discover_shells({
    platform: 'linux', home_directory: '/home/person',
    env: { PATH: ':.:./workspace:/missing', SHELL: '/login/zsh', CUSTOM: '/home/person/Shell Tools' },
    configured_profiles: {
      'Custom shell': { path: '${env:CUSTOM}/custom shell' },
      Fish: { path: '~/bin/fish' },
      Nushell: { path: '${userHome}/bin/nu' },
      Invalid: { path: ['bash -c dangerous', '/login/zsh\ncommand', '${env:MISSING}/bash', './workspace/bash'] },
      Disabled: null,
    },
  });
  assert.deepEqual(result.map(shell => shell.path), [
    '/home/person/Shell Tools/custom shell', '/home/person/bin/fish', '/home/person/bin/nu', '/login/zsh',
  ]);
  assert.ok(!file_system.probes.some(probe => probe.file.includes('/workspace/')));
  assert.ok(!file_system.probes.some(probe => /[\0\r\n]/.test(probe.file)));
});

test('Windows discovers system shells and Git Bash with case-insensitive environment names', async t => {
  const file_system = mock_file_system(t, {
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe': {},
    'C:\\Windows\\System32\\cmd.exe': {},
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe': {},
    'C:\\Program Files\\Git\\bin\\bash.exe': {},
    'C:\\Tools\\fish.EXE': {},
    'C:\\Tools\\zsh.cmd': {},
  }, true);
  const result = await discover_shells({
    platform: 'win32', env: {
      Path: '"C:\\Tools";C:\\Program Files\\PowerShell\\7', PathExt: '.EXE;.CMD;.BAT',
      SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      PROGRAMFILES: 'C:\\Program Files',
    },
    configured_profiles: {
      'My PowerShell': { path: '%PROGRAMFILES%\\PowerShell\\7\\pwsh.exe' },
      'Git Bash': { source: 'Git Bash' },
      InvalidBatch: { path: 'C:\\Tools\\zsh.cmd' },
    },
  });
  assert.deepEqual(result.map(shell => shell.name), ['My PowerShell', 'Git Bash', 'Command Prompt', 'Windows PowerShell', 'Fish']);
  assert.equal(result.filter(shell => /pwsh\.exe$/i.test(shell.path)).length, 1);
  assert.ok(file_system.probes.every(probe => probe.mode === constants.F_OK));
  assert.ok(!file_system.probes.some(probe => /\.(bat|cmd)$/i.test(probe.file)));
});

test('discovery bounds PATH traversal and tolerates missing or inaccessible candidates', async t => {
  const file_system = mock_file_system(t, { '/bin/sh': {} });
  const result = await discover_shells({
    platform: 'linux', env: { PATH: Array.from({ length: 1000 }, (_, index) => `/directory${index}`).join(':') },
    configured_profiles: { Missing: { path: '/inaccessible/custom' } },
  });
  assert.deepEqual(result, [{ name: 'Sh', path: '/bin/sh', source: 'system' }]);
  assert.ok(file_system.probes.length <= 1024);
  assert.ok(!file_system.probes.some(probe => probe.file.startsWith('/directory64/')));
});

test('a stalled filesystem cannot keep the shell picker waiting indefinitely', async t => {
  const file_system = require('node:fs/promises') as typeof import('node:fs/promises');
  t.mock.method(file_system, 'access', () => new Promise<void>(() => undefined));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const discovery = discover_shells({ platform: 'win32', env: { PATH: 'C:\\Unavailable' } });
  t.mock.timers.tick(3000);
  assert.deepEqual(await discovery, []);
});
