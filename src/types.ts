import type { tab_marker } from './tab_marker';
import type { pdf_position } from './pdf_state';
import type { markdown_position } from './markdown_state';

/** Persistent startup settings. Runtime tabs are a separate, workspace-local object. */
export interface terminal_profile {
  id: string;
  name: string;
  command: string;
  shell: string;
  args?: string[];
  env?: Record<string, string | null>;
}

export type sidebar_side = 'left' | 'right';

export interface sidebar_configuration {
  left: terminal_profile[];
  right: terminal_profile[];
}

/** A running or stopped tab; profile_id identifies its optional startup source. */
export interface terminal_tab extends terminal_profile {
  kind?: 'terminal';
  profile_id?: string;
  /** Last reported local directory; workspace memory only, never synced settings. */
  cwd?: string;
  marker?: tab_marker;
}

export interface pdf_tab extends pdf_position {
  kind: 'pdf';
  id: string;
  name: string;
  uri: string;
  /** Optional associated TeX root, used to resolve relative SyncTeX source paths. */
  source_uri?: string;
  marker?: tab_marker;
}

export interface markdown_tab extends markdown_position {
  kind: 'markdown';
  id: string;
  name: string;
  uri: string;
  marker?: tab_marker;
}

export type sidebar_tab = terminal_tab | pdf_tab | markdown_tab;

export function is_pdf_tab(tab: sidebar_tab): tab is pdf_tab {
  return tab.kind === 'pdf';
}

export function is_markdown_tab(tab: sidebar_tab): tab is markdown_tab {
  return tab.kind === 'markdown';
}

export function is_terminal_tab(tab: sidebar_tab): tab is terminal_tab {
  return tab.kind === undefined || tab.kind === 'terminal';
}

export type session_status = 'idle' | 'running' | 'exited' | 'error';
export type command_status = 'running' | 'completed' | 'error';
export type export_format = 'html' | 'pdf' | 'markdown' | 'text';

export interface session_info {
  id: string;
  status: session_status;
  exit_code?: number;
  message?: string;
  command_status?: command_status;
  command_exit_code?: number;
  /** Per-process command identity; runtime only, never persisted. */
  command_revision?: number;
}

export interface appearance {
  font_family: string;
  font_size: number;
  cursor_blink: boolean;
  scrollback: number;
  editor_scrollbar_vertical: 'auto' | 'visible' | 'hidden';
  editor_scrollbar_horizontal: 'auto' | 'visible' | 'hidden';
  editor_scrollbar_vertical_size: number;
  editor_scrollbar_horizontal_size: number;
}

export interface shell_choice {
  name: string;
  path: string;
  source: 'profile' | 'environment' | 'path' | 'system';
}

export type host_message =
  | { type: 'state'; side: sidebar_side; configuration: sidebar_configuration; tabs: sidebar_tab[]; sessions: session_info[]; trusted: boolean; appearance: appearance; active_id?: string; expanded_ids: string[]; shells: shell_choice[] }
  | { type: 'pdf_source'; id: string; url: string }
  | { type: 'pdf_error'; id: string; message: string }
  | { type: 'markdown_source'; id: string; source: { text: string; base_url: string } }
  | { type: 'markdown_error'; id: string; message: string }
  | { type: 'output'; id: string; data: string }
  | { type: 'session'; session: session_info }
  | { type: 'reset'; id: string }
  | { type: 'saved'; configuration: sidebar_configuration }
  | { type: 'error'; message: string }
  | { type: 'configure' }
  | { type: 'action'; action: 'save' | 'undo' | 'redo' | 'close' | 'add' | 'find' }
  | { type: 'paste'; id: string; data: string };

export type client_message =
  | { type: 'ready' }
  | { type: 'activate'; id: string; cols: number; rows: number }
  | { type: 'input'; id: string; data: string }
  | { type: 'resize'; id: string; cols: number; rows: number }
  | { type: 'restart'; id: string; cols: number; rows: number }
  | { type: 'select'; id: string }
  | { type: 'close_tab'; id: string }
  | { type: 'add_tab' }
  | { type: 'open_pdf' }
  | { type: 'open_preview' }
  | { type: 'load_markdown'; id: string }
  | { type: 'markdown_position'; id: string; position: markdown_position }
  | { type: 'open_markdown_link'; id: string; href: string }
  | { type: 'load_pdf'; id: string }
  | { type: 'pdf_reverse_sync'; id: string; page: number; x: number; y: number }
  | { type: 'pdf_position'; id: string; position: pdf_position }
  | { type: 'request_rename'; id: string }
  | { type: 'rename_tab'; id: string; name: string }
  | { type: 'set_tab_marker'; id: string; marker?: tab_marker }
  | { type: 'move_tab'; id: string; target_id: string; placement: 'before' | 'after' }
  | { type: 'expanded'; id: string; expanded: boolean }
  | { type: 'save'; configuration: sidebar_configuration; base_configuration: sidebar_configuration }
  | { type: 'select_profile' }
  | { type: 'configure' }
  | { type: 'open_other_sidebar' }
  | { type: 'refresh_shells' }
  | { type: 'focus'; id: string }
  | { type: 'export'; id: string; text: string; format?: export_format }
  | { type: 'open_link'; id: string; uri: string }
  | { type: 'open_file'; id: string; path: string; line: number; column?: number }
  | { type: 'draft_state'; configuring: boolean; can_undo: boolean; can_redo: boolean }
  | { type: 'settings' }
  | { type: 'trust' }
  | { type: 'copy'; text: string }
  | { type: 'paste'; id: string };
