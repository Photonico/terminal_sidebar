import { tab_colors, type tab_color } from '../src/tab_color';
import { copy_tab_marker, type tab_marker } from '../src/tab_marker';
import { codicon, codicon_picker } from './codicon_picker';
import './tab_marker.css';

function color_label(color: tab_color): string {
  if (color === 'tab_active_foreground') return 'Active tab foreground';
  if (color === 'tab_inactive_foreground') return 'Inactive tab foreground';
  return color.slice(4).replace(/([a-z])([A-Z])/g, '$1 $2');
}

function theme_token(color: tab_color): string {
  if (color === 'tab_active_foreground') return 'tab.activeForeground';
  if (color === 'tab_inactive_foreground') return 'tab.inactiveForeground';
  return `terminal.${color}`;
}

function theme_color(color: tab_color): string {
  return `var(--vscode-${theme_token(color).replace('.', '-')}, currentColor)`;
}

/** Codicon glyphs are independent of the terminal font and command status. */
export function create_tab_marker(marker: tab_marker): HTMLSpanElement {
  const wrapper = document.createElement('span');
  wrapper.className = 'tab_marker';
  wrapper.style.setProperty('--tab_marker_color', theme_color(marker.color));
  wrapper.title = `${marker.icon} · ${color_label(marker.color)}`;
  wrapper.setAttribute('aria-label', wrapper.title);
  wrapper.setAttribute('role', 'img');
  wrapper.append(codicon(marker.icon));
  return wrapper;
}

interface tab_marker_options {
  anchor(id: string): HTMLElement | undefined;
  commit(id: string, marker: tab_marker | undefined): void;
  inactive_foreground(): string;
  finished(id: string): void;
}

/** Preview is a local draft. Only Apply or Remove changes the saved marker. */
export class tab_marker_picker {
  private readonly root = document.createElement('form');
  private readonly events = new AbortController();
  private readonly preview = document.createElement('div');
  private readonly icon_picker: codicon_picker;
  private icon = 'bookmark';
  private readonly color_inputs = new Map<tab_color, HTMLInputElement>();
  private id?: string;
  private name = '';
  private color: tab_color = 'ansiBlue';

  constructor(private readonly options: tab_marker_options) {
    this.root.className = 'tab_marker_picker';
    this.root.hidden = true;
    this.root.role = 'dialog';
    this.root.setAttribute('aria-label', 'Change terminal tab marker');
    const heading = document.createElement('strong');
    heading.className = 'tab_marker_title';
    heading.textContent = 'Tab marker';
    this.icon_picker = new codicon_picker({
      change: icon => { this.icon = icon; this.update_preview(); },
      layout: () => this.refresh(),
    });
    const color_group = document.createElement('fieldset');
    const color_legend = document.createElement('legend');
    color_legend.textContent = 'Color';
    const colors = document.createElement('div');
    colors.className = 'tab_colors';
    for (const color of tab_colors) {
      const label = document.createElement('label');
      label.className = 'tab_marker_choice tab_marker_swatch';
      label.title = `${color_label(color)} · ${theme_token(color)}`;
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
      swatch.className = 'tab_marker_swatch_sample';
      swatch.style.backgroundColor = theme_color(color);
      swatch.setAttribute('aria-hidden', 'true');
      label.append(input, swatch);
      this.color_inputs.set(color, input);
      colors.append(label);
    }
    color_group.append(color_legend, colors);
    this.preview.className = 'tab_marker_preview';
    this.preview.role = 'status';
    const footer = document.createElement('div');
    footer.className = 'tab_marker_footer';
    const apply = document.createElement('button');
    apply.type = 'submit';
    apply.textContent = 'Apply';
    apply.title = 'Apply tab marker';
    apply.className = 'tab_marker_apply';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.title = 'Cancel tab marker changes';
    cancel.addEventListener('click', () => this.close());
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.title = 'Remove tab marker';
    remove.addEventListener('click', () => this.commit(undefined));
    footer.append(apply, cancel, remove);
    this.root.append(heading, this.icon_picker.root, color_group, this.preview, footer);
    document.body.append(this.root);

    this.root.addEventListener('submit', event => {
      event.preventDefault();
      this.commit({ icon: this.icon, color: this.color });
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
          'button:not(:disabled):not([tabindex="-1"]), input:not(:disabled):not([type="radio"]), input[type="radio"]:checked:not(:disabled)',
        )].filter(element => !element.closest('[hidden], fieldset:disabled'));
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

  open(id: string, name: string, current?: tab_marker): void {
    this.close(false);
    this.id = id;
    this.name = name;
    this.icon = current?.icon ?? 'bookmark';
    this.color = current?.color ?? 'ansiBlue';
    this.icon_picker.set(this.icon);
    this.root.style.setProperty('--tab_marker_inactive_foreground', this.options.inactive_foreground());
    for (const [color, input] of this.color_inputs) input.checked = color === this.color;
    this.update_preview();
    this.root.hidden = false;
    this.refresh();
    if (this.id) this.icon_picker.root.querySelector<HTMLButtonElement>('button[aria-pressed="true"], .codicon_others[data-selected="true"]')?.focus();
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
    this.icon_picker.close();
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
      row.className = 'tab_marker_preview_row';
      const caption = document.createElement('span');
      caption.textContent = state;
      const name = document.createElement('span');
      name.className = 'tab_marker_preview_name';
      name.dataset.active = String(state === 'Active');
      const label = document.createElement('span');
      label.textContent = this.name;
      label.title = this.name;
      name.append(create_tab_marker({ icon: this.icon, color: this.color }), label);
      row.append(caption, name);
      return row;
    }));
  }

  private commit(marker: tab_marker | undefined): void {
    const id = this.id;
    if (!id) return;
    this.close();
    this.options.commit(id, marker === undefined ? undefined : copy_tab_marker(marker));
  }
}
