export type document_format = 'html' | 'css' | 'json' | 'jsonc';
export interface document_position { scroll: number }
export interface document_source { text: string; base_url: string }
export const document_extensions = ['html', 'htm', 'css', 'json', 'jsonc'] as const;

/** Document previews only read bounded text files on the connected extension host. */
export function document_format_for_uri(value: unknown): document_format | undefined {
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) return undefined;
  try {
    const uri = new URL(value);
    const pathname = decodeURIComponent(uri.pathname);
    if (!['file:', 'vscode-remote:'].includes(uri.protocol) || uri.username || uri.password
      || uri.search || uri.hash || /[\x00-\x1f\x7f]/.test(pathname)) return undefined;
    const extension = /\.([a-z]+)$/i.exec(pathname)?.[1].toLowerCase();
    return extension === 'html' || extension === 'htm' ? 'html'
      : extension === 'css' || extension === 'json' || extension === 'jsonc' ? extension : undefined;
  } catch { return undefined; }
}

export function is_document_uri(value: unknown): value is string {
  return document_format_for_uri(value) !== undefined;
}

export function is_document_position(value: unknown): value is document_position {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { scroll } = value as Record<string, unknown>;
  return typeof scroll === 'number' && Number.isFinite(scroll) && scroll >= 0 && scroll <= 100_000_000;
}
