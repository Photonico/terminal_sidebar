import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { latex_output_directory, parse_synctex_output, remote_latex_path, resolve_latex_pdf, reverse_sync, tex_root_comment } from '../src/latex_preview';

const uri = (filename: string) => pathToFileURL(filename).toString();
const result = (input: string, line = 23, column = -1) => `This is SyncTeX\nSyncTeX result begin\nOutput:out.pdf\nInput:${input}\nLine:${line}\nColumn:${column}\nSyncTeX result end\n`;

async function fixture(context: { after(callback: () => Promise<void>): void }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'terminal_sidebar_latex_'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'chapter'));
  await mkdir(path.join(directory, 'build'));
  await writeFile(path.join(directory, 'main.tex'), '\\documentclass{article}\n');
  await writeFile(path.join(directory, 'chapter', 'one.tex'), '% !TeX root = ../main.tex\n');
  await writeFile(path.join(directory, 'build', 'main.pdf'), '%PDF-fixture');
  await writeFile(path.join(directory, 'build', 'main.synctex.gz'), 'fixture');
  return directory;
}

test('root comments and documented output placeholders handle spaces and literal filenames', () => {
  assert.equal(tex_root_comment('% !TEX root = "../Project Root/main.tex"\n'), '../Project Root/main.tex');
  assert.equal(tex_root_comment('\\input{other}\n'), undefined);
  const root = path.resolve('workspace', 'project', 'main.tex');
  const workspace = path.resolve('workspace');
  assert.equal(latex_output_directory(root, '%DIR%/build/%DOCFILE%'), path.join(path.dirname(root), 'build', 'main'));
  assert.equal(latex_output_directory(root, '%WORKSPACE_FOLDER%/output/%RELATIVE_DIR%', workspace), path.join(workspace, 'output', 'project'));
  assert.equal(latex_output_directory(root, '%TMPDIR%'), undefined);
  assert.equal(latex_output_directory(root, 'out\0bad'), undefined);
});

test('remote filesystem paths convert Windows drive prefixes without changing POSIX paths or encoded filenames', () => {
  assert.equal(remote_latex_path('/C:/Users/Project%20Name/main.tex', 'win32'), 'C:\\Users\\Project Name\\main.tex');
  assert.equal(remote_latex_path('/d:/work/100%25/main.tex', 'win32'), 'd:\\work\\100%\\main.tex');
  assert.equal(remote_latex_path('/home/user/Project%20Name/main.tex', 'linux'), '/home/user/Project Name/main.tex');
  assert.equal(remote_latex_path('/C:/name/main.tex', 'linux'), '/C:/name/main.tex');
});

test('existing PDF discovery follows root comments, output directories, and jobnames without compilation', async context => {
  const directory = await fixture(context);
  const found = await resolve_latex_pdf(uri(path.join(directory, 'chapter', 'one.tex')), { out_dir: '%DIR%/build' });
  assert.equal(found.root_uri, uri(path.join(directory, 'main.tex')));
  assert.deepEqual(found.pdf_uris, [uri(path.join(directory, 'build', 'main.pdf'))]);
  await writeFile(path.join(directory, 'build', 'custom job.pdf'), '%PDF-fixture');
  assert.deepEqual((await resolve_latex_pdf(found.root_uri, { out_dir: 'build', jobname: 'custom job' })).pdf_uris,
    [uri(path.join(directory, 'build', 'custom job.pdf'))]);
  await assert.rejects(resolve_latex_pdf(found.root_uri, { jobname: '../other' }), /jobname/);
  await writeFile(path.join(directory, 'main.pdf'), '%PDF-second-candidate');
  assert.equal((await resolve_latex_pdf(found.root_uri)).pdf_uris.length, 2, 'host must choose between multiple existing outputs');
});

test('discovery inspects literal output arguments and preserves remote authority', async context => {
  const directory = await fixture(context);
  await mkdir(path.join(directory, 'custom'));
  await writeFile(path.join(directory, 'custom', 'main.pdf'), '%PDF-fixture');
  const remote = `vscode-remote://ssh-remote+example${new URL(uri(path.join(directory, 'main.tex'))).pathname}`;
  const found = await resolve_latex_pdf(remote, { tool_args: ['-outdir=custom'] });
  assert.ok(found.pdf_uris.some(value => value.endsWith('/custom/main.pdf')));
  assert.ok(found.pdf_uris.every(value => value.startsWith('vscode-remote://ssh-remote+example/')));
});

test('root cycles and missing outputs fail predictably without scanning unrelated directories', async context => {
  const directory = await fixture(context);
  await writeFile(path.join(directory, 'main.tex'), '% !TeX root = chapter/one.tex\n');
  await assert.rejects(resolve_latex_pdf(uri(path.join(directory, 'main.tex'))), /cycle/);
  await writeFile(path.join(directory, 'main.tex'), '% !TeX root = missing.tex\n');
  await assert.rejects(resolve_latex_pdf(uri(path.join(directory, 'main.tex'))), /cannot be read/);
  await writeFile(path.join(directory, 'new.tex'), '\\documentclass{article}');
  assert.deepEqual((await resolve_latex_pdf(uri(path.join(directory, 'new.tex')))).pdf_uris, []);
});

