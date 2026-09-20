export type source_format = 'css' | 'json' | 'jsonc';
export interface document_format_request { text: string; format: source_format }
export interface document_format_result { text: string; error?: string; cancelled?: true }

export const max_format_input_bytes = 4 * 1024 * 1024;
export const max_format_output_characters = 16 * 1024 * 1024;

export function is_source_format(value: unknown): value is source_format {
  return value === 'css' || value === 'json' || value === 'jsonc';
}

export function is_format_input(text: unknown): text is string {
  return typeof text === 'string' && text.length <= max_format_input_bytes
    && new TextEncoder().encode(text).byteLength <= max_format_input_bytes;
}

export function is_format_result(value: unknown): value is document_format_result {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return typeof result.text === 'string' && result.text.length <= max_format_output_characters
    && (result.error === undefined || (typeof result.error === 'string' && result.error.length <= 512))
    && result.cancelled === undefined;
}
