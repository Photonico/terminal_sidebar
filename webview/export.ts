import type { Terminal } from '@xterm/xterm';
import type { SerializeAddon } from '@xterm/addon-serialize';

export const maximum_text_export = 1024 * 1024;
export const maximum_html_export = 8 * 1024 * 1024;

function escaped_html(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

function serialized_html(serializer: SerializeAddon): string {
  const markup = serializer.serializeAsHTML({ includeGlobalBackground: true });
  if (markup.length > maximum_html_export) {
    throw new Error('Terminal HTML exceeds the 8 MiB export limit. Reduce scrollback before exporting.');
  }
  return safe_terminal_html(markup);
}

export function terminal_text(terminal: Terminal): string {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index++) {
    const line = buffer.getLine(index);
    if (!line) {
      continue;
    }
    const text = line.translateToString(!buffer.getLine(index + 1)?.isWrapped);
    if (line.isWrapped && lines.length) {
      lines[lines.length - 1] += text;
    } else {
      lines.push(text);
    }
  }
  while (lines.length && !lines[lines.length - 1]) {
    lines.pop();
  }
  return lines.join('\n') + (lines.length ? '\n' : '');
}

/** Rebuild only the serializer's text/layout elements and benign style values.
 * No markup, links, resources, or event attributes from terminal output survives. */
export function safe_terminal_html(source: string): string {
  const parsed = new DOMParser().parseFromString(source, 'text/html');
  const allowed_tags = new Set(['DIV', 'SPAN', 'PRE', 'BR']);
  const allowed_styles = new Set(['color', 'background-color', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-decoration', 'text-decoration-line', 'text-decoration-color', 'opacity']);
  const clean = (node: Node): Node | undefined => {
    if (node.nodeType === Node.TEXT_NODE) {
      return document.createTextNode(node.textContent ?? '');
    }
    if (!(node instanceof HTMLElement) || ['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META'].includes(node.tagName)) {
      return;
    }
    const element = document.createElement(allowed_tags.has(node.tagName) ? node.tagName.toLowerCase() : 'span');
    for (const property of node.style) {
      const value = node.style.getPropertyValue(property);
      if (allowed_styles.has(property) && !/[<>\\]|url\s*\(|expression\s*\(|@import/i.test(value)) {
        element.style.setProperty(property, value);
      }
    }
    for (const child of node.childNodes) {
      const safe_child = clean(child);
      if (safe_child) {
        element.append(safe_child);
      }
    }
    return element;
  };
  const container = document.createElement('div');
  for (const child of parsed.body.childNodes) {
    const safe_child = clean(child);
    if (safe_child) {
      container.append(safe_child);
    }
  }
  return container.innerHTML;
}

export function terminal_html(serializer: SerializeAddon, name: string): string {
  const markup = serialized_html(serializer);
  const escaped_name = escaped_html(name);
  const timestamp = new Date().toISOString();
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${escaped_name} — Terminal export</title>
<style>body{margin:24px;font-family:system-ui,sans-serif}header{margin-bottom:20px}h1{font-size:20px;margin:0 0 8px}header p{font-size:12px;line-height:1.5;margin:4px 0}main{overflow-wrap:anywhere}pre{margin:0;white-space:pre-wrap}main>div{padding:12px;max-width:100%;box-sizing:border-box}@media print{body{margin:0}header .print_hint{display:none}main{print-color-adjust:exact;-webkit-print-color-adjust:exact}pre{white-space:pre-wrap}@page{margin:12mm}}</style>
</head><body><header><h1>${escaped_name}</h1><p>Exported ${timestamp} · Terminal Sidebar</p><p class="print_hint">To save a PDF, use your browser’s Print command and choose Save as PDF. Enable background graphics to keep terminal colours.</p></header><main>${markup}</main></body></html>`;
}

/** Markdown has no colour syntax. A raw HTML block preserves the serializer's
 * layout and colours in renderers that allow inline styles, without duplicating
 * the entire transcript in a second, plain-text block. */
export function terminal_markdown(serializer: SerializeAddon, name: string): string {
  const markup = serialized_html(serializer);
  // An HTML heading also prevents terminal names becoming Markdown links/images.
  return `<h1>${escaped_html(name)}</h1>\n\nExported ${new Date().toISOString()} · Terminal Sidebar\n\n` +
    '> Terminal colours use embedded HTML. Renderers that remove inline styles (including GitHub) may display plain colours.\n\n' +
    markup + '\n';
}