test('SyncTeX output parsing requires a complete bounded record and preserves colons in source paths', () => {
  assert.deepEqual(parse_synctex_output(result('C:\\Project Name\\main.tex', 42, 5)), { input: 'C:\\Project Name\\main.tex', line: 42, column: 5 });
  assert.deepEqual(parse_synctex_output(result('/a:b/main.tex')), { input: '/a:b/main.tex', line: 23, column: 1 });
  for (const output of ['', 'Input:evil.tex\nLine:1', result('main.tex', 0), result('main.tex', 1_000_000_000),
    result('main.tex').replace('SyncTeX result end', ''), 'x'.repeat(1024 * 1024 + 1)]) {
    assert.equal(parse_synctex_output(output), undefined);
  }
});

test('reverse sync invokes a bounded executable with literal arguments, suppresses editor execution, and resolves existing TeX files', async context => {
  const directory = await fixture(context);
  const previous = process.env.SYNCTEX_EDITOR;
  process.env.SYNCTEX_EDITOR = 'must never execute';
  context.after(async () => { if (previous === undefined) delete process.env.SYNCTEX_EDITOR; else process.env.SYNCTEX_EDITOR = previous; });
  const pdf = path.join(directory, 'build', 'main.pdf');
  let invoked = 0;
  const location = await reverse_sync(uri(pdf), 2, 72.5, 144, {
    synctex_path: process.execPath,
    run: async (file, args, options) => {
      invoked++;
      assert.equal(file, process.execPath);
      assert.deepEqual(args, ['edit', '-o', `2:72.5:144:${pdf}`]);
      assert.equal(options.cwd, path.dirname(pdf));
      assert.equal(options.env.SYNCTEX_EDITOR, undefined);
      assert.equal(options.timeout, 5000);
      assert.equal(options.maxBuffer, 1024 * 1024);
      return result('./main.tex', 18, -1);
    },
  });
  assert.equal(invoked, 1);
  assert.deepEqual(location, { uri: uri(path.join(directory, 'main.tex')), line: 18, column: 1 });
});

test('reverse sync handles remote source files and rejects unavailable or invalid synchronization data', async context => {
  const directory = await fixture(context);
  const pdf_path = new URL(uri(path.join(directory, 'build', 'main.pdf'))).pathname;
  const remote = `vscode-remote://ssh-remote+example${pdf_path}`;
  const location = await reverse_sync(remote, 1, 0, 0, { synctex_path: process.execPath, run: async () => result('../main.tex') });
  assert.ok(location.uri.startsWith('vscode-remote://ssh-remote+example/'));
  await assert.rejects(reverse_sync(remote, 0, 0, 0), /position is invalid/);
  await assert.rejects(reverse_sync(remote, 1, 0, 0, { synctex_path: path.join(directory, 'missing_executable') }), /SyncTeX was not found/);
  await assert.rejects(reverse_sync(remote, 1, 0, 0, { synctex_path: process.execPath, run: async () => result('https://evil/main.tex') }), /local .tex/);
  await assert.rejects(reverse_sync(remote, 1, 0, 0, { synctex_path: process.execPath, run: async () => result('missing.tex') }), /no longer exists/);
  await rm(path.join(directory, 'build', 'main.synctex.gz'));
  await assert.rejects(reverse_sync(remote, 1, 0, 0), /No SyncTeX data/);
});

test('an associated root resolves relative SyncTeX input from deeply nested PDF output directories', async context => {
  const directory = await fixture(context);
  const nested = path.join(directory, 'build', 'pdf');
  await mkdir(nested);
  await writeFile(path.join(nested, 'main.pdf'), '%PDF-fixture');
  await writeFile(path.join(nested, 'main.synctex.gz'), 'fixture');
  const settings = { synctex_path: process.execPath, run: async () => result('./main.tex', 7, 2) };
  await assert.rejects(reverse_sync(uri(path.join(nested, 'main.pdf')), 1, 0, 0, settings), /no longer exists/);
  assert.deepEqual(await reverse_sync(uri(path.join(nested, 'main.pdf')), 1, 0, 0,
    { ...settings, root_uri: uri(path.join(directory, 'main.tex')) }),
  { uri: uri(path.join(directory, 'main.tex')), line: 7, column: 2 });
});

test('remote PDF candidate URIs preserve literal percent characters when returning to the same host', async context => {
  const directory = await fixture(context);
  const root = path.join(directory, '100%20complete.tex');
  const pdf = path.join(directory, '100%20complete.pdf');
  await writeFile(root, '\\documentclass{article}');
  await writeFile(pdf, '%PDF-fixture');
  const remote_root = `vscode-remote://ssh-remote+example${new URL(uri(root)).pathname}`;
  const found = await resolve_latex_pdf(remote_root);
  assert.equal(new URL(found.root_uri).host, 'ssh-remote+example');
  assert.equal(remote_latex_path(new URL(found.root_uri).pathname), root);
  assert.equal(found.pdf_uris.length, 1);
  assert.equal(new URL(found.pdf_uris[0]).host, 'ssh-remote+example');
  assert.equal(remote_latex_path(new URL(found.pdf_uris[0]).pathname), pdf);
});
