import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { convert_postscript, maximum_converted_pdf_bytes, maximum_postscript_bytes,
  postscript_environment, type postscript_runner } from '../src/postscript_preview';

const pdf = Buffer.from('%PDF-1.7\nTest conversion fixture\n%%EOF\n');
const eps = '%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 12 24\n0 0 moveto 12 24 lineto stroke showpage\n';

async function fixture(context: { after(callback: () => Promise<void>): void }, extension = '.eps') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'terminal_sidebar_postscript_'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, `vector %d ; $ literal${extension}`);
  const cache = path.join(directory, 'cache %d');
  await writeFile(source, eps);
  return { directory, source, cache };
}

const successful_run: postscript_runner = async (_file, args, options) => {
  if (args[0] === '--version') return '10.07.1\n';
  await writeFile(path.join(options.cwd, 'preview.pdf'), pdf);
  return '';
};

test('PostScript environment removes interpreter injection and confines temporary files', () => {
  const env = postscript_environment('/isolated', { Path: '/bin', GS_OPTIONS: '-dNOSAFER evil.ps', gs_lib: '/unsafe',
    GS_FONTPATH: '/unsafe', GSC: '/other/tool', GS: 'bad', TEMP: '/old', tmpdir: '/old2', HOME: '/home/user' });
  assert.deepEqual(env, { Path: '/bin', HOME: '/home/user', TMPDIR: '/isolated', TEMP: '/isolated', TMP: '/isolated' });
});

test('EPS conversion snapshots literal filenames, uses restricted process arguments and cleans its private result', async context => {
  const h = await fixture(context);
  let conversions = 0;
  const run: postscript_runner = async (file, args, options) => {
    assert.equal(file, process.execPath);
    assert.equal(options.windowsHide, true);
    assert.equal(options.killSignal, 'SIGKILL');
    assert.equal(options.maxBuffer, 1024 * 1024);
    assert.equal(options.env.TMPDIR, options.cwd);
    if (args[0] === '--version') { assert.equal(options.timeout, 3000); return '10.07.1\n'; }
    conversions++;
    assert.equal(options.timeout, 15_000);
    assert.deepEqual(args, ['-dSAFER', '-dBATCH', '-dNOPAUSE', '-dQUIET', '-sDEVICE=pdfwrite',
      '-dCompatibilityLevel=1.7', '-dEPSCrop', '-sOutputFile=preview.pdf', '-f', 'source.eps']);
    assert.equal(await readFile(path.join(options.cwd, 'source.eps'), 'utf8'), eps);
    await writeFile(path.join(options.cwd, 'preview.pdf'), pdf);
    return '';
  };
  const result = await convert_postscript(h.source, h.cache, { executable: process.execPath, run });
  assert.equal(conversions, 1);
  assert.deepEqual(await readFile(result.pdf_path), pdf);
  assert.equal(await readFile(h.source, 'utf8'), eps, 'the original document stays intact');
  assert.deepEqual(await readdir(path.dirname(result.pdf_path)), ['preview.pdf']);
  await result.dispose();
  await result.dispose();
  assert.deepEqual(await readdir(h.cache), []);
});

test('PostScript documents retain page dimensions and do not use EPS cropping', async context => {
  const h = await fixture(context, '.ps');
  const result = await convert_postscript(h.source, h.cache, { executable: process.execPath,
    run: async (file, args, options) => {
      assert.equal(args.includes('-dEPSCrop'), false);
      if (args[0] !== '--version') assert.equal(args.at(-1), 'source.ps');
      return successful_run(file, args, options);
    } });
  await result.dispose();
});

test('invalid source, oversized input and old interpreters fail before conversion and remove temporary data', async context => {
  const h = await fixture(context);
  let calls = 0;
  const run: postscript_runner = async () => { calls++; return '9.49\n'; };
  await assert.rejects(convert_postscript(h.source, h.cache, { executable: 'gs', run }), /absolute path/);
  assert.deepEqual(await readdir(h.cache), []);
  await writeFile(h.source, '<svg/>');
  await assert.rejects(convert_postscript(h.source, h.cache, { executable: process.execPath, run }), /does not contain/);
  assert.equal(calls, 0);
  const file = await open(h.source, 'w');
  await file.truncate(maximum_postscript_bytes + 1);
  await file.close();
  await assert.rejects(convert_postscript(h.source, h.cache, { executable: process.execPath, run }), /32 MiB/);
  assert.equal(calls, 0);
  await writeFile(h.source, eps);
  await assert.rejects(convert_postscript(h.source, h.cache, { executable: process.execPath, run }), /9.50 or newer/);
  assert.equal(calls, 1);
  assert.deepEqual(await readdir(h.cache), []);
});

test('incomplete PDF and oversized output are never exposed as a preview', async context => {
  const h = await fixture(context);
  for (const oversized of [false, true]) {
    await assert.rejects(convert_postscript(h.source, h.cache, { executable: process.execPath,
      run: async (_file, args, options) => {
        if (args[0] === '--version') return '10.07.1\n';
        const target = await open(path.join(options.cwd, 'preview.pdf'), 'w');
        await target.write(Buffer.from('%PDF-1.7\nincomplete'));
        if (oversized) await target.truncate(maximum_converted_pdf_bytes + 1);
        await target.close();
        return '';
      } }), oversized ? /64 MiB/ : /complete PDF/);
    assert.deepEqual(await readdir(h.cache), []);
  }
});

test('cancelling an active interpreter aborts its process signal and removes the snapshot', async context => {
  const h = await fixture(context);
  const controller = new AbortController();
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const conversion = convert_postscript(h.source, h.cache, { executable: process.execPath, signal: controller.signal,
    run: async (_file, args, options) => {
      if (args[0] === '--version') return '10.07.1\n';
      started();
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort',
        () => reject(options.signal.reason), { once: true }));
    } });
  await entered;
  const rejected = assert.rejects(conversion, { name: 'AbortError' });
  controller.abort();
  await rejected;
  assert.deepEqual(await readdir(h.cache), []);
});

test('an interpreter that keeps growing its output is stopped before it can finish', async context => {
  const h = await fixture(context);
  let stopped = false;
  await assert.rejects(convert_postscript(h.source, h.cache, { executable: process.execPath,
    run: async (_file, args, options) => {
      if (args[0] === '--version') return '10.07.1\n';
      const target = await open(path.join(options.cwd, 'preview.pdf'), 'w');
      await target.truncate(maximum_converted_pdf_bytes + 1);
      await target.close();
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => {
        stopped = true;
        reject(options.signal.reason);
      }, { once: true }));
    } }), /64 MiB/);
  assert.equal(stopped, true);
  assert.deepEqual(await readdir(h.cache), []);
});

test('installed Ghostscript converts the repository EPS at its bounding box', async context => {
  const h = await fixture(context);
  let result;
  try { result = await convert_postscript(path.resolve(__dirname, '../assets/logo.eps'), h.cache); }
  catch (error) {
    if (error instanceof Error && error.message.includes('require Ghostscript on the current extension host')) {
      context.skip('Ghostscript is not installed on this test host');
      return;
    }
    throw error;
  }
  const document = await PDFDocument.load(await readFile(result.pdf_path));
  assert.equal(document.getPageCount(), 1);
  assert.deepEqual(document.getPage(0).getSize(), { width: 384, height: 384 });
  assert.ok((await stat(result.pdf_path)).size > 1000);
  await result.dispose();
});
