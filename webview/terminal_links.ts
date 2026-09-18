import { WebLinksAddon } from '@xterm/addon-web-links';
import type { IBufferCellPosition, IDisposable, Terminal } from '@xterm/xterm';

export interface file_link {
  path: string;
  line: number;
  column?: number;
  start: number;
  end: number;
}

/** Quoted paths may contain spaces; unquoted rooted paths need a line suffix
 * before spaces can be distinguished from surrounding prose. */
export function find_file_links(text: string): file_link[] {
  if (text.length > 8192) {
    return [];
  }
  const found: file_link[] = [];
  const expressions = [
    /["']([^"'\r\n]+?)(?::(\d+)(?::(\d+))?)?["'](?::(\d+)(?::(\d+))?)?/g,
    /(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|~\/|\/)[^\r\n<>"'|:*?]+?:\d+(?::\d+)?/g,
    /(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|~\/|\/)?[^\s<>"'|:*?()[\]{}]+(?:[\\/][^\s<>"'|:*?()[\]{}]+)*(?::\d+(?::\d+)?)?/g,
  ];
  for (const [expression_index, expression] of expressions.entries()) {
    for (const match of text.matchAll(expression)) {
      const start = match.index!;
      const end = start + match[0].length;
      if (found.some(link => start < link.end && end > link.start)) {
        continue;
      }
      // Do not reinterpret a URL's slashes or a path suffix as another file.
      if (start > 0 && /[\w/:\\]/.test(text[start - 1]!) || /[\x00-\x1f\x7f]/.test(match[0])) {
        continue;
      }
      let path: string;
      let line: number;
      let column: number | undefined;
      if (expression_index === 0) {
        path = match[1]!;
        line = Number(match[4] ?? match[2] ?? 1);
        column = match[5] || match[3] ? Number(match[5] ?? match[3]) : undefined;
      } else {
        const location = /^(.*?):(\d+)(?::(\d+))?$/.exec(match[0]);
        path = location?.[1] ?? match[0];
        line = Number(location?.[2] ?? 1);
        column = location?.[3] ? Number(location[3]) : undefined;
        if (!location && !/[\\/]/.test(path)) {
          continue;
        }
      }
      if (!path || path.length > 4096 || /^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(path)
          || (!/[\\/]/.test(path) && !/\.[A-Za-z\d_-]+$/.test(path))
          || !Number.isSafeInteger(line) || line < 1 || line > 1_000_000
          || (column !== undefined && (!Number.isSafeInteger(column) || column < 1 || column > 1_000_000))) {
        continue;
      }
      found.push({ path, line, ...(column === undefined ? {} : { column }), start, end });
    }
  }
  return found.sort((left, right) => left.start - right.start);
}

export function link_modifier(event: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>, is_mac: boolean): boolean {
  return !event.altKey && !event.shiftKey && (is_mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
}

/** Map UTF-16 string offsets back to buffer cells, including wide and combined glyphs. */
export function read_link_line(terminal: Terminal, requested_line: number): { text: string; starts: IBufferCellPosition[]; ends: IBufferCellPosition[] } | undefined {
  const buffer = terminal.buffer.active;
  let first = requested_line - 1;
  let last = first;
  if (!buffer.getLine(first)) {
    return;
  }
  while (first > 0 && buffer.getLine(first)?.isWrapped) {
    first--;
    if (last - first > 100) {
      return;
    }
  }
  while (buffer.getLine(last + 1)?.isWrapped) {
    last++;
    if (last - first > 100) {
      return;
    }
  }
  let text = '';
  const starts: IBufferCellPosition[] = [];
  const ends: IBufferCellPosition[] = [];
  for (let row = first; row <= last; row++) {
    const line = buffer.getLine(row)!;
    for (let col = 0; col < line.length; col++) {
      const cell = line.getCell(col);
      if (!cell || cell.getWidth() === 0) {
        continue;
      }
      const chars = cell.getChars() || ' ';
      for (let index = 0; index < chars.length; index++) {
        starts.push({ x: col + 1, y: row + 1 });
        ends.push({ x: col + cell.getWidth(), y: row + 1 });
      }
      text += chars;
      if (text.length > 8192) {
        return;
      }
    }
  }
  return { text, starts, ends };
}

export function install_terminal_links(terminal: Terminal, is_mac: boolean, open_link: (uri: string) => void, open_file: (link: file_link) => void): IDisposable {
  const hover = (): void => {
    if (terminal.element) {
      terminal.element.title = `${is_mac ? 'Cmd' : 'Ctrl'}+click to open link`;
    }
  };
  const leave = (): void => terminal.element?.removeAttribute('title');
  const activate_url = (event: MouseEvent, uri: string): void => {
    event.preventDefault();
    if (link_modifier(event, is_mac) && /^https?:\/\//i.test(uri)) {
      open_link(uri);
    }
  };
  // OSC 8 links follow the same activation and scheme rules as detected URLs.
  terminal.options.linkHandler = { activate: activate_url, hover, leave, allowNonHttpProtocols: false };
  terminal.loadAddon(new WebLinksAddon(activate_url, { hover, leave }));
  return terminal.registerLinkProvider({
    provideLinks(requested_line, callback) {
      const logical_line = read_link_line(terminal, requested_line);
      callback(logical_line ? find_file_links(logical_line.text).flatMap(link => {
        const start = logical_line.starts[link.start];
        const end = logical_line.ends[link.end - 1];
        if (!start || !end || start.y > requested_line || end.y < requested_line) {
          return [];
        }
        return [{
          text: logical_line.text.slice(link.start, link.end),
          range: { start, end },
          hover,
          leave,
          activate(event: MouseEvent) {
            event.preventDefault();
            if (link_modifier(event, is_mac)) {
              open_file(link);
            }
          },
        }];
      }) : undefined);
    },
  });
}
