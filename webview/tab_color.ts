import { tab_colors, type tab_color } from '../src/tab_color';
import './tab_color.css';

function color_label(color: tab_color): string {
  return color.slice(4).replace(/([a-z])([A-Z])/g, '$1 $2');
}

function theme_color(color: tab_color): string {
  return `var(--vscode-terminal-${color}, currentColor)`;
}

/** Only the name is decorated; controls and command notifications retain their theme colours. */
export function apply_tab_name_color(label: HTMLElement, color: tab_color | undefined): void {
  const text = label.textContent ?? '';
  if (color === undefined) {
    label.textContent = text;
    return;
  }
  // Keep the outer label's original theme/hover/error colour as the inherited mix base.
  const name = document.createElement('span');
  name.className = 'tab_name_colored';
  name.style.setProperty('--tab_name_color', theme_color(color));
  name.textContent = text;
  label.replaceChildren(name);
}

interface tab_color_options {
  anchor(id: string): HTMLElement | undefined;
  commit(id: string, color: tab_color | undefined): void;
  inactive_foreground(): string;
  finished(id: string): void;
}

/** Preview is a local draft. Only Apply or Reset changes the saved name colour. */
export class tab_color_picker {
  private readonly root = document.createElement('form');
  private readonly events = new AbortController();
  private readonly preview = document.createElement('div');
  private readonly color_inputs = new Map<tab_color, HTMLInputElement>();
  private id?: string;
  private name = '';
  private color: tab_color = 'ansiBlue';

  constructor(private readonly options: tab_color_options) {
    this.root.className = 'tab_color_picker';
    this.root.hidden = true;
    this.root.role = 'dialog';
    this.root.setAttribute('aria-label', 'Change terminal tab name color');
    const heading = document.createElement('strong');
    heading.className = 'tab_color_title';
    heading.textContent = 'Tab name color';
    const color_group = document.createElement('fieldset');
    const color_legend = document.createElement('legend');
    color_legend.textContent = 'Color · Terminal theme';
    const colors = document.createElement('div');
    colors.className = 'tab_colors';
    for (const color of tab_colors) {
      const label = document.createElement('label');
      label.className = 'tab_color_choice tab_color_swatch';
      label.title = `${color_label(color)} · terminal.${color}`;
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'tab_color';
      input.value = color;
      input.setAttribute('aria-label', color_label(color));
      input.addEventListener('change', () => {
        if (input.checked) {
          this.color = color;
          this.update_preview();
        }
      });
      const swatch = document.createElement('span');
      swatch.className = 'tab_color_swatch_sample';
      swatch.style.backgroundColor = theme_color(color);
      swatch.setAttribute('aria-hidden', 'true');
      label.append(input, swatch);
      this.color_inputs.set(color, input);
      colors.append(label);
    }
    color_group.append(color_legend, colors);
    this.preview.className = 'tab_color_preview';
    this.preview.role = 'status';
    const footer = document.createElement('div');
    footer.className = 'tab_color_footer';
    const apply = document.createElement('button');
    apply.type = 'submit';
    apply.textContent = 'Apply';
    apply.className = 'tab_color_apply';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => this.close());
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Reset';
    remove.addEventListener('click', () => this.commit(undefined));
    footer.append(apply, cancel, remove);
    this.root.append(heading, color_group, this.preview, footer);
    document.body.append(this.root);

    this.root.addEventListener('submit', event => {
      event.preventDefault();
      this.commit(this.color);
    });
    this.root.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.close();
      } else if (event.key === 'Tab') {
        // Native radio groups have one tab stop; retain that behaviour inside the popover.
        const focusable = [...this.root.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
          'button:not(:disabled), input:checked:not(:disabled)',
        )].filter(element => !element.closest('fieldset:disabled'));
        const index = focusable.indexOf(document.activeElement as HTMLInputElement | HTMLButtonElement);
        if (event.shiftKey && index === 0) {
          event.preventDefault();
          focusable.at(-1)?.focus();
        } else if (!event.shiftKey && index === focusable.length - 1) {
          event.preventDefault();
          focusable[0]?.focus();
        }
      }
    });
    const listener_options = { signal: this.events.signal };
    document.addEventListener('pointerdown', event => {
      if (!this.root.hidden && event.target instanceof Node && !this.root.contains(event.target)) this.close(false);
    }, listener_options);
    window.addEventListener('resize', () => this.refresh(), listener_options);
    document.addEventListener('scroll', () => this.refresh(), { ...listener_options, capture: true });
  }

  get editing(): boolean {
    return this.id !== undefined;
  }

  open(id: string, name: string, current?: tab_color): void {
    this.close(false);
    this.id = id;
    this.name = name;
    this.color = current ?? 'ansiBlue';
    this.root.style.setProperty('--tab_color_inactive_foreground', this.options.inactive_foreground());
    for (const [color, input] of this.color_inputs) input.checked = color === this.color;
    this.update_preview();
    this.root.hidden = false;
    this.refresh();
    if (this.id) this.color_inputs.get(this.color)?.focus();
  }

  refresh(): void {
    if (!this.id) return;
    const anchor = this.options.anchor(this.id);
    if (!anchor?.isConnected || anchor.closest('[hidden]')) {
      this.close(false);
      return;
    }
    const bounds = anchor.getBoundingClientRect();
    const width = this.root.offsetWidth;
    const height = this.root.offsetHeight;
    this.root.style.left = `${Math.max(4, Math.min(bounds.left, window.innerWidth - width - 4))}px`;
    const top = bounds.bottom + height + 4 <= window.innerHeight ? bounds.bottom : bounds.top - height;
    this.root.style.top = `${Math.max(4, Math.min(top, window.innerHeight - height - 4))}px`;
  }

  close(restore = true): void {
    const id = this.id;
    this.id = undefined;
    this.root.hidden = true;
    if (id && restore) this.options.finished(id);
  }

  dispose(): void {
    this.close(false);
    this.events.abort();
    this.root.remove();
  }

  private update_preview(): void {
    this.preview.replaceChildren(...(['Active', 'Inactive'] as const).map(state => {
      const row = document.createElement('div');
      row.className = 'tab_color_preview_row';
      const caption = document.createElement('span');
      caption.textContent = state;
      const name = document.createElement('span');
      name.className = 'tab_color_preview_name';
      name.dataset.active = String(state === 'Active');
      name.textContent = this.name;
      name.title = this.name;
      apply_tab_name_color(name, this.color);
      row.append(caption, name);
      return row;
    }));
  }

  private commit(color: tab_color | undefined): void {
    const id = this.id;
    if (!id) return;
    this.close();
    this.options.commit(id, color);
  }
}
