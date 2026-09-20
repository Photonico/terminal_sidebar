import * as vscode from 'vscode';
import { open } from 'node:fs/promises';
import * as path from 'node:path';
import { max_markdown_bytes } from './markdown_state';

/** A bounded read also handles a file that grows between stat and read. */
export async function read_markdown(file_path: string): Promise<string> {
  const file = await open(file_path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > max_markdown_bytes) throw new Error('Choose a Markdown file smaller than 4 MiB.');
    const bytes = Buffer.alloc(Math.min(max_markdown_bytes + 1, Math.max(stat.size + 1, 8192)));
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const remaining = max_markdown_bytes + 1 - total;
      const { bytesRead } = await file.read(bytes, 0, Math.min(bytes.length, remaining), null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > max_markdown_bytes) throw new Error('Choose a Markdown file smaller than 4 MiB.');
      chunks.push(Buffer.from(bytes.subarray(0, bytesRead)));
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total)); }
    catch { throw new Error('Markdown preview requires a UTF-8 text file.'); }
  } finally { await file.close(); }
}

/** Watch the directory so Vim's replace-on-save and file recreation both work. */
export class markdown_watch implements vscode.Disposable {
  private readonly watcher: vscode.FileSystemWatcher;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private disposed = false;

  constructor(
    readonly uri: vscode.Uri,
    private readonly changed: (text: string) => void,
    private readonly unavailable: (message: string) => void,
  ) {
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(uri.with({ path: path.posix.dirname(uri.path) }), '*'),
    );
    const on_change = (file: vscode.Uri) => {
      if (file.toString() === uri.toString()) this.refresh();
    };
    this.watcher.onDidChange(on_change);
    this.watcher.onDidCreate(on_change);
    this.watcher.onDidDelete(on_change);
  }

  refresh(): void {
    if (this.disposed) return;
    const generation = ++this.generation;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.reload(generation); }, 350);
  }

  private async reload(generation: number): Promise<void> {
    try {
      const text = await read_markdown(this.uri.fsPath);
      if (this.current(generation)) this.changed(text);
    } catch (error) {
      if (!this.current(generation)) return;
      const message = error instanceof Error ? error.message : '';
      this.unavailable(message.startsWith('Choose a Markdown') || message.startsWith('Markdown preview requires')
        ? message : 'Markdown unavailable. Waiting for the file to be created again. The last preview is kept.');
    }
  }

  private current(generation: number): boolean { return !this.disposed && generation === this.generation; }

  dispose(): void {
    this.disposed = true;
    ++this.generation;
    clearTimeout(this.timer);
    this.watcher.dispose();
  }
}
