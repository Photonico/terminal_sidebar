import { is_tab_name } from '../src/profiles';

interface rename_options {
  anchor(id: string): HTMLElement | undefined;
  commit(id: string, name: string): void;
  finished(id: string): void;
}

/** The editor lives outside replaceable tab headers, preserving a draft across host updates. */
export class tab_rename {
  private readonly root = document.createElement('form');
  private readonly input = document.createElement('input');
  private readonly error = document.createElement('span');
  private readonly events = new AbortController();
  private id?: string;

  constructor(private readonly options: rename_options) {
    this.root.className = 'tab_rename';
    this.root.hidden = true;
    this.input.type = 'text';
    this.input.maxLength = 80;
    this.input.setAttribute('aria-label', 'Terminal name');
    this.input.setAttribute('aria-describedby', 'tab_rename_error');
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.error.id = 'tab_rename_error';
    this.error.role = 'alert';
    this.error.hidden = true;
    this.root.append(this.input, this.error);
    document.body.append(this.root);
    this.root.addEventListener('submit', event => {
      event.preventDefault();
      if (!this.id) {
        return;
      }
      if (!is_tab_name(this.input.value)) {
        this.input.setAttribute('aria-invalid', 'true');
        this.error.textContent = 'Use 1–80 characters on one line.';
        this.error.hidden = false;
        return;
      }
      const id = this.id;
      const name = this.input.value.trim();
      this.close();
      this.options.commit(id, name);
    });
    this.input.addEventListener('input', () => {
      this.input.removeAttribute('aria-invalid');
      this.error.hidden = true;
    });
    this.input.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        this.close();
      } else if (event.key === 'Enter' && event.isComposing) {
        event.preventDefault();
      }
    });
    this.input.addEventListener('blur', () => this.close(false));
    window.addEventListener('resize', () => this.refresh(), { signal: this.events.signal });
    document.addEventListener('scroll', () => this.refresh(), { capture: true, signal: this.events.signal });
  }

  get editing(): boolean {
    return Boolean(this.id);
  }

  open(id: string, name: string): void {
    this.close(false);
    this.id = id;
    this.input.value = name;
    this.input.removeAttribute('aria-invalid');
    this.error.hidden = true;
    this.root.hidden = false;
    this.refresh();
    if (this.id) {
      this.input.focus();
      this.input.select();
    }
  }

  refresh(): void {
    if (!this.id) {
      return;
    }
    const anchor = this.options.anchor(this.id);
    if (!anchor?.isConnected || anchor.closest('[hidden]')) {
      this.close(false);
      return;
    }
    const bounds = anchor.getBoundingClientRect();
    this.root.style.left = `${Math.max(0, Math.min(bounds.left, window.innerWidth - 100))}px`;
    this.root.style.top = `${bounds.top}px`;
    this.root.style.width = `${Math.min(Math.max(bounds.width, 100), window.innerWidth - Math.max(0, bounds.left))}px`;
    this.input.style.height = `${Math.max(24, bounds.height)}px`;
  }

  close(restore = true): void {
    const id = this.id;
    this.id = undefined;
    this.root.hidden = true;
    if (id && restore) {
      this.options.finished(id);
    }
  }

  dispose(): void {
    this.close(false);
    this.events.abort();
    this.root.remove();
  }
}
