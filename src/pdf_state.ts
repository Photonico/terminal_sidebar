/** PDF paths and reading positions belong to this workspace, never shell profiles. */
export type pdf_zoom = 'page-width' | 'page-fit' | number;

export interface pdf_position {
  page: number;
  zoom: pdf_zoom;
}

export function is_pdf_uri(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) return false;
  try {
    const uri = new URL(value);
    const pathname = decodeURIComponent(uri.pathname);
    return (uri.protocol === 'file:' || uri.protocol === 'vscode-remote:')
      && !uri.username && !uri.password && !uri.search && !uri.hash
      && !/[\x00-\x1f\x7f]/.test(pathname) && /\.pdf$/i.test(pathname);
  } catch { return false; }
}

/** A PDF may remember its TeX root only on the same local or remote filesystem. */
export function is_pdf_source_uri(value: unknown, pdf_uri: string): value is string {
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value) || !is_pdf_uri(pdf_uri)) return false;
  try {
    const source = new URL(value);
    const pdf = new URL(pdf_uri);
    const pathname = decodeURIComponent(source.pathname);
    return source.protocol === pdf.protocol && source.host === pdf.host
      && !source.username && !source.password && !source.search && !source.hash
      && !/[\x00-\x1f\x7f]/.test(pathname) && /\.tex$/i.test(pathname);
  } catch { return false; }
}

export function is_pdf_position(value: unknown): value is pdf_position {
  if (!value || typeof value !== 'object') return false;
  const { page, zoom } = value as Record<string, unknown>;
  return Number.isInteger(page) && Number(page) >= 1 && Number(page) <= 1_000_000
    && (zoom === 'page-width' || zoom === 'page-fit'
      || (typeof zoom === 'number' && Number.isFinite(zoom) && zoom >= 0.25 && zoom <= 4));
}
