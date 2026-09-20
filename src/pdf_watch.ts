import * as vscode from 'vscode';
import { open, stat } from 'node:fs/promises';
import * as path from 'node:path';

/** Watch the parent directory as LaTeX may replace, truncate, or recreate the PDF. */
export class pdf_watch implements vscode.Disposable {
  private readonly watcher: vscode.FileSystemWatcher;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private disposed = false;

  constructor(
    readonly uri: vscode.Uri,
    private readonly changed: () => void,
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
    this.timer = setTimeout(() => { void this.check(generation); }, 700);
  }

  private async check(generation: number): Promise<void> {
    try {
      const before = await stat(this.uri.fsPath);
      if (!before.isFile() || before.size > 512 * 1024 * 1024) {
        throw new Error('Choose a PDF file smaller than 512 MiB.');
      }
      // A newer event may arrive while stat is pending. It owns the current timer.
      if (!this.current(generation)) return;
      this.timer = setTimeout(() => { void this.check_stable(generation, before.size, before.mtimeMs); }, 400);
    } catch (error) {
      if (this.current(generation)) this.unavailable(error instanceof Error && error.message.startsWith('Choose')
        ? error.message : 'PDF unavailable. Waiting for the file to be created again.');
    }
  }

  private async check_stable(generation: number, size: number, modified: number): Promise<void> {
    if (!this.current(generation)) return;
    try {
      const after = await stat(this.uri.fsPath);
      if (!this.current(generation)) return;
      if (after.size !== size || after.mtimeMs !== modified) { this.refresh(); return; }
      // Read just the envelope, never transfer the whole thesis through postMessage.
      const file = await open(this.uri.fsPath, 'r');
      let complete = false;
      try {
        const head = Buffer.alloc(5);
        const tail = Buffer.alloc(Math.min(size, 2048));
        await file.read(head, 0, head.length, 0);
        await file.read(tail, 0, tail.length, Math.max(0, size - tail.length));
        const final = await file.stat();
        complete = final.size === size && final.mtimeMs === modified
          && head.toString() === '%PDF-' && tail.includes('%%EOF');
      } finally { await file.close(); }
      if (this.current(generation)) {
        if (complete) this.changed();
        else this.unavailable('PDF is being written or is incomplete. The last preview is kept.');
      }
    } catch {
      if (this.current(generation)) this.unavailable('PDF unavailable. Waiting for the file to be created again.');
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
