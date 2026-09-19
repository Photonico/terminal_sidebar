/** Workspace-local marker colors refer to live theme tokens, never fixed RGB values. */
export const tab_colors = [
  'ansiBlack', 'ansiRed', 'ansiGreen', 'ansiYellow', 'ansiBlue', 'ansiMagenta', 'ansiCyan', 'ansiWhite',
  'tab_active_foreground',
  'ansiBrightBlack', 'ansiBrightRed', 'ansiBrightGreen', 'ansiBrightYellow',
  'ansiBrightBlue', 'ansiBrightMagenta', 'ansiBrightCyan', 'ansiBrightWhite',
  'tab_inactive_foreground',
] as const;

export type tab_color = typeof tab_colors[number];

export function is_tab_color(value: unknown): value is tab_color {
  return tab_colors.some(color => color === value);
}
