import * as vscode from 'vscode';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { convert_postscript, maximum_postscript_bytes, type postscript_options, type postscript_preview } from './postscript_preview';

/** Watch the original vector source, including replace-on-save and file recreation. */
export class postscript_watch implements vscode.Disposable {
  private readonly watcher: vscode.FileSystemWatcher;
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: AbortController;
  private generation = 0;
  private disposed = false;
  private current_preview?: postscript_preview;
  private previous_preview?: postscript_preview;
  private signature?: string;

  constructor(readonly uri: vscode.Uri, private readonly cache_directory: string,
    private readonly changed: (pdf_path: string) => void,
    private readonly unavailable: (message: string) => void,
    private readonly options: postscript_options = {}) {
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(uri.with({ path: path.posix.dirname(uri.path) }), '*'));
    const on_change = (file: vscode.Uri) => { if (file.toString() === uri.toString()) this.refresh(); };
    this.watcher.onDidChange(on_change);
    this.watcher.onDidCreate(on_change);
    this.watcher.onDidDelete(on_change);
  }

  refresh(): void {
    if (this.disposed) return;
    const generation = ++this.generation;
    this.pending?.abort();
    this.pending = undefined;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.reload(generation); }, 700);
  }

  private async reload(generation: number): Promise<void> {
    try {
      const metadata = await stat(this.uri.fsPath);
      if (!this.current(generation)) return;
      if (!metadata.isFile() || metadata.size > maximum_postscript_bytes) throw new Error('Choose an EPS or PostScript file smaller than 32 MiB.');
      const signature = `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`;
      if (signature === this.signature && this.current_preview) { this.changed(this.current_preview.pdf_path); return; }
      const controller = new AbortController();
      this.pending = controller;
      const preview = await convert_postscript(this.uri.fsPath, this.cache_directory,
        { ...this.options, signal: controller.signal });
      if (!this.current(generation)) { await preview.dispose(); return; }
      this.pending = undefined;
      // Keep one previous result while PDF.js switches sources and finishes pending range reads.
      const obsolete = this.previous_preview;
      this.previous_preview = this.current_preview;
      this.current_preview = preview;
      this.signature = signature;
      this.changed(preview.pdf_path);
      void obsolete?.dispose().catch(() => undefined);
    } catch (error) {
      if (!this.current(generation)) return;
      this.pending = undefined;
      const message = error instanceof Error ? error.message : '';
      this.unavailable(message.startsWith('Choose ') || message.startsWith('EPS ') || message.startsWith('Set ')
        || message.startsWith('The ') || message.startsWith('Ghostscript ')
        ? message : 'EPS or PostScript unavailable. Waiting for the file to be created again. The last preview is kept.');
    }
  }

  private current(generation: number): boolean { return !this.disposed && generation === this.generation; }

  dispose(): void {
    this.disposed = true;
    ++this.generation;
    clearTimeout(this.timer);
    this.pending?.abort();
    this.watcher.dispose();
    void this.current_preview?.dispose().catch(() => undefined);
    void this.previous_preview?.dispose().catch(() => undefined);
    this.current_preview = this.previous_preview = undefined;
  }
}
