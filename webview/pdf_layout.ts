export interface page_size { width: number; height: number }
export interface page_box extends page_size { top: number; scale: number }
export const page_gap = 12;

/** Geometry is independent of canvas lifetime, so the scrollbar spans the whole PDF. */
export function layout_pages(sizes: readonly page_size[], width: number, height: number,
  zoom: number | 'page-width' | 'page-fit'): page_box[] {
  let top = 0;
  return sizes.map(size => {
    const scale = Math.max(0.1, typeof zoom === 'number' ? zoom : zoom === 'page-width'
      ? (width - 24) / size.width : Math.min((width - 24) / size.width, (height - 24) / size.height));
    const box = { top, width: size.width * scale, height: size.height * scale, scale };
    top += box.height + page_gap;
    return box;
  });
}

export function page_at(boxes: readonly page_box[], offset: number): number {
  let low = 0;
  let high = boxes.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (boxes[middle].top <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

export function visible_pages(boxes: readonly page_box[], top: number, height: number): number[] {
  if (!boxes.length) return [];
  const first = page_at(boxes, Math.max(0, top));
  const last = page_at(boxes, top + height);
  // At extreme zooms, keep the current viewport first and bound canvas allocations.
  return Array.from({ length: Math.min(6, last - first + 2, boxes.length - first) }, (_, index) => first + index);
}
