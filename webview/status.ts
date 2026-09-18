import type { session_info } from '../src/types';

export type indicator_status = 'idle' | 'running' | 'completed' | 'error';

/** Both the footer and tab dot use this one status interpretation and CSS palette. */
export function terminal_indicator(session?: session_info): indicator_status {
  if (session?.status === 'error') return 'error';
  if (session?.status === 'exited') {
    return session.exit_code === undefined ? 'idle' : session.exit_code === 0 ? 'completed' : 'error';
  }
  return session?.command_status ?? (session?.status === 'running' ? 'running' : 'idle');
}

export function show_tab_indicator(session: session_info | undefined, unread_bell: boolean): boolean {
  return unread_bell || session?.command_status !== undefined || session?.status === 'error'
    || (session?.status === 'exited' && session.exit_code !== undefined);
}

export function indicator_label(status: indicator_status): string {
  return { idle: 'Idle', running: 'Running', completed: 'Completed', error: 'Error' }[status];
}
