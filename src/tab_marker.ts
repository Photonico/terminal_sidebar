/** Workspace-local tab decoration. These values name VS Code theme tokens, not colours. */
export const tab_marker_shapes = [
  'circle', 'triangle', 'triangle_right', 'triangle_down', 'triangle_left',
  'diamond', 'square',
] as const;
export type tab_marker_shape = typeof tab_marker_shapes[number];
export const tab_marker_colors = [
  'ansiBlack', 'ansiRed', 'ansiGreen', 'ansiYellow', 'ansiBlue', 'ansiMagenta', 'ansiCyan', 'ansiWhite',
  'ansiBrightBlack', 'ansiBrightRed', 'ansiBrightGreen', 'ansiBrightYellow',
  'ansiBrightBlue', 'ansiBrightMagenta', 'ansiBrightCyan', 'ansiBrightWhite',
] as const;

export type tab_marker_color = typeof tab_marker_colors[number];

export interface tab_marker {
  shape: tab_marker_shape;
  color: tab_marker_color;
}

export function is_tab_marker(value: unknown): value is tab_marker {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2
    && Object.hasOwn(record, 'shape') && Object.hasOwn(record, 'color')
    && tab_marker_shapes.some(shape => shape === record.shape)
    && tab_marker_colors.some(color => color === record.color);
}

/** Enumerate fields so even an externally supplied value cannot carry unrelated state. */
export function copy_tab_marker(value: tab_marker): tab_marker {
  return { shape: value.shape, color: value.color };
}
