import type * as vscode from 'vscode';
import { read_text_document, text_document_watch } from './text_document_watch';

/** Markdown and source previews share bounded UTF-8 reads and atomic-save watching. */
export function read_markdown(file_path: string): Promise<string> {
  return read_text_document(file_path, 'Markdown');
}

export class markdown_watch extends text_document_watch {
  constructor(uri: vscode.Uri, changed: (text: string) => void, unavailable: (message: string) => void) {
    super(uri, changed, unavailable, 'Markdown');
  }
}
