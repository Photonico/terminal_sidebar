import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { test, type TestContext } from 'node:test';
import { discoverShells } from '../src/discovery';

interface FileEntry { real?: string; executable?: boolean; directory?: boolean }

function filesystem(t: TestContext, entries: Record<string, FileEntry>, windows = false, shellList = '') {
  const fs = require('node:fs/promises') as typeof import('node:fs/promises');
  const normalize = (value: string) => windows ? value.toLowerCase() : value;
  const files = new Map(Object.entries(entries).map(([file, entry]) => [normalize(file), entry]));
  const probes: Array<{ file: string; mode: number }> = [];
  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
  let readLength = 0;
  let closed = false;
  t.mock.method(fs, 'access', async (file: string, mode: number) => {
    probes.push({ file, mode });
    const entry = files.get(normalize(file));
    if (!entry || (mode === constants.X_OK && entry.executable === false)) throw missing();
  });
  t.mock.method(fs, 'stat', async (file: string) => {
    const entry = files.get(normalize(file));
    if (!entry) throw missing();
    return { isFile: () => !entry.directory };
  });
  t.mock.method(fs, 'realpath', async (file: string) => {
    const entry = files.get(normalize(file));
    if (!entry) throw missing();
    return entry.real ?? file;
  });
  t.mock.method(fs, 'open', async (file: string) => {
    assert.equal(file, '/etc/shells');
    return {
      read: async (buffer: Buffer, offset: number, length: number) => {
        readLength = length;
        const bytesRead = Buffer.from(shellList).copy(buffer, offset, 0, length);
        return { bytesRead, buffer };
      },
      close: async () => { closed = true; },
    };
  });
  return { probes, get readLength() { return readLength; }, get closed() { return closed; } };
}

test('discovery preserves configured labels and deduplicates equivalent executable paths', async t => {
  filesystem(t, {
    '/tools/bash': { real: '/usr/bin/bash' },
    '/usr/bin/bash': {},
    '/bin/sh': { real: '/usr/bin/bash' },
    '/tools/fish': {},
  });
  const result = await discoverShells({
    platform: 'linux', env: { PATH: '/tools:/tools:/usr/bin' },
    configuredProfiles: { 'My Bash': { path: ['/missing/bash', '/tools/bash'] } },
  });
  assert.deepEqual(result, [
    { name: 'My Bash', path: '/tools/bash', source: 'profile' },
    { name: 'Sh', path: '/bin/sh', source: 'system' },
    { name: 'Fish', path: '/tools/fish', source: 'path' },
  ], 'sh remains a distinct invocation even when it shares a binary with bash');
});

test('POSIX discovery reads a bounded /etc/shells, accepts custom shells, and rejects non-executables', async t => {
  const fs = filesystem(t, {
    '/custom/my-shell': {}, '/custom/not-executable': { executable: false },
    '/custom/directory': { directory: true }, '/custom/fish': {},
  }, false, '# User shells\r\n/custom/my-shell # comment\n/custom/not-executable\n/custom/directory\nrelative-shell\n/custom/fish\n');
  const result = await discoverShells({ platform: 'darwin', env: {} });
  assert.deepEqual(result.map(shell => shell.path), ['/custom/my-shell', '/custom/fish']);
  assert.equal(fs.readLength, 32768);
  assert.equal(fs.closed, true);
  assert.ok(fs.probes.every(probe => probe.mode === constants.X_OK));
});

test('environment and configured paths expand safely without interpreting shell commands', async t => {
  const fs = filesystem(t, {
    '/home/person/Shell Tools/custom shell': {}, '/home/person/bin/fish': {}, '/home/person/bin/nu': {}, '/login/zsh': {},
    '/workspace/bash': {},
  });
  const result = await discoverShells({
    platform: 'linux', homeDir: '/home/person',
    env: { PATH: ':.:./workspace:/missing', SHELL: '/login/zsh', CUSTOM: '/home/person/Shell Tools' },
    configuredProfiles: {
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
  assert.ok(!fs.probes.some(probe => probe.file.includes('/workspace/')));
  assert.ok(!fs.probes.some(probe => /[\0\r\n]/.test(probe.file)));
});

test('Windows discovers system shells and Git Bash with case-insensitive environment names', async t => {
  const fs = filesystem(t, {
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe': {},
    'C:\\Windows\\System32\\cmd.exe': {},
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe': {},
    'C:\\Program Files\\Git\\bin\\bash.exe': {},
    'C:\\Tools\\fish.EXE': {},
    'C:\\Tools\\zsh.cmd': {},
  }, true);
  const result = await discoverShells({
    platform: 'win32', env: {
      Path: '"C:\\Tools";C:\\Program Files\\PowerShell\\7', PathExt: '.EXE;.CMD;.BAT',
      SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      PROGRAMFILES: 'C:\\Program Files',
    },
    configuredProfiles: {
      'My PowerShell': { path: '%PROGRAMFILES%\\PowerShell\\7\\pwsh.exe' },
      'Git Bash': { source: 'Git Bash' },
      InvalidBatch: { path: 'C:\\Tools\\zsh.cmd' },
    },
  });
  assert.deepEqual(result.map(shell => shell.name), ['My PowerShell', 'Git Bash', 'Command Prompt', 'Windows PowerShell', 'Fish']);
  assert.equal(result.filter(shell => /pwsh\.exe$/i.test(shell.path)).length, 1);
  assert.ok(fs.probes.every(probe => probe.mode === constants.F_OK));
  assert.ok(!fs.probes.some(probe => /\.(bat|cmd)$/i.test(probe.file)));
});

test('discovery bounds PATH traversal and tolerates missing or inaccessible candidates', async t => {
  const fs = filesystem(t, { '/bin/sh': {} });
  const result = await discoverShells({
    platform: 'linux', env: { PATH: Array.from({ length: 1000 }, (_, index) => `/directory${index}`).join(':') },
    configuredProfiles: { Missing: { path: '/inaccessible/custom' } },
  });
  assert.deepEqual(result, [{ name: 'Sh', path: '/bin/sh', source: 'system' }]);
  assert.ok(fs.probes.length <= 1024);
  assert.ok(!fs.probes.some(probe => probe.file.startsWith('/directory64/')));
});

test('a stalled filesystem cannot keep the shell picker waiting indefinitely', async t => {
  const fs = require('node:fs/promises') as typeof import('node:fs/promises');
  t.mock.method(fs, 'access', () => new Promise<void>(() => undefined));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const discovery = discoverShells({ platform: 'win32', env: { PATH: 'C:\\Unavailable' } });
  t.mock.timers.tick(3000);
  assert.deepEqual(await discovery, []);
});
