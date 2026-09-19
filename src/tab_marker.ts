import { is_codicon_name } from './codicons';
import { is_tab_color, type tab_color } from './tab_color';

/** A workspace-local Codicon, colored by a live theme token. */
export interface tab_marker {
  icon: string;
  color: tab_color;
}

export function is_tab_marker(value: unknown): value is tab_marker {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2
    && Object.hasOwn(record, 'icon') && Object.hasOwn(record, 'color')
    && is_codicon_name(record.icon)
    && is_tab_color(record.color);
}

export function copy_tab_marker(marker: tab_marker): tab_marker {
  return { icon: marker.icon, color: marker.color };
}
