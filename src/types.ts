export interface Profile {
  id: string;
  name: string;
  command: string;
  shell: string;
}

export type SessionStatus = 'idle' | 'running' | 'exited' | 'error';
export interface SessionInfo {
  id: string;
  status: SessionStatus;
  exitCode?: number;
  message?: string;
}

export interface Appearance {
  fontFamily: string;
  fontSize: number;
  cursorBlink: boolean;
  scrollback: number;
}

export interface ShellChoice {
  name: string;
  path: string;
  source: 'profile' | 'environment' | 'path' | 'system';
}

export type HostMessage =
  | { type: 'state'; profiles: Profile[]; sessions: SessionInfo[]; trusted: boolean; appearance: Appearance; activeId?: string; shells: ShellChoice[] }
  | { type: 'output'; id: string; data: string }
  | { type: 'session'; session: SessionInfo }
  | { type: 'reset'; id: string }
  | { type: 'saved'; profiles: Profile[] }
  | { type: 'error'; message: string }
  | { type: 'configure' }
  | { type: 'action'; action: 'save' | 'undo' | 'redo' | 'close' }
  | { type: 'paste'; id: string; data: string };

export type ClientMessage =
  | { type: 'ready' }
  | { type: 'activate'; id: string; cols: number; rows: number }
  | { type: 'input'; id: string; data: string }
  | { type: 'resize'; id: string; cols: number; rows: number }
  | { type: 'restart'; id: string; cols: number; rows: number }
  | { type: 'stop'; id: string }
  | { type: 'save'; profiles: Profile[]; baseProfiles: Profile[] }
  | { type: 'selectProfile' }
  | { type: 'configure' }
  | { type: 'refreshShells' }
  | { type: 'focus'; id: string }
  | { type: 'export'; id: string; text: string }
  | { type: 'draftState'; configuring: boolean; canUndo: boolean; canRedo: boolean }
  | { type: 'settings' }
  | { type: 'trust' }
  | { type: 'copy'; text: string }
  | { type: 'paste'; id: string };
