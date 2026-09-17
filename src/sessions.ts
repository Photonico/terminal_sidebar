import type { terminal_profile, session_info } from './types';

export interface disposable {
  dispose(): void;
}

/** The member names in this interface follow the external node-pty contract. */
export interface pty_process {
  onData(listener: (data: string) => void): disposable;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): disposable;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(): void;
}

export interface pty_spawn_options {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

export interface pty_factory {
  spawn(file: string, args: string[], options: pty_spawn_options): pty_process;
}

/** Executable, arguments, environment and working directory passed to node-pty. */
export interface session_launch {
  file: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

export interface session_manager_options {
  resolve(profile: terminal_profile): session_launch;
  on_output(id: string, data: string): void;
  on_state(info: session_info): void;
  factory?: pty_factory;
  platform?: NodeJS.Platform;
}

interface terminal_session {
  info: session_info;
  generation: number;
  process?: pty_process;
  subscriptions: disposable[];
}

// A message contains at most 64 Ki UTF-16 code units, without a split surrogate pair.
const output_chunk_size = 64 * 1024;

/** Bound a terminal dimension in character cells; use the fallback for non-finite input. */
function bounded_dimension(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(1000, Math.floor(value)));
}

/** One long-lived PTY per terminal ID. Exited sessions restart only through an explicit start. */
export class session_manager implements disposable {
  private readonly sessions = new Map<string, terminal_session>();
  private next_generation = 0;
  private disposed = false;

  constructor(private readonly options: session_manager_options) {}

  /** Start once, or return the running session. Columns and rows are measured in character cells. */
  start(profile: terminal_profile, columns: number, rows: number): session_info {
    if (this.disposed) {
      return { id: profile.id, status: 'error', message: 'The terminal manager has been disposed.' };
    }
    const existing_session = this.sessions.get(profile.id);
    if (existing_session?.info.status === 'running') return { ...existing_session.info };

    const session: terminal_session = {
      info: { id: profile.id, status: 'running' },
      generation: ++this.next_generation,
      subscriptions: [],
    };
    this.sessions.set(profile.id, session);
    const generation = session.generation;
    let launch_phase: 'resolve' | 'load' | 'spawn' = 'resolve';

    try {
      const launch = this.options.resolve(profile);
      launch_phase = 'load';
      // Load lazily so configuration remains available without a usable native binary.
      const factory: pty_factory = this.options.factory ?? require('node-pty');
      launch_phase = 'spawn';
      const terminal_process = factory.spawn(launch.file, launch.args, {
        name: 'xterm-256color',
        cols: bounded_dimension(columns, 80),
        rows: bounded_dimension(rows, 24),
        cwd: launch.cwd,
        env: launch.env,
      });
      session.process = terminal_process;

      this.track_subscription(session, terminal_process.onData((data) => {
        // Forward output directly. Retained terminal views own their scrollback.
        let offset = 0;
        while (offset < data.length && this.is_running(session, generation)) {
          let chunk_end = Math.min(offset + output_chunk_size, data.length);
          const final_code_unit = data.charCodeAt(chunk_end - 1);
          if (chunk_end < data.length && final_code_unit >= 0xd800 && final_code_unit <= 0xdbff) {
            chunk_end--;
          }
          try {
            this.options.on_output(profile.id, data.slice(offset, chunk_end));
          } catch { /* A detached view cannot break a PTY. */ }
          offset = chunk_end;
        }
      }));

      this.track_subscription(session, terminal_process.onExit((event) => {
        if (!this.is_running(session, generation)) return;
        session.process = undefined;
        session.info = { id: profile.id, status: 'exited', exit_code: event.exitCode };
        this.clear_subscriptions(session);
        this.emit_state(session);

        // node-pty retains its Windows ConPTY worker after natural exit until kill().
        // POSIX kill() signals a numeric PID, which may already belong to another process.
        if ((this.options.platform ?? process.platform) === 'win32') {
          try {
            terminal_process.kill();
          } catch { /* Preserve the natural exit result if cleanup races. */ }
        }
      }));

      if (this.is_running(session, generation)) {
        this.emit_state(session);
        if (this.is_running(session, generation) && profile.command.trim()) {
          this.input(profile.id, profile.command + '\r');
        }
      }
    } catch (error) {
      const failed_process = session.process;
      session.process = undefined;
      this.clear_subscriptions(session);

      const error_code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
      const error_suffix = ['ENOENT', 'ENOTDIR', 'ENOMEM', 'EACCES', 'EPERM'].includes(error_code)
        ? ` (${error_code})`
        : '';
      let error_message: string;
      if (launch_phase === 'load') {
        error_message = 'The terminal backend could not load. Rebuild or reinstall the extension’s node-pty dependency.';
      } else if (launch_phase === 'resolve') {
        error_message = 'The shell or working directory could not be resolved. Check the configured executable path and terminal profile.';
      } else {
        error_message = `The terminal could not start. Check the shell, working directory, and node-pty installation.${error_suffix}`;
      }
      session.info = { id: profile.id, status: 'error', message: error_message };
      this.emit_state(session);
      try {
        failed_process?.kill();
      } catch { /* Spawn may already have failed or exited. */ }
    }
    return { ...session.info };
  }

  input(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session || session.info.status !== 'running' || this.disposed) return;
    try {
      session.process?.write(data);
    } catch { /* Process exit can race a queued input message. */ }
  }

  resize(id: string, columns: number, rows: number): void {
    const session = this.sessions.get(id);
    if (!session || session.info.status !== 'running' || this.disposed) return;
    try {
      session.process?.resize(bounded_dimension(columns, 80), bounded_dimension(rows, 24));
    } catch { /* Process exit can race resize. */ }
  }

  stop(id: string): void {
    const session = this.sessions.get(id);
    if (!session || session.info.status !== 'running') return;
    const terminal_process = session.process;
    session.process = undefined;
    session.generation = ++this.next_generation;
    session.info = { id, status: 'exited', message: 'Stopped.' };
    this.clear_subscriptions(session);
    this.emit_state(session);
    try {
      terminal_process?.kill();
    } catch { /* Already-exited processes do not need another signal. */ }
  }

  remove(id: string): void {
    this.stop(id);
    this.sessions.delete(id);
  }

  list(): session_info[] {
    return [...this.sessions.values()].map((session) => ({ ...session.info }));
  }

  get(id: string): session_info | undefined {
    const info = this.sessions.get(id)?.info;
    return info ? { ...info } : undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of this.sessions.keys()) this.stop(id);
    this.sessions.clear();
  }

  private is_running(session: terminal_session, generation: number): boolean {
    return !this.disposed
      && this.sessions.get(session.info.id) === session
      && session.generation === generation
      && session.info.status === 'running';
  }

  private track_subscription(session: terminal_session, subscription: disposable): void {
    if (session.info.status === 'running') {
      session.subscriptions.push(subscription);
      return;
    }
    try {
      subscription.dispose();
    } catch { /* Subscription already ended. */ }
  }

  private clear_subscriptions(session: terminal_session): void {
    for (const subscription of session.subscriptions.splice(0)) {
      try {
        subscription.dispose();
      } catch { /* Continue cleaning up other listeners. */ }
    }
  }

  private emit_state(session: terminal_session): void {
    try {
      this.options.on_state({ ...session.info });
    } catch { /* A detached view cannot prevent cleanup. */ }
  }
}
