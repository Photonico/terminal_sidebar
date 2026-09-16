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

export type HostMessage =
  | { type: 'state'; profiles: Profile[]; sessions: SessionInfo[]; trusted: boolean; appearance: Appearance; activeId?: string }
  | { type: 'output'; id: string; data: string }
  | { type: 'session'; session: SessionInfo }
  | { type: 'reset'; id: string }
  | { type: 'saved'; profiles: Profile[] }
  | { type: 'error'; message: string }
  | { type: 'configure' }
  | { type: 'paste'; id: string; data: string };

export type ClientMessage =
  | { type: 'ready' }
  | { type: 'activate'; id: string; cols: number; rows: number }
  | { type: 'input'; id: string; data: string }
  | { type: 'resize'; id: string; cols: number; rows: number }
  | { type: 'restart'; id: string; cols: number; rows: number }
  | { type: 'stop'; id: string }
  | { type: 'save'; profiles: Profile[] }
  | { type: 'settings' }
  | { type: 'trust' }
  | { type: 'copy'; text: string }
  | { type: 'paste'; id: string };
