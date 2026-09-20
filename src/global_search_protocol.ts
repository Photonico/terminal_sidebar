import type { sidebar_side } from './types';
import type { document_format } from './document_state';
export interface search_tab { side: sidebar_side; id: string; name: string; kind: 'terminal' | 'pdf' | 'markdown' | 'document' }
export interface terminal_snapshot { text: string; rows: Array<{ offset: number; row: number }> }
export interface search_location { page: number; start: number; end: number }
export type search_source =
  | { kind: 'terminal'; snapshot: terminal_snapshot }
  | { kind: 'markdown'; text: string }
  | { kind: 'document'; format: document_format; text: string }
  | { kind: 'pdf'; url: string };
export type search_request =
  | { type: 'search_catalog'; request: string }
  | { type: 'search_read'; request: string; side: sidebar_side; id: string }
  | { type: 'search_snapshot'; request: string; snapshot: terminal_snapshot }
  | { type: 'search_reveal'; side: sidebar_side; id: string; location: search_location; query: string };
export type search_response =
  | { type: 'search_catalog'; request: string; tabs: search_tab[] }
  | { type: 'search_source'; request: string; source?: search_source; error?: string }
  | { type: 'search_snapshot'; request: string; id: string }
  | { type: 'search_reveal'; id: string; location: search_location; query: string };

export function is_search_request(message: Record<string, unknown>, identifier: (value: unknown) => boolean): boolean {
  const target = identifier(message.id) && (message.side === 'left' || message.side === 'right');
  switch (message.type) {
    case 'search_catalog': return identifier(message.request);
    case 'search_read': return identifier(message.request) && target;
    case 'search_snapshot': {
      const snapshot = message.snapshot as terminal_snapshot | undefined;
      return identifier(message.request) && !!snapshot && typeof snapshot.text === 'string' && snapshot.text.length <= 4 * 1024 * 1024
        && Array.isArray(snapshot.rows) && snapshot.rows.length <= 11000
        && snapshot.rows.every(row => !!row && typeof row === 'object' && Number.isInteger(row.row) && row.row >= 0 && row.row <= 11000
          && Number.isInteger(row.offset) && row.offset >= 0 && row.offset <= snapshot.text.length);
    }
    case 'search_reveal': {
      const location = message.location as search_location | undefined;
      return target && typeof message.query === 'string' && message.query.length <= 4096 && !!location
        && [location.page, location.start, location.end].every(value => Number.isInteger(value) && value >= 0 && value <= 16_000_000)
        && location.end >= location.start;
    }
    default: return false;
  }
}
