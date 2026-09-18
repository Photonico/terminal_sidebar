import { PDFDocument, PageSizes } from 'pdf-lib';
import type { IBufferCell, ITheme, Terminal } from '@xterm/xterm';

export const maximum_pdf_export = 16 * 1024 * 1024;
const maximum_cells = 1_000_000;
const maximum_styles = 16_384;
const maximum_pages = 100;
const maximum_canvas_dimension = 4096;
const maximum_canvas_pixels = 4_000_000;

const ansi_names = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const;
// xterm's default palette, used only when the current theme omits a colour.
const default_ansi = ['#2e3436', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf', '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec'];

function rgb_colour(value: number): string {
  return `#${(value & 0xffffff).toString(16).padStart(6, '0')}`;
}

/** Resolve public buffer colour indices without depending on xterm internals. */
export function palette_colour(index: number, theme: ITheme): string {
  if (index < 16) {
    return theme[ansi_names[index]!] || default_ansi[index]!;
  }
  const extended = theme.extendedAnsi?.[index - 16];
  if (extended) {
    return extended;
  }
  if (index >= 232) {
    const channel = 8 + (index - 232) * 10;
    return rgb_colour((channel << 16) | (channel << 8) | channel);
  }
  const cube = [0, 95, 135, 175, 215, 255];
  const offset = index - 16;
  return rgb_colour((cube[Math.floor(offset / 36)]! << 16) | (cube[Math.floor(offset / 6) % 6]! << 8) | cube[offset % 6]!);
}

interface cell_style {
  foreground: string;
  background: string;
  bold: boolean;
  italic: boolean;
  dim: boolean;
  hidden: boolean;
  underline: boolean;
  strike: boolean;
  overline: boolean;
}

export function pdf_cell_style(cell: IBufferCell, theme: ITheme, bright_bold = true): cell_style {
  const colour = (foreground: boolean): string => {
    const index = foreground ? cell.getFgColor() : cell.getBgColor();
    if (foreground ? cell.isFgRGB() : cell.isBgRGB()) {
      return rgb_colour(index);
    }
    if (foreground ? cell.isFgPalette() : cell.isBgPalette()) {
      return palette_colour(foreground && bright_bold && cell.isBold() && index < 8 ? index + 8 : index, theme);
    }
    return foreground ? theme.foreground || '#ffffff' : theme.background || '#000000';
  };
  const foreground = colour(true);
  const background = colour(false);
  return {
    foreground: cell.isInverse() ? background : foreground,
    background: cell.isInverse() ? foreground : background,
    bold: !!cell.isBold(), italic: !!cell.isItalic(), dim: !!cell.isDim(), hidden: !!cell.isInvisible(),
    underline: !!cell.isUnderline(), strike: !!cell.isStrikethrough(), overline: !!cell.isOverline(),
  };
}

interface snapshot_cell { column: number; text: string; width: number; style: number }
interface terminal_snapshot { columns: number; rows: snapshot_cell[][]; styles: cell_style[] }

/** Take one coherent snapshot before yielding; subsequent terminal output must
 * not make rows shift or disappear halfway through an export. */
export function snapshot_terminal(terminal: Terminal, theme: ITheme): terminal_snapshot {
  const buffer = terminal.buffer.active;
  const columns = terminal.cols;
  if (!Number.isInteger(columns) || columns < 1 || columns > 1000 || buffer.length * columns > maximum_cells) {
    throw new Error('Terminal PDF exceeds the one-million-cell limit. Reduce scrollback or use HTML.');
  }
  const styles: cell_style[] = [];
  const style_ids = new Map<string, number>();
  const rows: snapshot_cell[][] = [];
  let characters = 0;
  for (let index = 0; index < buffer.length; index++) {
    const row: snapshot_cell[] = [];
    const line = buffer.getLine(index);
    for (let column = 0; column < columns; column++) {
      const cell = line?.getCell(column);
      if (!cell || !cell.getWidth()) {
        continue;
      }
      const text = cell.getChars();
      // Omit unpainted blank cells. Their position remains implicit in column.
      if (!text && cell.isAttributeDefault()) {
        continue;
      }
      characters += text.length;
      if (characters > maximum_cells * 2) {
        throw new Error('Terminal PDF contains too much text. Reduce scrollback or use HTML.');
      }
      const style = pdf_cell_style(cell, theme, terminal.options.drawBoldTextInBrightColors !== false);
      const key = JSON.stringify(style);
      let style_id = style_ids.get(key);
      if (style_id === undefined) {
        if (styles.length >= maximum_styles) {
          throw new Error('Terminal PDF contains too many distinct colours or styles. Reduce scrollback or use HTML.');
        }
        style_id = styles.length;
        styles.push(style);
        style_ids.set(key, style_id);
      }
      row.push({ column, text, width: cell.getWidth(), style: style_id });
    }
    rows.push(row);
  }
  while (rows.length > 1 && rows[rows.length - 1]!.length === 0) {
    rows.pop();
  }
  return { columns, rows, styles };
}

export function pdf_page_layout(columns: number, rows: number, cell_width: number, line_height: number): {
  page_width: number; page_height: number; scale: number; rows_per_page: number; pages: number;
} {
  if (![columns, rows, cell_width, line_height].every(Number.isFinite) || columns < 1 || rows < 0 || cell_width <= 0 || line_height <= 0) {
    throw new Error('Invalid terminal dimensions for PDF export.');
  }
  const [portrait_width, portrait_height] = PageSizes.A4;
  const landscape = columns * cell_width * 0.75 > portrait_width - 72;
  const [page_width, page_height] = landscape ? [portrait_height, portrait_width] : [portrait_width, portrait_height];
  const scale = Math.min(0.75, (page_width - 72) / (columns * cell_width));
  const rows_per_page = Math.max(1, Math.floor((page_height - 88) / (line_height * scale)));
  const pages = Math.max(1, Math.ceil(rows / rows_per_page));
  if (pages > maximum_pages) {
    throw new Error('Terminal PDF exceeds the 100-page limit. Reduce scrollback or use HTML.');
  }
  return { page_width, page_height, scale, rows_per_page, pages };
}

function canvas_png(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => {
    if (!blob) {
      reject(new Error('Unable to render a terminal PDF page.'));
    } else {
      void blob.arrayBuffer().then(buffer => resolve(new Uint8Array(buffer)), reject);
    }
  }, 'image/png'));
}

