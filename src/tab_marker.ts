import { is_tab_color, type tab_color } from './tab_color';

/** Backward reader for saved marker preferences; new data stores only the tab name color. */
const tab_marker_shapes = [
  'circle', 'triangle', 'triangle_right', 'triangle_down', 'triangle_left',
  'diamond', 'square',
] as const;
interface tab_marker {
  shape: typeof tab_marker_shapes[number];
  color: tab_color;
}

export function is_tab_marker(value: unknown): value is tab_marker {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2
    && Object.hasOwn(record, 'shape') && Object.hasOwn(record, 'color')
    && tab_marker_shapes.some(shape => shape === record.shape)
    && is_tab_color(record.color);
}
