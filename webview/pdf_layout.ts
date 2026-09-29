import type { pdf_mode, pdf_zoom } from '../src/pdf_state';

export interface page_size { width: number; height: number }
export interface page_box extends page_size { top: number; scale: number; left?: number }
export type scroll_axis = 'vertical' | 'horizontal';
export const page_gap = 12;

/** Geometry is independent of canvas lifetime, so the scrollbar spans the whole PDF. */
export function layout_pages(sizes: readonly page_size[], width: number, height: number,
  zoom: number | 'page-width' | 'page-fit', axis: scroll_axis = 'vertical'): page_box[] {
  let offset = 0;
  return sizes.map(size => {
    const scale = Math.max(0.1, typeof zoom === 'number' ? zoom : zoom === 'page-width'
      ? (width - 24) / size.width : Math.min((width - 24) / size.width, (height - 24) / size.height));
    const box = { top: axis === 'vertical' ? offset : 0,
      ...(axis === 'horizontal' ? { left: offset } : {}),
      width: size.width * scale, height: size.height * scale, scale };
    offset += (axis === 'vertical' ? box.height : box.width) + page_gap;
    return box;
  });
}

function page_start(box: page_box, axis: scroll_axis): number {
  return axis === 'horizontal' ? box.left ?? 0 : box.top;
}

function page_length(box: page_box, axis: scroll_axis): number {
  return axis === 'horizontal' ? box.width : box.height;
}

export function page_at(boxes: readonly page_box[], offset: number, axis: scroll_axis = 'vertical'): number {
  let low = 0;
  let high = boxes.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (page_start(boxes[middle], axis) <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

export function visible_pages(boxes: readonly page_box[], offset: number, length: number,
  axis: scroll_axis = 'vertical'): number[] {
  if (!boxes.length) return [];
  const first = page_at(boxes, Math.max(0, offset), axis);
  const last = page_at(boxes, offset + length, axis);
  // Always cover every visible page; only one extra page is prefetched.
  return Array.from({ length: Math.min(last - first + 2, boxes.length - first) }, (_, index) => first + index);
}

/** The toolbar follows the page with the largest visible portion. */
export function current_page(boxes: readonly page_box[], offset: number, length: number,
  axis: scroll_axis = 'vertical'): number {
  let selected = page_at(boxes, offset, axis);
  let largest = -1;
  for (let index = selected; index < boxes.length && page_start(boxes[index], axis) < offset + length; index++) {
    const box = boxes[index];
    const start = page_start(box, axis);
    const visible = Math.min(start + page_length(box, axis), offset + length) - Math.max(start, offset);
    if (visible > largest) { selected = index; largest = visible; }
  }
  return selected;
}

export interface document_layout {
  boxes: Map<number, page_box>;
  width: number;
  height: number;
  axis: scroll_axis;
  continuous?: readonly page_box[];
}

/** Paged layouts keep only the selected page or pair in the geometry map. */
export function page_group(page: number, count: number, mode: pdf_mode): number[] {
  if (count < 1) return [];
  const index = Math.max(0, Math.min(count - 1, Math.trunc(page) - 1));
  const first = mode === 'spread' ? index - index % 2 : index;
  return mode === 'spread' && first + 1 < count ? [first, first + 1] : [first];
}

export function adjacent_page(page: number, count: number, mode: pdf_mode, direction: -1 | 1): number {
  const first = page_group(page, count, mode)[0] ?? 0;
  const target = first + 1 + direction * (mode === 'spread' ? 2 : 1);
  return target >= 1 && target <= count ? target : Math.max(1, Math.min(count, Math.trunc(page)));
}

export function layout_document(sizes: readonly page_size[], width: number, height: number,
  zoom: pdf_zoom, mode: pdf_mode, page: number): document_layout {
  if (mode === 'continuous' || mode === 'horizontal') {
    const axis = mode === 'horizontal' ? 'horizontal' : 'vertical';
    const pages = layout_pages(sizes, width, height, zoom, axis);
    const last = pages.at(-1);
    const row_width = last ? (last.left ?? 0) + last.width : 0;
    const content_width = Math.max(0, width - 24, axis === 'horizontal' ? row_width
      : pages.reduce((maximum, box) => Math.max(maximum, box.width), 0));
    const content_height = axis === 'horizontal'
      ? pages.reduce((maximum, box) => Math.max(maximum, box.height), 0)
      : last ? last.top + last.height : 0;
    const continuous = pages.map(box => ({ ...box, left: axis === 'horizontal'
      ? (box.left ?? 0) + (content_width - row_width) / 2 : (content_width - box.width) / 2 }));
    return { boxes: new Map(continuous.map((box, index) => [index, box])),
      width: content_width, height: content_height, axis, continuous };
  }
  const indices = page_group(page, sizes.length, mode);
  const gap = indices.length > 1 ? page_gap : 0;
  const base_width = indices.reduce((sum, index) => sum + sizes[index].width, 0);
  const base_height = indices.reduce((maximum, index) => Math.max(maximum, sizes[index].height), 1);
  const scale = Math.max(0.1, typeof zoom === 'number' ? zoom : Math.min((width - 24 - gap) / Math.max(1, base_width),
    zoom === 'page-fit' ? (height - 24) / base_height : Infinity));
  const content_width = Math.max(0, width - 24, base_width * scale + gap);
  let left = (content_width - base_width * scale - gap) / 2;
  const boxes = new Map<number, page_box>();
  for (const index of indices) {
    const size = sizes[index];
    boxes.set(index, { left, top: 0, width: size.width * scale, height: size.height * scale, scale });
    left += size.width * scale + page_gap;
  }
  return { boxes, width: content_width, height: base_height * scale, axis: 'vertical' };
}
