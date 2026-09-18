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

export function show_tab_indicator(session: session_info | undefined, unread_bell: boolean, completion_viewed = false): boolean {
  if (completion_viewed && terminal_indicator(session) === 'completed') return unread_bell;
  return unread_bell || session?.command_status !== undefined || session?.status === 'error'
    || (session?.status === 'exited' && session.exit_code !== undefined);
}

/** Viewing a result only dismisses that completion, never a later command or an error. */
export class tab_completion_tracker {
  private readonly viewed = new Map<string, Pick<session_info, 'status' | 'command_revision'>>();

  observe(session: session_info): void {
    if (terminal_indicator(session) !== 'completed') this.delete(session.id);
  }

  view(session: session_info | undefined): void {
    if (session && terminal_indicator(session) === 'completed') {
      this.viewed.set(session.id, { status: session.status, command_revision: session.command_revision });
    }
  }

  is_viewed(session: session_info | undefined): boolean {
    const previous = session && this.viewed.get(session.id);
    return Boolean(previous && session && terminal_indicator(session) === 'completed'
      && previous.status === session.status && previous.command_revision === session.command_revision);
  }

  delete(id: string): void {
    this.viewed.delete(id);
  }
}

export function indicator_label(status: indicator_status): string {
  return { idle: 'Idle', running: 'Running', completed: 'Completed', error: 'Error' }[status];
}
