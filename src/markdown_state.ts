/** Reading position is workspace-local; Markdown contents are read from disk. */
export interface markdown_position { scroll: number }

export interface markdown_source {
  text: string;
  /** A webview resource URI for the document's parent directory, ending in '/'. */
  base_url: string;
}

export const max_markdown_bytes = 4 * 1024 * 1024;

export function is_markdown_uri(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) return false;
  try {
    const uri = new URL(value);
    const pathname = decodeURIComponent(uri.pathname);
    return (uri.protocol === 'file:' || uri.protocol === 'vscode-remote:')
      && !uri.username && !uri.password && !uri.search && !uri.hash
      && !/[\x00-\x1f\x7f]/.test(pathname) && /\.(md|markdown|mdown|mkdn?|mdwn)$/i.test(pathname);
  } catch { return false; }
}

export function is_markdown_position(value: unknown): value is markdown_position {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { scroll } = value as Record<string, unknown>;
  return typeof scroll === 'number' && Number.isFinite(scroll) && scroll >= 0 && scroll <= 100_000_000;
}

/** Only the host opens links; Markdown can never request a command URI. */
export function is_markdown_link(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 8192
    || /[\x00-\x20\x7f\\]/.test(value) || value.startsWith('//')) return false;
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(value)?.[1]?.toLowerCase();
  return !scheme || ['http', 'https', 'mailto', 'file', 'vscode-remote'].includes(scheme);
}
