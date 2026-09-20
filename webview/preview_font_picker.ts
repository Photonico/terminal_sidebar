import { preview_fonts, valid_preview_font } from '../src/preview_font_state';
import './preview_font_picker.css';

let picker_sequence = 0;

/** A local font menu writes the same user preference used by every Markdown reader. */
export class preview_font_picker {
  readonly root = document.createElement('div');
  private readonly events = new AbortController();
  private readonly items = new Map<string, HTMLButtonElement>();
  private readonly form = document.createElement('form');
  private readonly input = document.createElement('input');
  private readonly error = document.createElement('div');
  private readonly apply = document.createElement('button');
  private anchor?: HTMLButtonElement;
  private current = 'default';
  private disposed = false;

  constructor(private readonly choose: (font: string) => void) {
    const options = { signal: this.events.signal };
    this.root.id = `preview_font_picker_${++picker_sequence}`;
    this.root.className = 'preview_font_picker';
    this.root.hidden = true;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Markdown preview font');
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Preview fonts');
    for (const choice of preview_fonts) {
      menu.append(this.item(choice.value, choice.label, choice.description, () => this.select(choice.value)));
      if (choice.value === 'default') {
        const separator = document.createElement('div');
        separator.className = 'preview_font_separator';
        separator.setAttribute('role', 'separator');
        menu.append(separator);
      }
    }
    menu.append(this.item('custom', 'Custom font…', 'Enter a font family or fallback list', () => {
      this.form.hidden = false;
      this.position();
      this.input.focus();
    }));
    this.form.className = 'preview_font_custom';
    this.form.hidden = true;
    const label = document.createElement('label');
    label.textContent = 'Font family';
    label.htmlFor = `${this.root.id}_input`;
    this.input.id = label.htmlFor;
    this.input.type = 'text';
    this.input.maxLength = 256;
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.input.placeholder = 'Georgia, "Noto Serif CJK SC", serif';
    this.input.title = 'Font family, with optional comma-separated fallbacks';
    this.error.id = `${this.root.id}_error`;
    this.error.className = 'preview_font_error';
    this.error.setAttribute('role', 'status');
    this.input.setAttribute('aria-describedby', this.error.id);
    this.apply.type = 'submit';
    this.apply.className = 'primary';
    this.apply.textContent = 'Apply';
    this.apply.title = 'Apply the font to all Markdown previews';
    this.apply.setAttribute('aria-label', this.apply.title);
    this.form.append(label, this.input, this.error, this.apply);
    this.root.append(menu, this.form);
    this.form.addEventListener('submit', event => {
      event.preventDefault();
      if (this.validate()) this.select(this.input.value.trim());
    }, options);
    this.input.addEventListener('input', () => this.validate(), options);
    this.root.addEventListener('keydown', event => this.keydown(event), options);
    document.body.append(this.root);
    for (const event of ['pointerdown', 'focusin'] as const) {
      document.addEventListener(event, event => {
        const target = event.target as Node | null;
        if (target && !this.root.contains(target) && !this.anchor?.contains(target)) this.close(false);
      }, options);
    }
    document.addEventListener('scroll', event => {
      if (!this.root.contains(event.target as Node | null)) this.close(false);
    }, { ...options, capture: true });
    window.addEventListener('resize', () => this.close(false), options);
    this.set_font('default');
  }

  private item(value: string, label: string, title: string, action: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'preview_font_option';
    button.title = title;
    button.setAttribute('role', 'menuitemradio');
    button.setAttribute('aria-label', label);
    const check = document.createElement('span');
    check.className = 'codicon codicon-check';
    check.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.textContent = label;
    button.append(check, text);
    button.addEventListener('click', action, { signal: this.events.signal });
    this.items.set(value, button);
    return button;
  }

  set_font(value: string): void {
    this.current = valid_preview_font(value) && value.trim() ? value.trim() : 'default';
    const selected = this.items.has(this.current) ? this.current : 'custom';
    for (const [value, item] of this.items) item.setAttribute('aria-checked', String(value === selected));
  }

  toggle(anchor: HTMLButtonElement): void {
    if (this.disposed) return;
    if (!this.root.hidden && this.anchor === anchor) { this.close(true); return; }
    this.close(false);
    this.anchor = anchor;
    anchor.setAttribute('aria-haspopup', 'dialog');
    anchor.setAttribute('aria-controls', this.root.id);
    anchor.setAttribute('aria-expanded', 'true');
    this.input.value = preview_fonts.some(font => font.value === this.current) ? '' : this.current;
    this.form.hidden = true;
    this.validate();
    this.root.hidden = false;
    this.position();
    [...this.items.values()].find(item => item.getAttribute('aria-checked') === 'true')?.focus();
  }

  close(restore_focus = false): void {
    this.root.hidden = true;
    const anchor = this.anchor;
    this.anchor = undefined;
    anchor?.setAttribute('aria-expanded', 'false');
    if (restore_focus) anchor?.focus();
  }

  private position(): void {
    if (!this.anchor || this.root.hidden) return;
    const bounds = this.anchor.getBoundingClientRect();
    const width = this.root.offsetWidth;
    const height = this.root.offsetHeight;
    const top = bounds.bottom + height + 4 <= window.innerHeight ? bounds.bottom + 4 : bounds.top - height - 4;
    this.root.style.left = `${Math.max(4, Math.min(bounds.right - width, window.innerWidth - width - 4))}px`;
    this.root.style.top = `${Math.max(4, Math.min(top, window.innerHeight - height - 4))}px`;
  }

  private validate(): boolean {
    const valid = valid_preview_font(this.input.value) && !!this.input.value.trim();
    this.apply.disabled = !valid;
    this.input.setAttribute('aria-invalid', String(!valid && !!this.input.value));
    this.error.textContent = !valid && this.input.value ? 'Enter up to 256 characters of font names, separated by commas.' : '';
    return valid;
  }

  private select(value: string): void {
    if (this.disposed) return;
    this.close(true);
    this.choose(value);
  }

  private keydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); this.close(true); return;
    }
    const items = [...this.items.values()];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    let next: number;
    if (event.key === 'ArrowDown') next = (index + 1) % items.length;
    else if (event.key === 'ArrowUp') next = (index + items.length - 1) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else return;
    event.preventDefault(); event.stopPropagation(); items[next].focus();
  }

  dispose(): void {
    this.disposed = true;
    this.close(false);
    this.events.abort();
    this.root.remove();
  }
}
