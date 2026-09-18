import {
  copy_tab_marker, tab_marker_colors, tab_marker_shapes,
  type tab_marker, type tab_marker_color, type tab_marker_shape,
} from '../src/tab_marker';
import { marker_shape_descriptors } from './marker_shapes';
import './tab_marker.css';

function color_label(color: tab_marker_color): string {
  return color.slice(4).replace(/([a-z])([A-Z])/g, '$1 $2');
}

/** Font glyphs; all colours remain live references to the terminal's theme palette. */
export function create_tab_marker(marker: tab_marker): HTMLSpanElement {
  const icon = document.createElement('span');
  icon.classList.add('tab_marker');
  icon.setAttribute('aria-hidden', 'true');
  icon.style.color = `var(--vscode-terminal-${marker.color}, var(--vscode-foreground))`;
  const descriptor = marker_shape_descriptors[marker.shape];
  icon.textContent = descriptor.glyph;
  icon.title = `${color_label(marker.color)} ${descriptor.label.toLowerCase()}`;
  return icon;
}

interface tab_marker_options {
  anchor(id: string): HTMLElement | undefined;
  commit(id: string, marker: tab_marker | undefined): void;
  finished(id: string): void;
}

/** Editing is a local draft. Only Apply or Remove changes the terminal's saved marker. */
export class tab_marker_picker {
  private readonly root = document.createElement('form');
  private readonly events = new AbortController();
  private readonly preview = document.createElement('div');
  private readonly color_group = document.createElement('fieldset');
  private readonly shape_inputs = new Map<tab_marker_shape | 'none', HTMLInputElement>();
  private readonly color_inputs = new Map<tab_marker_color, HTMLInputElement>();
  private id?: string;
  private shape: tab_marker_shape | 'none' = 'none';
  private color: tab_marker_color = 'ansiBlue';

  constructor(private readonly options: tab_marker_options) {
    this.root.className = 'tab_marker_picker';
    this.root.hidden = true;
    this.root.role = 'dialog';
    this.root.setAttribute('aria-label', 'Change terminal tab icon');
    const heading = document.createElement('strong');
    heading.className = 'tab_marker_title';
    heading.textContent = 'Tab icon';
    const shape_group = document.createElement('fieldset');
    const shape_legend = document.createElement('legend');
    shape_legend.textContent = 'Shape';
    const shape_choice = (shape: tab_marker_shape | 'none'): HTMLLabelElement => {
      const label = document.createElement('label');
      label.className = 'tab_marker_choice';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'tab_marker_shape';
      input.value = shape;
      const caption = shape === 'none' ? 'None' : marker_shape_descriptors[shape].label;
      input.setAttribute('aria-label', caption);
      label.title = caption;
      label.append(input);
      if (shape === 'none') {
        const empty = document.createElement('span');
        empty.className = 'tab_marker_none';
        empty.textContent = '∅';
        empty.setAttribute('aria-hidden', 'true');
        const text = document.createElement('span');
        text.textContent = caption;
        label.classList.add('tab_marker_clear');
        label.append(empty, text);
      } else {
        const icon = create_tab_marker({ shape, color: this.color });
        icon.style.color = 'inherit';
        label.append(icon);
      }
      input.addEventListener('change', () => {
        if (input.checked) {
          this.shape = shape;
          this.update_preview();
        }
      });
      this.shape_inputs.set(shape, input);
      return label;
    };
    const choices = document.createElement('div');
    choices.className = 'tab_marker_shapes';
    choices.append(...tab_marker_shapes.map(shape => shape_choice(shape)));
    shape_group.append(shape_legend, shape_choice('none'), choices);

    const color_legend = document.createElement('legend');
    color_legend.textContent = 'Color · Terminal theme';
    const colors = document.createElement('div');
    colors.className = 'tab_marker_colors';
    for (const color of tab_marker_colors) {
      const label = document.createElement('label');
      label.className = 'tab_marker_choice tab_marker_swatch';
      label.title = `${color_label(color)} · terminal.${color}`;
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'tab_marker_color';
      input.value = color;
      input.setAttribute('aria-label', color_label(color));
      input.addEventListener('change', () => {
        if (input.checked) {
          this.color = color;
          this.update_preview();
        }
      });
      label.append(input, create_tab_marker({ shape: 'circle', color }));
      this.color_inputs.set(color, input);
      colors.append(label);
    }
    this.color_group.append(color_legend, colors);
    this.preview.className = 'tab_marker_preview';
    this.preview.role = 'status';
    const footer = document.createElement('div');
    footer.className = 'tab_marker_footer';
    const apply = document.createElement('button');
    apply.type = 'submit';
    apply.textContent = 'Apply';
    apply.className = 'tab_marker_apply';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => this.close());
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => this.commit(undefined));
    footer.append(apply, cancel, remove);
    this.root.append(heading, shape_group, this.color_group, this.preview, footer);
    document.body.append(this.root);

    this.root.addEventListener('submit', event => {
      event.preventDefault();
      this.commit(this.shape === 'none' ? undefined : { shape: this.shape, color: this.color });
    });
    this.root.addEventListener('keydown', event => {
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

  set_font_family(font_family: string): void {
    this.root.style.setProperty('--terminal_font_family', font_family);
  }

  open(id: string, current?: tab_marker): void {
    this.close(false);
    this.id = id;
    this.shape = current?.shape ?? 'none';
    this.color = current?.color ?? 'ansiBlue';
    for (const [shape, input] of this.shape_inputs) input.checked = shape === this.shape;
    for (const [color, input] of this.color_inputs) input.checked = color === this.color;
    this.update_preview();
    this.root.hidden = false;
    this.refresh();
    if (this.id) this.shape_inputs.get(this.shape)?.focus();
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
    this.color_group.disabled = this.shape === 'none';
    const description = document.createElement('span');
    description.textContent = this.shape === 'none' ? 'No tab icon' : `${color_label(this.color)} ${marker_shape_descriptors[this.shape].label.toLowerCase()}`;
    this.preview.replaceChildren(...(this.shape === 'none' ? [] : [create_tab_marker({ shape: this.shape, color: this.color })]), description);
  }

  private commit(marker: tab_marker | undefined): void {
    const id = this.id;
    if (!id) return;
    this.close();
    this.options.commit(id, marker === undefined ? undefined : copy_tab_marker(marker));
  }
}
