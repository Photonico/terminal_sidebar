import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, open, readdir, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';

export const maximum_postscript_bytes = 32 * 1024 * 1024;
export const maximum_converted_pdf_bytes = 64 * 1024 * 1024;

interface process_options {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer: number;
  windowsHide: boolean;
  signal: AbortSignal;
  killSignal: 'SIGKILL';
}
export type postscript_runner = (file: string, args: string[], options: process_options) => Promise<string>;
export interface postscript_options {
  /** An absolute executable path, never a shell command or arguments. */
  executable?: string;
  signal?: AbortSignal;
  /** Replace only the native process boundary in tests. */
  run?: postscript_runner;
}
export interface postscript_preview {
  pdf_path: string;
  dispose(): Promise<void>;
}

const run_ghostscript: postscript_runner = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, { ...options, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout));
});

function valid_path(value: string): boolean {
  return value.length > 0 && value.length <= 8192 && !/[\x00-\x1f\x7f]/.test(value) && path.isAbsolute(value);
}

async function executable_file(filename: string): Promise<boolean> {
  try {
    await access(filename, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return (await stat(filename)).isFile();
  } catch { return false; }
}

async function find_ghostscript(selection?: string): Promise<string> {
  if (selection?.trim()) {
    const filename = selection.trim();
    if (!valid_path(filename) || !await executable_file(filename)) {
      throw new Error('Set terminalSidebar.ghostscriptPath to the absolute path of a Ghostscript executable.');
    }
    return filename;
  }
  const env_path = Object.entries(process.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  const directories = env_path.split(path.delimiter).filter(directory => valid_path(directory)).slice(0, 128);
  if (process.platform === 'darwin') directories.push('/opt/homebrew/bin', '/usr/local/bin', '/Library/TeX/texbin');
  else if (process.platform !== 'win32') directories.push('/usr/local/bin', '/usr/bin');
  const names = process.platform === 'win32' ? ['gswin64c.exe', 'gswin32c.exe', 'gs.exe'] : ['gs'];
  if (process.platform === 'win32') {
    const roots = Object.entries(process.env).filter(([key, value]) => /^(programfiles|programfiles\(x86\))$/i.test(key)
      && value && valid_path(value)).map(([, value]) => path.join(value!, 'gs'));
    for (const root of [...new Set(roots)]) {
      try {
        const versions = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()
          && /^gs\d+(?:\.\d+){1,3}$/i.test(entry.name)).map(entry => entry.name)
          .sort((a, b) => b.localeCompare(a, 'en', { numeric: true })).slice(0, 32);
        directories.push(...versions.map(version => path.join(root, version, 'bin')));
      } catch { /* An installation outside PATH is optional. */ }
    }
  }
  for (const directory of [...new Set(directories)]) for (const name of names) {
    const filename = path.join(directory, name);
    if (await executable_file(filename)) return filename;
  }
  throw new Error('EPS and PostScript previews require Ghostscript on the current extension host. Install Ghostscript or set terminalSidebar.ghostscriptPath to its executable.');
}

/** GS_OPTIONS can execute files before our arguments; GS_LIB changes interpreter initialization. */
export function postscript_environment(directory: string, environment = process.env): NodeJS.ProcessEnv {
  const env = { ...environment };
  for (const key of Object.keys(env)) if (/^(?:GS(?:_|$)|GSC$|TMPDIR$|TEMP$|TMP$)/i.test(key)) delete env[key];
  return { ...env, TMPDIR: directory, TEMP: directory, TMP: directory };
}

async function snapshot_source(source: string, destination: string, signal: AbortSignal): Promise<void> {
  const input = await open(source, 'r');
  try {
    const before = await input.stat();
    if (!before.isFile() || before.size > maximum_postscript_bytes) throw new Error('Choose an EPS or PostScript file smaller than 32 MiB.');
    const output = await open(destination, 'wx', 0o600);
    try {
      const buffer = Buffer.alloc(64 * 1024);
      let total = 0;
      for (;;) {
        signal.throwIfAborted();
        const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, maximum_postscript_bytes + 1 - total), null);
        if (!bytesRead) break;
        if (!total && !(buffer.subarray(0, 2).equals(Buffer.from('%!'))
          || buffer.subarray(0, 4).equals(Buffer.from([0xc5, 0xd0, 0xd3, 0xc6])))) {
          throw new Error('The file does not contain an EPS or PostScript document.');
        }
        total += bytesRead;
        if (total > maximum_postscript_bytes) throw new Error('Choose an EPS or PostScript file smaller than 32 MiB.');
        let written = 0;
        while (written < bytesRead) {
          const result = await output.write(buffer, written, bytesRead - written);
          written += result.bytesWritten;
        }
      }
      const after = await input.stat();
      if (!total) throw new Error('The EPS or PostScript file is empty.');
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || total !== after.size) {
        throw new Error('The EPS or PostScript file is being written. The last preview is kept.');
      }
    } finally { await output.close(); }
  } finally { await input.close(); }
}

