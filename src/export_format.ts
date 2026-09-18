import type { export_format } from './types';

export const maximum_text_export = 1024 * 1024;
export const maximum_html_export = 8 * 1024 * 1024;
export const maximum_pdf_bytes = 16 * 1024 * 1024;
export const maximum_pdf_base64 = Math.ceil(maximum_pdf_bytes / 3) * 4;

/** Validate the webview payload before a save dialog or binary allocation. */
export function is_export_payload(format: unknown, text: unknown): boolean {
  if (typeof text !== 'string') return false;
  if (format === undefined || format === 'text') return text.length <= maximum_text_export;
  if (format === 'html' || format === 'markdown') return text.length <= maximum_html_export;
  return format === 'pdf' && text.length >= 16 && text.length <= maximum_pdf_base64
    && text.startsWith('JVBERi0') && text.length % 4 === 0
    && /^[A-Za-z0-9+/]*={0,2}$/.test(text);
}

export const export_extensions: Record<export_format, string> = {
  html: 'html', pdf: 'pdf', markdown: 'md', text: 'txt',
};
