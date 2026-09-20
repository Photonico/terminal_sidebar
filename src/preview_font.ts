import * as vscode from 'vscode';
import { valid_preview_font } from './preview_font_state';
export { valid_preview_font } from './preview_font_state';

const setting = 'markdownFontFamily';

export function read_preview_font(): string {
  const value: unknown = vscode.workspace.getConfiguration('terminalSidebar').get(setting, 'default');
  return valid_preview_font(value) && value.trim() ? value.trim() : 'default';
}

export function preview_font_family(): string {
  const value = read_preview_font();
  if (value === 'default') return '';
  if (value === 'editor') return vscode.workspace.getConfiguration('editor').get<string>('fontFamily', 'monospace');
  return value;
}

/** User scope lets VS Code Settings Sync carry the preference across repositories/devices. */
export async function set_preview_font(value: unknown): Promise<void> {
  if (!valid_preview_font(value) || !value.trim()) return;
  value = value.trim();
  await vscode.workspace.getConfiguration('terminalSidebar').update(setting, value === 'default' ? undefined : value, vscode.ConfigurationTarget.Global);
}
