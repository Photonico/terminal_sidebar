export interface document_search_request {
  text: string;
  query: string;
  case_sensitive: boolean;
  whole_word: boolean;
  regex: boolean;
  limit: number;
}

export interface document_search_hit { start: number; end: number }
export interface document_search_result { matches: document_search_hit[]; truncated?: boolean; message?: string }

/** Runs only in a terminable worker: user regexes must never execute on the UI thread. */
export function find_document_matches(request: document_search_request): document_search_result {
  const matches: document_search_hit[] = [];
  const query = request.regex ? request.query : request.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let expression: RegExp;
  try { expression = new RegExp(query, request.case_sensitive ? 'gu' : 'giu'); }
  catch { return { matches, message: 'Invalid regular expression' }; }
  const word = /[\p{L}\p{N}\p{M}_]/u;
  for (;;) {
    const match = expression.exec(request.text);
    if (!match) return { matches };
    if (!match[0].length) {
      const point = request.text.codePointAt(expression.lastIndex);
      expression.lastIndex += point !== undefined && point > 0xffff ? 2 : 1;
      continue;
    }
    const start = match.index;
    const end = start + match[0].length;
    if (request.whole_word) {
      const previous = Array.from(request.text.slice(Math.max(0, start - 2), start)).at(-1) ?? '';
      const following = String.fromCodePoint(request.text.codePointAt(end) ?? 0);
      if (word.test(previous) || word.test(following)) continue;
    }
    matches.push({ start, end });
    if (matches.length >= request.limit) return { matches, truncated: true };
  }
}

// Keep the pure matcher importable by tests; only workers have this global shape.
if (typeof self !== 'undefined' && typeof document === 'undefined') {
  self.onmessage = (event: MessageEvent<document_search_request>) => {
    self.postMessage(find_document_matches(event.data));
  };
}
