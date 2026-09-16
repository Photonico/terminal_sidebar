import type { Profile, SessionInfo } from './types';

export interface Disposable { dispose(): void }
export interface PtyProcess {
  onData(listener: (data: string) => void): Disposable;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): Disposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}
export interface PtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}
export interface PtyFactory {
  spawn(file: string, args: string[], options: PtySpawnOptions): PtyProcess;
}
export interface SessionLaunch {
  file: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}
export interface SessionManagerOptions {
  resolve(profile: Profile): SessionLaunch;
  onOutput(id: string, data: string): void;
  onState(info: SessionInfo): void;
  factory?: PtyFactory;
  platform?: NodeJS.Platform;
}

interface Session {
  info: SessionInfo;
  generation: number;
  process?: PtyProcess;
  subscriptions: Disposable[];
}

const OUTPUT_CHUNK_SIZE = 64 * 1024;
function dimension(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(1000, Math.floor(value))) : fallback;
}

/** One long-lived PTY per profile. Exited sessions only restart through an explicit start call. */
export class SessionManager implements Disposable {
  private readonly sessions = new Map<string, Session>();
  private nextGeneration = 0;
  private disposed = false;

  constructor(private readonly options: SessionManagerOptions) {}

  start(profile: Profile, cols: number, rows: number): SessionInfo {
    if (this.disposed) return { id: profile.id, status: 'error', message: 'The terminal manager has been disposed.' };
    const existing = this.sessions.get(profile.id);
    if (existing?.info.status === 'running') return { ...existing.info };
    const session: Session = {
      info: { id: profile.id, status: 'running' },
      generation: ++this.nextGeneration,
      subscriptions: [],
    };
    this.sessions.set(profile.id, session);
    const generation = session.generation;
    let phase: 'resolve' | 'load' | 'spawn' = 'resolve';
    try {
      const launch = this.options.resolve(profile);
      phase = 'load';
      // Deliberately lazy: settings and activation work even when the native binary is unavailable.
      const factory: PtyFactory = this.options.factory ?? require('node-pty');
      phase = 'spawn';
      const pty = factory.spawn(launch.file, launch.args, {
        name: 'xterm-256color', cols: dimension(cols, 80), rows: dimension(rows, 24),
        cwd: launch.cwd, env: launch.env,
      });
      session.process = pty;
      this.track(session, pty.onData((data) => {
        // Forward directly; terminal scrollback belongs to the retained webview, not the host.
        for (let offset = 0; offset < data.length && this.isRunning(session, generation);) {
          let end = Math.min(offset + OUTPUT_CHUNK_SIZE, data.length);
          // Do not split a UTF-16 surrogate pair across separate webview messages.
          if (end < data.length && data.charCodeAt(end - 1) >= 0xd800 && data.charCodeAt(end - 1) <= 0xdbff) end--;
          try { this.options.onOutput(profile.id, data.slice(offset, end)); } catch { /* A detached view cannot break a PTY. */ }
          offset = end;
        }
      }));
      this.track(session, pty.onExit((event) => {
        if (!this.isRunning(session, generation)) return;
        session.process = undefined;
        session.info = { id: profile.id, status: 'exited', exitCode: event.exitCode };
        this.clearSubscriptions(session);
        this.emitState(session);
        // node-pty's Windows backend retains its ConPTY worker after natural exit
        // until kill() releases the native resources. POSIX kill() sends a signal
        // to a numeric PID, so never call it after a POSIX process has exited.
        if ((this.options.platform ?? process.platform) === 'win32') {
          try { pty.kill(); } catch { /* Preserve the natural exit result if cleanup races. */ }
        }
      }));
      if (this.isRunning(session, generation)) {
        this.emitState(session);
        if (this.isRunning(session, generation) && profile.command.trim()) this.input(profile.id, profile.command + '\r');
      }
    } catch (error) {
      const pty = session.process;
      session.process = undefined;
      this.clearSubscriptions(session);
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
      const suffix = ['ENOENT', 'ENOTDIR', 'ENOMEM', 'EACCES', 'EPERM'].includes(code) ? ` (${code})` : '';
      const message = phase === 'load'
        ? 'The terminal backend could not load. Rebuild or reinstall the extension’s node-pty dependency.'
        : phase === 'resolve'
          ? 'The shell or working directory could not be resolved. Check the configured executable path and terminal profile.'
          : `The terminal could not start. Check the shell, working directory, and node-pty installation.${suffix}`;
      session.info = { id: profile.id, status: 'error', message };
      this.emitState(session);
      try { pty?.kill(); } catch { /* Spawn may already have failed or exited. */ }
    }
    return { ...session.info };
  }

  input(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session || session.info.status !== 'running' || this.disposed) return;
    try { session.process?.write(data); } catch { /* Process exit can race a queued input message. */ }
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (!session || session.info.status !== 'running' || this.disposed) return;
    try { session.process?.resize(dimension(cols, 80), dimension(rows, 24)); } catch { /* Process exit can race resize. */ }
  }

  stop(id: string): void {
    const session = this.sessions.get(id);
    if (!session || session.info.status !== 'running') return;
    const pty = session.process;
    session.process = undefined;
    session.generation = ++this.nextGeneration;
    session.info = { id, status: 'exited', message: 'Stopped.' };
    this.clearSubscriptions(session);
    this.emitState(session);
    try { pty?.kill(); } catch { /* Already-exited processes do not need another signal. */ }
  }

  remove(id: string): void {
    this.stop(id);
    this.sessions.delete(id);
  }

  list(): SessionInfo[] { return [...this.sessions.values()].map((session) => ({ ...session.info })); }
  get(id: string): SessionInfo | undefined {
    const info = this.sessions.get(id)?.info;
    return info ? { ...info } : undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of this.sessions.keys()) this.stop(id);
    this.sessions.clear();
  }

  private isRunning(session: Session, generation: number): boolean {
    return !this.disposed && this.sessions.get(session.info.id) === session && session.generation === generation && session.info.status === 'running';
  }
  private track(session: Session, disposable: Disposable): void {
    if (session.info.status === 'running') session.subscriptions.push(disposable);
    else { try { disposable.dispose(); } catch { /* Subscription already ended. */ } }
  }
  private clearSubscriptions(session: Session): void {
    for (const disposable of session.subscriptions.splice(0)) {
      try { disposable.dispose(); } catch { /* Continue cleaning up other listeners. */ }
    }
  }
  private emitState(session: Session): void {
    try { this.options.onState({ ...session.info }); } catch { /* A detached view cannot prevent cleanup. */ }
  }
}