/** Export a real PDF using browser-rendered glyphs, retaining the user's fonts,
 * ANSI colours and Unicode. Pages are raster images, so text is not selectable.
 * Only one bounded canvas/decoded PNG is held at a time. */
export async function terminal_pdf(terminal: Terminal, name: string): Promise<string> {
  const options = { ...terminal.options };
  const theme = { ...options.theme, extendedAnsi: options.theme?.extendedAnsi?.slice() };
  const snapshot = snapshot_terminal(terminal, theme);
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) {
    throw new Error('Canvas rendering is unavailable for PDF export. Use HTML instead.');
  }
  try {
    const font_size = Math.max(6, Math.min(64, options.fontSize ?? 15));
    const font_family = options.fontFamily || 'monospace';
    const normal_weight = options.fontWeight || 'normal';
    const bold_weight = options.fontWeightBold || 'bold';
    context.font = `${normal_weight} ${font_size}px ${font_family}`;
    // Wait for the same local/webview fonts xterm uses; no external resources.
    await document.fonts?.load(context.font);
    const metrics = context.measureText('M');
    const cell_width = Math.max(1, metrics.width + (options.letterSpacing ?? 0));
    const line_height = Math.max(font_size * 1.2, font_size * (options.lineHeight ?? 1));
    const text_height = metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent;
    const baseline = Math.max(font_size * 0.8, (line_height - text_height) / 2 + metrics.actualBoundingBoxAscent);
    const layout = pdf_page_layout(snapshot.columns, snapshot.rows.length, cell_width, line_height);
    const width = snapshot.columns * cell_width;
    const document_pdf = await PDFDocument.create();
    document_pdf.setTitle(name);
    document_pdf.setCreator('Terminal Sidebar');
    document_pdf.setSubject('Terminal transcript. Raster pages preserve colours and Unicode; text is not selectable.');
    let image_bytes = 0;
    for (let page_index = 0; page_index < layout.pages; page_index++) {
      const first_row = page_index * layout.rows_per_page;
      const page_rows = snapshot.rows.slice(first_row, first_row + layout.rows_per_page);
      const height = Math.max(1, page_rows.length) * line_height;
      const ratio = Math.min(2, maximum_canvas_dimension / width, maximum_canvas_dimension / height, Math.sqrt(maximum_canvas_pixels / (width * height)));
      canvas.width = Math.max(1, Math.ceil(width * ratio));
      canvas.height = Math.max(1, Math.ceil(height * ratio));
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.fillStyle = theme.background || '#000000';
      context.fillRect(0, 0, width, height);
      for (let row_index = 0; row_index < page_rows.length; row_index++) {
        const row = page_rows[row_index]!;
        const top = row_index * line_height;
        // Paint all backgrounds first, so adjacent cells cannot erase italic
        // overhangs or wide glyphs from an earlier text draw.
        for (const cell of row) {
          context.fillStyle = snapshot.styles[cell.style]!.background;
          context.fillRect(cell.column * cell_width, top, cell.width * cell_width, line_height);
        }
        for (const cell of row) {
          const style = snapshot.styles[cell.style]!;
          if (style.hidden) {
            continue;
          }
          context.font = `${style.italic ? 'italic ' : ''}${style.bold ? bold_weight : normal_weight} ${font_size}px ${font_family}`;
          context.fillStyle = style.foreground;
          context.globalAlpha = style.dim ? 0.5 : 1;
          const left = cell.column * cell_width;
          context.fillText(cell.text, left, top + baseline);
          const stroke = Math.max(1, font_size / 14);
          if (style.underline) {
            context.fillRect(left, top + Math.min(line_height - stroke, baseline + stroke), cell.width * cell_width, stroke);
          }
          if (style.strike) {
            context.fillRect(left, top + baseline - font_size * 0.3, cell.width * cell_width, stroke);
          }
          if (style.overline) {
            context.fillRect(left, top + stroke, cell.width * cell_width, stroke);
          }
          context.globalAlpha = 1;
        }
      }
      const png = await canvas_png(canvas);
      image_bytes += png.byteLength;
      if (image_bytes > maximum_pdf_export) {
        throw new Error('Terminal PDF exceeds the 16 MiB export limit. Reduce scrollback or use HTML.');
      }
      const image = await document_pdf.embedPng(png);
      const page = document_pdf.addPage([layout.page_width, layout.page_height]);
      page.drawImage(image, { x: 36, y: layout.page_height - 36 - height * layout.scale, width: width * layout.scale, height: height * layout.scale });
      page.drawText(`${page_index + 1} / ${layout.pages}`, { x: 36, y: 20, size: 9 });
      // PDFImage.embed() releases the decoded PNG after compressing its stream.
      await image.embed();
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    const pdf_bytes = await document_pdf.save();
    if (pdf_bytes.byteLength > maximum_pdf_export) {
      throw new Error('Terminal PDF exceeds the 16 MiB export limit. Reduce scrollback or use HTML.');
    }
    let binary = '';
    for (let index = 0; index < pdf_bytes.length; index += 8192) {
      binary += String.fromCharCode(...pdf_bytes.subarray(index, index + 8192));
    }
    return btoa(binary);
  } finally {
    // Release the backing store even if a page, size check or font load fails.
    canvas.width = canvas.height = 0;
  }
}
