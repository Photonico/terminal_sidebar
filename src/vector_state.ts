export const postscript_extensions = ['eps', 'ps'] as const;
export type postscript_format = typeof postscript_extensions[number];

/** The original vector file stays the tab identity; conversion output is disposable. */
export function postscript_format_for_uri(value: unknown): postscript_format | undefined {
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) return undefined;
  try {
    const uri = new URL(value);
    const pathname = decodeURIComponent(uri.pathname);
    if (!['file:', 'vscode-remote:'].includes(uri.protocol) || uri.username || uri.password
      || uri.search || uri.hash || /[\x00-\x1f\x7f]/.test(pathname)) return undefined;
    const extension = /\.([a-z]+)$/i.exec(pathname)?.[1].toLowerCase();
    return extension === 'eps' || extension === 'ps' ? extension : undefined;
  } catch { return undefined; }
}
