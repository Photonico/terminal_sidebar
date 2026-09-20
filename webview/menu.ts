export interface menu_item {
  label: string;
  action(): void;
  disabled?: boolean;
}

/** A single, disposable menu shared by tab actions and export format selection. */
export class terminal_menu {
  private readonly root = document.createElement('div');
  private readonly events = new AbortController();
  private restore_focus?: () => void;

  constructor() {
    this.root.className = 'terminal_menu';
    this.root.role = 'menu';
    this.root.hidden = true;
    this.root.setAttribute('aria-label', 'Terminal actions');
    document.body.append(this.root);
    const options = { signal: this.events.signal };
    document.addEventListener('pointerdown', event => {
      if (event.target instanceof Node && !this.root.contains(event.target)) {
        this.close(false);
      }
    }, options);
    document.addEventListener('focusin', event => {
      if (!this.root.hidden && event.target instanceof Node && !this.root.contains(event.target)) {
        this.close(false);
      }
    }, options);
    window.addEventListener('resize', () => this.close(), options);
    this.root.addEventListener('keydown', event => {
      const items = [...this.root.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      let next: number;
      if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
        }
        this.close();
        return;
      }
      if (event.key === 'ArrowDown') {
        next = (index + 1) % items.length;
      } else if (event.key === 'ArrowUp') {
        next = (index - 1 + items.length) % items.length;
      } else if (event.key === 'Home') {
        next = 0;
      } else if (event.key === 'End') {
        next = items.length - 1;
      } else {
        return;
      }
      event.preventDefault();
      items[next]?.focus();
    });
  }

  show(items: readonly menu_item[], x: number, y: number, restore_focus: () => void): void {
    this.close(false);
    this.restore_focus = restore_focus;
    this.root.replaceChildren(...items.map(item => {
      const button = document.createElement('button');
      button.type = 'button';
      button.role = 'menuitem';
      button.textContent = item.label;
      button.title = item.label;
      button.disabled = item.disabled ?? false;
      button.addEventListener('click', () => {
        this.close(false);
        item.action();
      });
      return button;
    }));
    this.root.hidden = false;
    this.root.style.left = `${Math.max(4, Math.min(x, window.innerWidth - this.root.offsetWidth - 4))}px`;
    this.root.style.top = `${Math.max(4, Math.min(y, window.innerHeight - this.root.offsetHeight - 4))}px`;
    this.root.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }

  close(restore = true): void {
    if (this.root.hidden) {
      return;
    }
    this.root.hidden = true;
    const callback = this.restore_focus;
    this.restore_focus = undefined;
    if (restore) {
      callback?.();
    }
  }

  dispose(): void {
    this.close(false);
    this.events.abort();
    this.root.remove();
  }
}
