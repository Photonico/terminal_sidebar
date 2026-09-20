import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, open, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface latex_preview_options {
  out_dir?: string;
  jobname?: string;
  workspace_directory?: string;
  /** Literal configured tool arguments are inspected, never executed. */
  tool_args?: readonly string[];
}

export interface latex_pdf_candidates {
  root_uri: string;
  pdf_uris: string[];
}

export interface synctex_location { uri: string; line: number; column: number }
export interface synctex_record { input: string; line: number; column: number }

interface process_options {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer: number;
  windowsHide: boolean;
}
type synctex_runner = (file: string, args: string[], options: process_options) => Promise<string>;
export interface reverse_sync_options {
  synctex_path?: string;
  root_uri?: string;
  aux_directory?: string;
  /** Allows the process boundary to be replaced in tests without invoking a compiler. */
  run?: synctex_runner;
}

function safe_path(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\x00-\x1f\x7f]/.test(value);
}

/** Remote URI paths use forward slashes even when the extension host runs Windows. */
export function remote_latex_path(pathname: string, platform: NodeJS.Platform = process.platform): string {
  const decoded = decodeURIComponent(pathname);
  if (platform !== 'win32') return decoded;
  const native = /^\/[a-z]:($|\/)/i.test(decoded) ? decoded.slice(1) : decoded;
  return native.replace(/\//g, '\\');
}

function file_reference(value: string, extension: RegExp): { url: URL; filename: string } {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Choose a file on the current extension host.'); }
  if (!safe_path(value) || !['file:', 'vscode-remote:'].includes(url.protocol) || url.search || url.hash) {
    throw new Error('Choose a file on the current extension host.');
  }
  const filename = url.protocol === 'file:' ? fileURLToPath(url) : remote_latex_path(url.pathname);
  if (!safe_path(filename) || !path.isAbsolute(filename) || !extension.test(filename)) {
    throw new Error('Choose a file of the expected type on the current extension host.');
  }
  return { url, filename };
}

function related_uri(filename: string, original: URL): string {
  if (original.protocol === 'file:') return pathToFileURL(filename).toString();
  const result = new URL(original);
  result.pathname = filename.split(path.sep).join('/').split('/').map(encodeURIComponent).join('/');
  return result.toString();
}

async function exists(filename: string): Promise<boolean> {
  try { return (await stat(filename)).isFile(); } catch { return false; }
}

/** Read only the header where TeX editors conventionally place root magic comments. */
async function tex_header(filename: string): Promise<string> {
  const file = await open(filename, 'r');
  try {
    if (!(await file.stat()).isFile()) throw new Error('The LaTeX source is not a regular file.');
    const buffer = Buffer.alloc(65536);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await file.close(); }
}

export function tex_root_comment(source: string): string | undefined {
  const match = /^\s*%\s*!\s*TEX\s+root\s*=\s*(.+?)\s*$/im.exec(source.slice(0, 65536));
  if (!match) return undefined;
  const value = match[1].replace(/^(['"])(.*)\1$/, '$2').trim();
  return safe_path(value) ? value : undefined;
}

/** Expand documented path placeholders only; shell and environment expressions stay inert. */
export function latex_output_directory(root: string, value: string, workspace_directory?: string): string | undefined {
  if (!safe_path(value)) return undefined;
  const directory = path.dirname(root);
  const basename = path.basename(root, path.extname(root));
  const document = path.join(directory, basename);
  const workspace = workspace_directory && path.isAbsolute(workspace_directory) ? workspace_directory : directory;
  const placeholders: Record<string, string> = {
    DIR: directory, DIR_W32: directory, DOC: document, DOC_W32: document,
    DOC_EXT: root, DOC_EXT_W32: root, DOCFILE: basename, DOCFILE_EXT: path.basename(root),
    WORKSPACE_FOLDER: workspace, RELATIVE_DIR: path.relative(workspace, directory),
    RELATIVE_DOC: path.relative(workspace, document),
  };
  const expanded = value.replace(/%([A-Z_]+)%/g, (token, key: string) => placeholders[key] ?? token);
  if (/%[A-Z_]+%/.test(expanded) || !safe_path(expanded)) return undefined;
  return path.resolve(directory, expanded);
}

function tool_output_directories(args: readonly string[]): string[] {
  const directories: string[] = [];
  for (let index = 0; index < Math.min(args.length, 256); index++) {
    const argument = args[index];
    if (typeof argument !== 'string') continue;
    const match = /^--?(?:outdir|out-directory|output-directory)(?:=(.*))?$/.exec(argument);
    const value = match && (match[1] ?? args[index + 1]);
    if (safe_path(value)) directories.push(value.replace(/^(['"])(.*)\1$/, '$2'));
  }
  return directories;
}

/** Find existing output without compiling, evaluating latexmkrc, or walking the repository. */
export async function resolve_latex_pdf(source_uri: string, options: latex_preview_options = {}): Promise<latex_pdf_candidates> {
  const source = file_reference(source_uri, /\.tex$/i);
  let root = source.filename;
  const visited = new Set<string>();
  for (let depth = 0; ; depth++) {
    if (depth >= 16 || visited.has(root)) throw new Error('The LaTeX root comments form a cycle or exceed 16 files. Choose the root .tex file directly.');
    visited.add(root);
    let header: string;
    try { header = await tex_header(root); } catch { throw new Error('The LaTeX root source cannot be read. Choose the root .tex file directly.'); }
    const reference = tex_root_comment(header);
    if (!reference) break;
    // Magic comments describe filenames, not commands or URLs to fetch.
    const next = path.resolve(path.dirname(root), reference);
    if (!/\.tex$/i.test(next)) throw new Error('The LaTeX root comment must name a .tex file.');
    if (next === root) break;
    root = next;
  }
  const name = options.jobname?.trim() || path.basename(root, path.extname(root));
  if (!safe_path(name) || name === '.' || name === '..' || /[\\/]/.test(name) || /%[A-Z_]+%/.test(name)) {
    throw new Error('The LaTeX jobname must be a filename without directory separators or placeholders.');
  }
  const configured = options.out_dir || '%DIR%';
  const output_values = [configured];
  if (configured === '%DIR%' || configured === '%DIR_W32%') output_values.push(...tool_output_directories(options.tool_args ?? []));
  output_values.push('%DIR%/.output', '%DIR%/build', '%DIR%/out', '%DIR%');
  const directories = [...new Set(output_values.map(value => latex_output_directory(root, value, options.workspace_directory))
    .filter((value): value is string => value !== undefined))];
  const candidates = directories.map(output => path.join(output, `${name}.pdf`));
  const present = await Promise.all(candidates.map(exists));
  return { root_uri: related_uri(root, source.url),
    pdf_uris: candidates.filter((_, index) => present[index]).map(filename => related_uri(filename, source.url)) };
}

/** The CLI's output is data, never an editor command. Unknown columns normalize to 1. */
export function parse_synctex_output(output: string): synctex_record | undefined {
  if (output.length > 1024 * 1024) return undefined;
  const begin = output.indexOf('SyncTeX result begin');
  if (begin < 0 || output.indexOf('SyncTeX result end', begin) < 0) return undefined;
  let current: Partial<synctex_record> | undefined;
  let started = false;
  const complete = () => current && safe_path(current.input) && Number.isInteger(current.line)
    && current.line! >= 1 && current.line! <= 10_000_000
    ? { input: current.input, line: current.line!, column: current.column ?? 1 } : undefined;
  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === 'SyncTeX result begin') { started = true; continue; }
    if (!started) continue;
    if (line.trim() === 'SyncTeX result end') return complete();
    const match = /^(Input|Line|Column):(.*)$/i.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key === 'input') {
      const previous = complete();
      if (previous) return previous;
      current = { input: value };
    } else if (current && /^-?\d+$/.test(value)) {
      const number = Number(value);
      if (key === 'line') current.line = number;
      else current.column = Number.isSafeInteger(number) && number >= 1 && number <= 10_000_000 ? number : 1;
    }
  }
  return undefined;
}

async function executable(filename: string): Promise<boolean> {
  try { await access(filename, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return await exists(filename); } catch { return false; }
}

async function find_synctex(selection: string | undefined, cwd: string): Promise<string> {
  const command = selection?.trim() || 'synctex';
  if (!safe_path(command)) throw new Error('Set latex-workshop.synctex.path to a SyncTeX executable.');
  if (path.isAbsolute(command) || /[\\/]/.test(command)) {
    const filename = path.resolve(cwd, command);
    if (await executable(filename)) return filename;
  } else {
    const directories = (process.env.PATH ?? '').split(path.delimiter).filter(value => value && path.isAbsolute(value)).slice(0, 128);
    if (process.platform === 'darwin') directories.push('/Library/TeX/texbin');
    const names = process.platform === 'win32' && !/\.(exe|com)$/i.test(command) ? [`${command}.exe`, `${command}.com`] : [command];
    for (const directory of [...new Set(directories)]) for (const name of names) {
      const filename = path.join(directory, name);
      if (await executable(filename)) return filename;
    }
  }
  throw new Error('SyncTeX was not found. Install it with your TeX distribution or set latex-workshop.synctex.path to its executable.');
}

const run_synctex: synctex_runner = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, { ...options, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout));
});

/** Query existing SyncTeX data. The caller must require workspace trust before invoking native tools. */
export async function reverse_sync(pdf_uri: string, page: number, x: number, y: number, options: reverse_sync_options = {}): Promise<synctex_location> {
  const pdf = file_reference(pdf_uri, /\.pdf$/i);
  if (!Number.isInteger(page) || page < 1 || page > 1_000_000 || !Number.isFinite(x) || !Number.isFinite(y)
    || x < 0 || y < 0 || x > 1_000_000 || y > 1_000_000) throw new Error('The PDF source position is invalid.');
  if (!await exists(pdf.filename)) throw new Error('The PDF is unavailable. Wait for the existing LaTeX build to finish.');
  const directory = path.dirname(pdf.filename);
  let root_directory: string | undefined;
  if (options.root_uri) {
    const root = file_reference(options.root_uri, /\.tex$/i);
    if (root.url.protocol !== pdf.url.protocol || root.url.host !== pdf.url.host) throw new Error('The LaTeX source and PDF must use the same extension host.');
    root_directory = path.dirname(root.filename);
  }
  const aux_directory = options.aux_directory && safe_path(options.aux_directory)
    ? path.resolve(root_directory ?? directory, options.aux_directory) : undefined;
  const stem = path.basename(pdf.filename, path.extname(pdf.filename));
  const synctex_files = [...new Set([directory, aux_directory].filter((value): value is string => !!value))]
    .flatMap(folder => [path.join(folder, `${stem}.synctex.gz`), path.join(folder, `${stem}.synctex`)]);
  if (!(await Promise.all(synctex_files.map(exists))).some(Boolean)) {
    throw new Error('No SyncTeX data was found. Enable -synctex=1 in your existing LaTeX build, then build the document again.');
  }
  const command = await find_synctex(options.synctex_path, directory);
  const args = ['edit', '-o', `${page}:${x}:${y}:${pdf.filename}`];
  if (aux_directory) args.push('-d', aux_directory);
  const env = { ...process.env };
  // SyncTeX otherwise executes this variable as an editor even without a -x argument.
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'SYNCTEX_EDITOR') delete env[key];
  let output: string;
  try {
    output = await (options.run ?? run_synctex)(command, args,
      { cwd: directory, env, timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true });
  } catch {
    throw new Error('SyncTeX could not locate the source within 5 seconds. Check that the PDF and SyncTeX files belong to the same completed build.');
  }
  const record = parse_synctex_output(output);
  if (!record) throw new Error('No LaTeX source was found at this PDF position. Double-click typeset text, or rebuild with SyncTeX enabled.');
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(record.input) || !/\.tex$/i.test(record.input)) {
    throw new Error('SyncTeX did not return a local .tex source file.');
  }
  const sources = path.isAbsolute(record.input) ? [record.input]
    : [...new Set([root_directory, directory, path.dirname(directory)].filter((value): value is string => !!value))]
      .map(folder => path.resolve(folder, record.input));
  for (const filename of sources) if (await exists(filename)) {
    return { uri: related_uri(filename, pdf.url), line: record.line, column: record.column };
  }
  throw new Error('The source file reported by SyncTeX no longer exists. Rebuild the document from its current location.');
}
