/** Workspace-local marker colors refer to live terminal theme tokens, never fixed RGB values. */
export const tab_colors = [
  'ansiBlack', 'ansiRed', 'ansiGreen', 'ansiYellow', 'ansiBlue', 'ansiMagenta', 'ansiCyan', 'ansiWhite',
  'ansiBrightBlack', 'ansiBrightRed', 'ansiBrightGreen', 'ansiBrightYellow',
  'ansiBrightBlue', 'ansiBrightMagenta', 'ansiBrightCyan', 'ansiBrightWhite',
] as const;

export type tab_color = typeof tab_colors[number];

export function is_tab_color(value: unknown): value is tab_color {
  return tab_colors.some(color => color === value);
}
