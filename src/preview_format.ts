import { is_markdown_uri } from './markdown_state';
import { is_pdf_uri } from './pdf_state';
import { document_format_for_uri, document_extensions, type document_format } from './document_state';

export type document_preview_kind = 'pdf' | 'markdown' | 'latex' | document_format;

export const markdown_extensions = ['md', 'markdown', 'mdown', 'mkd', 'mkdn', 'mdwn'] as const;
export const preview_extensions = ['pdf', ...markdown_extensions, 'tex', ...document_extensions] as const;

/** Routing and file pickers share the same supported formats. No content executes here. */
export function preview_kind(value: string): document_preview_kind | undefined {
  if (value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) return undefined;
  try {
    const uri = new URL(value);
    const pathname = decodeURIComponent(uri.pathname);
    if ((uri.protocol === 'file:' || uri.protocol === 'vscode-remote:')
      && !uri.username && !uri.password && !uri.search && !uri.hash
      && !/[\x00-\x1f\x7f]/.test(pathname) && /\.tex$/i.test(pathname)) return 'latex';
  } catch { /* Malformed or incompletely encoded paths cannot be previewed. */ }
  return is_pdf_uri(value) ? 'pdf' : is_markdown_uri(value) ? 'markdown' : document_format_for_uri(value);
}
