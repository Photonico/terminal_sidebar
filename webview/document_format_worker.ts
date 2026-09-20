import { format as prettier_format } from 'prettier/standalone';
import * as postcss from 'prettier/plugins/postcss';
import { applyEdits, format as json_format, visit } from 'jsonc-parser';
import { is_format_input, is_source_format, max_format_output_characters,
  type document_format_request, type document_format_result } from './document_format_protocol';

function format_json(text: string, comments: boolean): string {
  let depth = 0;
  const begin = () => { if (++depth > 256) throw new Error('JSON nesting limit'); };
  visit(text, {
    onObjectBegin: begin,
    onArrayBegin: begin,
    onObjectEnd: () => { depth--; },
    onArrayEnd: () => { depth--; },
    onError: () => { throw new Error('Invalid JSON syntax'); },
  }, { disallowComments: !comments, allowTrailingComma: comments, allowEmptyContent: false });
  // Only whitespace edits: comments, duplicate keys, large numbers and escape forms survive.
  return applyEdits(text, json_format(text, undefined, {
    insertSpaces: true, tabSize: 2, eol: '\n', insertFinalNewline: true, keepLines: false,
  }));
}

/** Executed only by a terminable worker; neither parser loads project configuration. */
export async function format_document(request: document_format_request): Promise<document_format_result> {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return { text: '', error: 'Invalid formatting request.' };
  }
  const { text, format } = request;
  if (!is_format_input(text) || !is_source_format(format)) {
    return { text: typeof text === 'string' ? text : '', error: 'Source preview is limited to 4 MiB.' };
  }
  try {
    const formatted = format === 'css'
      ? await prettier_format(text, { parser: 'css', plugins: [postcss], printWidth: 80, tabWidth: 2, endOfLine: 'lf' })
      : format_json(text, format === 'jsonc');
    if (formatted.length > max_format_output_characters) {
      return { text, error: 'Formatted output is too large. Showing the original source.' };
    }
    return { text: formatted };
  } catch {
    return { text, error: `This ${format.toUpperCase()} could not be formatted. Showing the original source.` };
  }
}

// The pure formatter is importable by tests; normal webviews never parse source on the UI thread.
if (typeof self !== 'undefined' && typeof document === 'undefined') {
  self.onmessage = (event: MessageEvent<document_format_request>) => {
    void format_document(event.data).then(result => self.postMessage(result));
  };
}