async function validate_pdf(filename: string): Promise<void> {
  const file = await open(filename, 'r');
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > maximum_converted_pdf_bytes) throw new Error('The converted PDF exceeds the 64 MiB preview limit.');
    const header = Buffer.alloc(5);
    const tail = Buffer.alloc(Math.min(metadata.size, 2048));
    await file.read(header, 0, header.length, 0);
    await file.read(tail, 0, tail.length, Math.max(0, metadata.size - tail.length));
    if (header.toString() !== '%PDF-' || !tail.includes('%%EOF')) throw new Error('Ghostscript did not produce a complete PDF preview.');
  } finally { await file.close(); }
}

/** The caller must require workspace trust before invoking this native interpreter. */
export async function convert_postscript(source_path: string, cache_directory: string,
  options: postscript_options = {}): Promise<postscript_preview> {
  if (!valid_path(source_path) || !/\.(eps|epsf|epsi|ps)$/i.test(source_path) || !valid_path(cache_directory)) {
    throw new Error('Choose an EPS or PostScript file on the current extension host.');
  }
  options.signal?.throwIfAborted();
  await mkdir(cache_directory, { recursive: true });
  const directory = await mkdtemp(path.join(cache_directory, 'postscript-'));
  const dispose = () => rm(directory, { recursive: true, force: true });
  const controller = new AbortController();
  const on_abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', on_abort, { once: true });
  if (options.signal?.aborted) on_abort();
  let monitor: ReturnType<typeof setInterval> | undefined;
  let oversized = false;
  try {
    const source = path.join(directory, /\.ps$/i.test(source_path) ? 'source.ps' : 'source.eps');
    const pdf_path = path.join(directory, 'preview.pdf');
    await snapshot_source(source_path, source, controller.signal);
    controller.signal.throwIfAborted();
    const command = await find_ghostscript(options.executable);
    const run = options.run ?? run_ghostscript;
    const process_options: process_options = { cwd: directory, env: postscript_environment(directory),
      timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true, signal: controller.signal, killSignal: 'SIGKILL' };
    const version = await run(command, ['--version'], { ...process_options, timeout: 3000 });
    const match = /^\s*(\d+)\.(\d+)(?:\.\d+)?\s*$/.exec(version);
    if (!match || Number(match[1]) < 9 || (Number(match[1]) === 9 && Number(match[2]) < 50)) {
      throw new Error('EPS and PostScript previews require Ghostscript 9.50 or newer. Update Ghostscript and try again.');
    }
    const args = ['-dSAFER', '-dBATCH', '-dNOPAUSE', '-dQUIET', '-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.7'];
    if (!/\.ps$/i.test(source_path)) args.push('-dEPSCrop');
    // Fixed relative names also avoid Ghostscript's %d output filename expansion in user paths.
    args.push('-sOutputFile=preview.pdf', '-f', path.basename(source));
    monitor = setInterval(() => {
      void stat(pdf_path).then(metadata => {
        if (metadata.size > maximum_converted_pdf_bytes) { oversized = true; controller.abort(); }
      }, () => undefined);
    }, 100);
    try { await run(command, args, process_options); }
    catch (error) {
      if (oversized) throw new Error('The converted PDF exceeds the 64 MiB preview limit.');
      options.signal?.throwIfAborted();
      throw new Error('Ghostscript could not convert this file within 15 seconds. Check that the EPS or PostScript document is valid and uses available fonts.');
    }
    clearInterval(monitor);
    monitor = undefined;
    if (oversized) throw new Error('The converted PDF exceeds the 64 MiB preview limit.');
    controller.signal.throwIfAborted();
    await validate_pdf(pdf_path);
    await rm(source);
    controller.signal.throwIfAborted();
    return { pdf_path, dispose };
  } catch (error) {
    await dispose();
    throw error;
  } finally {
    clearInterval(monitor);
    options.signal?.removeEventListener('abort', on_abort);
  }
}
