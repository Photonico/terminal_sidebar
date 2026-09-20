import type { pdf_mode, pdf_zoom } from '../src/pdf_state';
import { create_document_badge } from './document_badge';
import { preview_zoom_symbol } from './preview_controls';
import './pdf_toolbar.css';

export interface pdf_toolbar_callbacks {
  outline(): void;
  move(direction: -1 | 1): void;
  zoom(direction: -1 | 0 | 1): void;
  page(page: number): void;
  set_zoom(zoom: pdf_zoom): void;
  reload(): void;
  mode(mode: pdf_mode): void;
  dark(enabled: boolean): void;
}

export interface pdf_toolbar_state {
  page: number;
  pages: number;
  zoom: pdf_zoom;
  mode: pdf_mode;
  dark: boolean;
  outline_open: boolean;
}

let toolbar_sequence = 0;

function icon(name: string): HTMLSpanElement {
  const element = document.createElement('span');
  element.className = `codicon codicon-${name}`;
  element.setAttribute('aria-hidden', 'true');
  return element;
}

/** PDF controls share state with the reader; they never own document navigation. */
export class pdf_toolbar {
  readonly root = document.createElement('div');
  private readonly events = new AbortController();
  private readonly outline: HTMLButtonElement;
  private readonly previous: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private readonly page_input = document.createElement('input');
  private readonly page_count = document.createElement('span');
  private readonly zoom_select = document.createElement('select');
  private readonly settings: HTMLButtonElement;
  private readonly menu = document.createElement('div');
  private readonly modes = new Map<pdf_mode, HTMLButtonElement>();
  private readonly dark: HTMLButtonElement;
  private custom_zoom?: HTMLOptionElement;
  private page_dirty = false;
  private state: pdf_toolbar_state = {
    page: 1, pages: 0, zoom: 'page-width', mode: 'continuous', dark: false, outline_open: false,
  };

  constructor(private readonly callbacks: pdf_toolbar_callbacks) {
    const options = { signal: this.events.signal };
    this.root.className = 'pdf-toolbar preview-toolbar';
    this.root.setAttribute('role', 'toolbar');
    this.root.setAttribute('aria-label', 'PDF navigation');
    const left = document.createElement('div');
    left.className = 'pdf-toolbar-left preview-toolbar-left';
    this.outline = this.button('Toggle document outline', 'symbol-keyword', callbacks.outline);
    this.previous = this.button('Previous page', 'arrow-circle-up', () => callbacks.move(-1));
    this.next = this.button('Next page', 'arrow-circle-down', () => callbacks.move(1));
    left.append(create_document_badge('pdf'), this.outline, this.previous, this.next,
      this.zoom_button('Zoom in', 1), this.zoom_button('Actual size (100%)', 0),
      this.zoom_button('Zoom out', -1));

    const right = document.createElement('div');
    right.className = 'pdf-toolbar-right preview-toolbar-right';
    const page_control = document.createElement('div');
    page_control.className = 'pdf-page-control';
    this.page_input.className = 'pdf-control preview-control';
    this.page_input.type = 'number';
    this.page_input.min = '1';
    this.page_input.step = '1';
    this.page_input.title = 'Go to page';
    this.page_input.setAttribute('aria-label', 'Page number');
    this.page_input.addEventListener('input', () => { this.page_dirty = true; }, options);
    this.page_input.addEventListener('change', () => this.commit_page(), options);
    this.page_input.addEventListener('keydown', event => {
      if (event.isComposing || event.key !== 'Enter') return;
      event.preventDefault();
      event.stopPropagation();
      this.commit_page();
    }, options);
    page_control.append(this.page_input, this.page_count);

    const zoom_control = document.createElement('span');
    zoom_control.className = 'pdf-zoom-control preview-zoom-control preview-control';
    this.zoom_select.title = 'Zoom';
    this.zoom_select.setAttribute('aria-label', 'Zoom');
    const zooms: [pdf_zoom, string][] = [
      ['page-width', 'Fit width'], ['page-fit', 'Fit page'],
      ...[25, 50, 75, 100, 125, 150, 200, 300, 400].map(value => [value / 100, `${value}%`] as [number, string]),
    ];
    for (const [zoom, label] of zooms) this.zoom_select.add(new Option(label, String(zoom)));
    this.zoom_select.addEventListener('change', () => {
      const value = this.zoom_select.value;
      callbacks.set_zoom(value === 'page-width' || value === 'page-fit' ? value : Number(value));
    }, options);
    zoom_control.append(this.zoom_select, icon('chevron-down'));
    this.settings = this.button('PDF settings', 'settings-gear', () => this.toggle_menu());
    this.settings.setAttribute('aria-haspopup', 'menu');
    this.settings.setAttribute('aria-expanded', 'false');
    this.settings.addEventListener('keydown', event => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      event.stopPropagation();
      this.show_menu(event.key === 'ArrowUp');
    }, options);
    right.append(page_control, zoom_control, this.button('Reload PDF', 'refresh', callbacks.reload), this.settings);
    this.root.append(left, right);

