import { hostname as system_hostname } from 'node:os';
import type { command_status } from './types';

export interface shell_state {
  cwd?: string;
  command_state: 'unknown' | 'idle' | 'running';
  command_status?: command_status;
  command_exit_code?: number;
}

export interface shell_state_options {
  cwd?: string;
  hostname?: string;
  platform?: NodeJS.Platform;
}

// Only one incomplete OSC is retained. No terminal output history or command history is kept.
const maximum_sequence_length = 8192;
const maximum_cwd_length = 4096;

/** A local, absolute directory path. Existence and access are checked at launch by the host. */
export function is_local_cwd(value: unknown, platform: NodeJS.Platform = process.platform): value is string {
  if (typeof value !== 'string' || !value || value.length > maximum_cwd_length
    || /[\x00-\x1f\x7f-\x9f]/.test(value)) return false;
  // Do not turn a shell notification into an implicit network/UNC access during restoration.
  return platform === 'win32'
    ? /^[a-z]:[\\/]/i.test(value)
    : value.startsWith('/') && !value.startsWith('//');
}

/**
 * Passive, bounded recognition of existing shell integration. These are advisory notifications,
 * not authenticated process information: any terminal program can emit an OSC sequence.
 */
export class shell_state_tracker {
  private current: shell_state;
  private mode: 'text' | 'escape' | 'osc' | 'osc_escape' | 'string' | 'string_escape' = 'text';
  private pending = '';
  private discarded = false;
  private command_in_progress = false;
  private revision = 0;
  private readonly hostname: string;
  private readonly platform: NodeJS.Platform;

  constructor(options: shell_state_options = {}) {
    this.platform = options.platform ?? process.platform;
    this.hostname = (options.hostname ?? system_hostname()).toLowerCase();
    this.current = {
      ...(is_local_cwd(options.cwd, this.platform) ? { cwd: options.cwd } : {}),
      command_state: 'unknown',
    };
  }

  get state(): shell_state {
    return { ...this.current };
  }

  /** Distinguish commands even when start and finish arrive in one PTY chunk. */
  get command_revision(): number {
    return this.revision;
  }

  /** A configured startup command was sent; only a later explicit shell notification clears it. */
  started_command(): void {
    if (!this.command_in_progress) this.revision++;
    this.command_in_progress = true;
    this.current.command_state = 'running';
    this.current.command_status = 'running';
    delete this.current.command_exit_code;
  }

  /** Printable typing at a known prompt is editing, not execution. Control input is uncertain
   * until the next shell notification; input alone never proves command completion. */
  input(data?: string): void {
    if (this.current.command_state === 'idle' && (data === undefined || /[\x00-\x1f\x7f]/.test(data))) {
      this.current.command_state = 'unknown';
    }
  }

  consume(data: string): void {
    for (const character of data) {
      if (character === '\x18' || character === '\x1a') {
        this.reset(); // CAN/SUB cancel an incomplete control string.
        continue;
      }
      switch (this.mode) {
        case 'text':
          if (character === '\x1b') this.mode = 'escape';
          else if (character === '\x9d') this.start_osc();
          else if ('\x90\x98\x9e\x9f'.includes(character)) this.mode = 'string';
          break;
        case 'escape':
          if (character === ']') this.start_osc();
          else if ('PX^_'.includes(character)) this.mode = 'string';
          else if (character !== '\x1b') this.mode = 'text';
          break;
        case 'osc':
          if (character === '\x07' || character === '\x9c') this.finish_osc();
          else if (character === '\x1b') this.mode = 'osc_escape';
          else if (!this.discarded) {
            if (this.pending.length + character.length > maximum_sequence_length
              || /[\x00-\x1f\x7f-\x9f]/.test(character)) {
              this.pending = '';
              this.discarded = true;
            } else this.pending += character;
          }
          break;
        case 'osc_escape':
          if (character === '\\') this.finish_osc();
          else {
            this.reset();
            if (character === ']') this.start_osc();
            else if (character === '\x1b') this.mode = 'escape';
            else if ('PX^_'.includes(character)) this.mode = 'string';
          }
          break;
        case 'string':
          if (character === '\x9c') this.reset();
          else if (character === '\x1b') this.mode = 'string_escape';
          break;
        case 'string_escape':
          if (character === '\\' || character === '\x9c') this.reset();
          else if (character !== '\x1b') this.mode = 'string';
          break;
      }
    }
  }

  private reset(): void {
    this.mode = 'text';
    this.pending = '';
    this.discarded = false;
  }

  private start_osc(): void {
    this.reset();
    this.mode = 'osc';
  }

  private finish_osc(): void {
    if (!this.discarded) this.accept(this.pending);
    this.reset();
  }

  private accept(sequence: string): void {
    if (sequence.startsWith('7;')) {
      const cwd = this.file_cwd(sequence.slice(2));
      if (cwd !== undefined) this.current.cwd = cwd;
      return;
    }
    const match = /^(133|633);([ABCD])(?:;.*)?$/.exec(sequence);
    if (match) {
      if (match[2] === 'D' && !/^(133|633);D(?:;-?\d+)?$/.test(sequence)) return;
      this.current.command_state = match[2] === 'C' ? 'running' : 'idle';
      if (match[2] === 'C') {
        this.started_command();
      } else if (match[2] === 'D') {
        // Some shells emit D while drawing their initial or nested prompt. It is only
        // a command result when paired with an observed command start in this tracker.
        if (!this.command_in_progress) return;
        this.command_in_progress = false;
        const code_text = sequence.split(';')[2];
        const code = code_text === undefined ? undefined : Number(code_text);
        if (code !== undefined && Number.isSafeInteger(code)) {
          this.current.command_status = code === 0 ? 'completed' : 'error';
          this.current.command_exit_code = code;
        } else {
          delete this.current.command_status;
          delete this.current.command_exit_code;
        }
      } else {
        this.command_in_progress = false;
        if (this.current.command_status === 'running') {
          // A prompt without a completion report proves idleness, not success.
          delete this.current.command_status;
          delete this.current.command_exit_code;
        }
      }
      return;
    }
    if (sequence.startsWith('633;P;Cwd=')) {
      // VS Code escapes backslashes and ASCII bytes (including semicolons) in property values.
      // Newer integrations append a nonce; notifications remain advisory, not authorization.
      const [encoded_cwd, , extra] = sequence.slice('633;P;Cwd='.length).split(';');
      if (extra !== undefined) return;
      const cwd = encoded_cwd.replace(/\\(\\|x[0-9a-f]{2})/gi,
        (_match, escape: string) => escape === '\\' ? '\\' : String.fromCharCode(parseInt(escape.slice(1), 16)));
      if (is_local_cwd(cwd, this.platform)) this.current.cwd = cwd;
    }
    // OSC 633 E contains command text, not a lifecycle signal; deliberately ignore it.
  }

  private file_cwd(value: string): string | undefined {
    if (!/^file:\/\//i.test(value) || /[\\\x00-\x20\x7f-\x9f]/.test(value)) return;
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      if (url.protocol !== 'file:' || url.username || url.password || url.port || url.search || url.hash
        || (host && host !== 'localhost' && host !== this.hostname)) return;
      if (/%(?:2f|5c)/i.test(url.pathname)) return;
      let cwd = decodeURIComponent(url.pathname);
      if (this.platform === 'win32' && /^\/[a-z]:\//i.test(cwd)) cwd = cwd.slice(1).replaceAll('/', '\\');
      return is_local_cwd(cwd, this.platform) ? cwd : undefined;
    } catch { return; }
  }
}
