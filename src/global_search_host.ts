import * as vscode from 'vscode';
import { randomUUID as random_uuid } from 'node:crypto';
import { read_markdown } from './markdown_watch';
import { read_text_document } from './text_document_watch';
import { is_terminal_tab, is_markdown_tab, is_document_tab, type sidebar_side, type sidebar_tab } from './types';
import type { search_request, search_response, search_source, terminal_snapshot } from './global_search_protocol';

interface search_view {
  ready: boolean;
  readonly history: ReadonlyMap<string, string>;
  view?: vscode.WebviewView;
  post(message: search_response): void;
}
interface search_host_options {
  view(side: sidebar_side): search_view;
  tabs(side: sidebar_side): readonly sidebar_tab[];
  reveal(side: sidebar_side, id: string): Promise<void>;
}

/** Route text snapshots, never process input or arbitrary file paths, between the two views. */
export class global_search_host {
  private readonly reveals = new Map<sidebar_side, Extract<search_response, { type: 'search_reveal' }>>();
  private readonly pending = new Map<string, { side: sidebar_side; finish(snapshot?: terminal_snapshot): void }>();
  constructor(private readonly options: search_host_options) {}

  async receive(side: sidebar_side, message: search_request): Promise<void> {
    if (!vscode.workspace.isTrusted) return;
    const requester = this.options.view(side);
    if (message.type === 'search_snapshot') {
      const pending = this.pending.get(message.request);
      if (pending?.side === side) pending.finish(message.snapshot);
    } else if (message.type === 'search_catalog') {
      requester.post({ type: 'search_catalog', request: message.request, tabs: (['left', 'right'] as const).flatMap(side =>
        this.options.tabs(side).map(tab => ({ side, id: tab.id, name: tab.name, kind: tab.kind ?? 'terminal' }))) });
    } else if (message.type === 'search_read') {
      try {
        const tab = this.options.tabs(message.side).find(tab => tab.id === message.id);
        if (!tab) throw new Error('Tab was closed');
        let source: search_source;
        if (is_terminal_tab(tab)) {
          source = { kind: 'terminal', snapshot: await this.snapshot(message.side, tab.id) };
        } else if (is_markdown_tab(tab)) {
          source = { kind: 'markdown', text: await read_markdown(vscode.Uri.parse(tab.uri).fsPath) };
        } else if (is_document_tab(tab)) {
          source = { kind: 'document', format: tab.format, text: await read_text_document(vscode.Uri.parse(tab.uri).fsPath, tab.format.toUpperCase()) };
        } else {
          if (!requester.view) return;
          source = { kind: 'pdf', url: requester.view.webview.asWebviewUri(vscode.Uri.parse(tab.uri))
            .with({ query: `search=${Date.now()}` }).toString() };
        }
        requester.post({ type: 'search_source', request: message.request, source });
      } catch (error) {
        requester.post({ type: 'search_source', request: message.request,
          error: error instanceof Error ? error.message : 'Tab could not be searched' });
      }
    } else {
      if (!this.options.tabs(message.side).some(tab => tab.id === message.id)) return;
      await this.options.reveal(message.side, message.id);
      this.reveals.set(message.side, { type: 'search_reveal', id: message.id, location: message.location, query: message.query });
      this.ready(message.side);
    }
  }

  ready(side: sidebar_side): void {
    const message = this.reveals.get(side);
    const view = this.options.view(side);
    if (!message || !view.ready) return;
    this.reveals.delete(side);
    view.post(message);
  }

  private snapshot(side: sidebar_side, id: string): Promise<terminal_snapshot> {
    const view = this.options.view(side);
    // A sidebar that has never resolved has no live terminal output to search.
    if (!view.view) return view.history.get(id)
      ? Promise.reject(new Error('Open this sidebar again to search its retained output'))
      : Promise.resolve({ text: '', rows: [] });
    if (!view.ready) return Promise.reject(new Error('Sidebar is reloading; search again when it is ready'));
    if (this.pending.size >= 8) return Promise.reject(new Error('Search is busy; try again'));
    return new Promise((resolve, reject) => {
      const request = random_uuid();
      const timer = setTimeout(() => finish(), 5000);
      const finish = (snapshot?: terminal_snapshot) => {
        clearTimeout(timer);
        this.pending.delete(request);
        if (snapshot) resolve(snapshot); else reject(new Error('Terminal did not respond; search again'));
      };
      this.pending.set(request, { side, finish });
      view.post({ type: 'search_snapshot', request, id });
    });
  }

  dispose(): void { for (const pending of this.pending.values()) pending.finish(); }
}