    this.menu.id = `pdf-settings-${++toolbar_sequence}`;
    this.menu.className = 'pdf-settings-menu';
    this.menu.hidden = true;
    this.menu.setAttribute('role', 'menu');
    this.menu.setAttribute('aria-label', 'PDF settings');
    this.settings.setAttribute('aria-controls', this.menu.id);
    const modes = document.createElement('div');
    modes.setAttribute('role', 'group');
    modes.setAttribute('aria-label', 'Page layout');
    for (const [mode, label] of [
      ['continuous', 'Continuous'], ['single', 'Single page'], ['spread', 'Two pages'],
    ] as const) {
      const button = this.menu_item(label, 'menuitemradio', () => callbacks.mode(mode));
      this.modes.set(mode, button);
      modes.append(button);
    }
    const separator = document.createElement('div');
    separator.className = 'pdf-settings-separator';
    separator.setAttribute('role', 'separator');
    this.dark = this.menu_item('Dark mode', 'menuitemcheckbox', () => callbacks.dark(!this.state.dark));
    this.menu.append(modes, separator, this.dark);
    this.menu.addEventListener('keydown', event => this.menu_keydown(event), options);
    document.body.append(this.menu);
    document.addEventListener('pointerdown', event => {
      if (event.target instanceof Node && !this.menu.contains(event.target) && !this.settings.contains(event.target)) {
        this.close_menu(false);
      }
    }, options);
    document.addEventListener('focusin', event => {
      if (event.target instanceof Node && !this.menu.contains(event.target) && !this.settings.contains(event.target)) {
        this.close_menu(false);
      }
    }, options);
    window.addEventListener('resize', () => this.close_menu(false), options);
    document.addEventListener('scroll', event => {
      if (event.target instanceof Node && !this.menu.contains(event.target)) this.close_menu(false);
    }, { ...options, capture: true });
    this.update(this.state);
  }

  update(state: pdf_toolbar_state): void {
    this.state = { ...state };
    const vertical = state.mode === 'continuous';
    const pair_start = Math.floor((state.page - 1) / 2) * 2;
    this.previous.disabled = state.pages === 0 || (!vertical && (state.mode === 'spread' ? pair_start === 0 : state.page <= 1));
    this.next.disabled = state.pages === 0 || (!vertical && (state.mode === 'spread' ? pair_start + 2 >= state.pages : state.page >= state.pages));
    for (const [button, label] of [
      [this.previous, vertical ? 'Scroll up one page' : state.mode === 'spread' ? 'Previous two pages' : 'Previous page'],
      [this.next, vertical ? 'Scroll down one page' : state.mode === 'spread' ? 'Next two pages' : 'Next page'],
    ] as const) {
      button.title = label;
      button.setAttribute('aria-label', label);
    }
    this.previous.firstElementChild!.className = `codicon codicon-arrow-circle-${vertical ? 'up' : 'left'}`;
    this.next.firstElementChild!.className = `codicon codicon-arrow-circle-${vertical ? 'down' : 'right'}`;
    this.outline.setAttribute('aria-expanded', String(state.outline_open));
    this.outline.setAttribute('aria-pressed', String(state.outline_open));
    this.page_input.disabled = state.pages === 0;
    this.page_input.max = String(Math.max(1, state.pages));
    if (!this.page_dirty || document.activeElement !== this.page_input) {
      this.page_input.value = String(state.page);
      this.page_dirty = false;
    }
    this.page_count.textContent = `/ ${state.pages}`;
    this.page_count.setAttribute('aria-label', `${state.pages} pages`);
    const zoom = String(state.zoom);
    if (this.custom_zoom?.value !== zoom) {
      this.custom_zoom?.remove();
      this.custom_zoom = undefined;
    }
    if (![...this.zoom_select.options].some(option => option.value === zoom)) {
      this.custom_zoom = new Option(`${Math.round(Number(state.zoom) * 1000) / 10}%`, zoom);
      this.zoom_select.add(this.custom_zoom);
    }
    this.zoom_select.value = zoom;
    for (const [mode, button] of this.modes) button.setAttribute('aria-checked', String(mode === state.mode));
    this.dark.setAttribute('aria-checked', String(state.dark));
  }

  set_visible(visible: boolean): void {
    if (!visible) this.close_menu(false);
  }

  dispose(): void {
    this.events.abort();
    this.menu.remove();
    this.root.remove();
  }

  private button(label: string, symbol: string | undefined, action: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'icon-button';
    button.title = label;
    button.setAttribute('aria-label', label);
    if (symbol) button.append(icon(symbol));
    button.addEventListener('click', action, { signal: this.events.signal });
    return button;
  }

  private zoom_button(label: string, direction: -1 | 0 | 1): HTMLButtonElement {
    const button = this.button(label, undefined, () => this.callbacks.zoom(direction));
    button.innerHTML = preview_zoom_symbol(direction);
    return button;
  }

  private commit_page(): void {
    if (!this.page_dirty || this.page_input.disabled) return;
    this.page_dirty = false;
    const value = this.page_input.valueAsNumber;
    const page = Number.isFinite(value)
      ? Math.max(1, Math.min(this.state.pages, Math.trunc(value))) : this.state.page;
    this.page_input.value = String(page);
    if (page !== this.state.page) this.callbacks.page(page);
  }

  private menu_item(label: string, role: 'menuitemradio' | 'menuitemcheckbox', action: () => void): HTMLButtonElement {
    const button = this.button(label, 'check', () => { this.close_menu(true); action(); });
    button.className = 'pdf-settings-item';
    button.setAttribute('role', role);
    button.tabIndex = -1;
    const text = document.createElement('span');
    text.textContent = label;
    button.append(text);
    return button;
  }

  private toggle_menu(): void {
    if (this.menu.hidden) this.show_menu();
    else this.close_menu(true);
  }

  private show_menu(last = false): void {
    this.menu.hidden = false;
    this.settings.setAttribute('aria-expanded', 'true');
    const anchor = this.settings.getBoundingClientRect();
    const left = Math.max(4, Math.min(anchor.right - this.menu.offsetWidth, window.innerWidth - this.menu.offsetWidth - 4));
    const top = Math.max(4, Math.min(anchor.bottom + 4, window.innerHeight - this.menu.offsetHeight - 4));
    this.menu.style.left = `${left}px`;
    this.menu.style.top = `${top}px`;
    const items = [...this.menu.querySelectorAll<HTMLButtonElement>('button')];
    (last ? items.at(-1) : items[0])?.focus();
  }

  private close_menu(restore_focus: boolean): void {
    if (this.menu.hidden) return;
    this.menu.hidden = true;
    this.settings.setAttribute('aria-expanded', 'false');
    if (restore_focus) this.settings.focus();
  }

  private menu_keydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault();
      event.stopPropagation();
      this.close_menu(true);
      return;
    }
    const items = [...this.menu.querySelectorAll<HTMLButtonElement>('button')];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (event.key === 'ArrowDown') next = (index + 1) % items.length;
    else if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else return;
    event.preventDefault();
    event.stopPropagation();
    items[next]?.focus();
  }
}
