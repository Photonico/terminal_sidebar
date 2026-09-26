import { create_document_badge } from './document_badge';
import { preview_button, preview_zoom_symbol } from './preview_controls';
import './reading_toolbar.css';

export interface reading_action { label: string; icon: string; run(anchor: HTMLButtonElement): void }
interface reading_callbacks {
  move(direction: -1 | 1): void;
  zoom(value: number, previous: number): void;
  height(): number;
}

/** Controls for continuously scrolling documents; pagination remains PDF-only. */
export class reading_toolbar {
  readonly root = document.createElement('div');
  readonly outline = document.createElement('nav');
  private readonly events = new AbortController();
  private readonly outline_button?: HTMLButtonElement;
  private readonly zoom_select = document.createElement('select');
  private custom_zoom?: HTMLOptionElement;
  private zoom = 1;
  private disposed = false;

  constructor(format: string, private readonly callbacks: reading_callbacks, actions: reading_action[]) {
    this.root.className = 'reading-toolbar preview-toolbar';
    this.root.setAttribute('role', 'toolbar');
    this.root.setAttribute('aria-label', `${format.toUpperCase()} navigation`);
    const left = document.createElement('div');
    left.className = 'preview-toolbar-left';
    left.append(create_document_badge(format));
    if (format === 'markdown' || format === 'html') {
      this.outline_button = this.button('Toggle document outline', 'symbol-keyword', () => this.set_outline(this.outline.hidden));
      this.outline_button.disabled = true;
      this.outline_button.setAttribute('aria-expanded', 'false');
      left.append(this.outline_button);
    }
    left.append(this.button('Scroll up one page', 'arrow-circle-up', () => callbacks.move(-1)),
      this.button('Scroll down one page', 'arrow-circle-down', () => callbacks.move(1)));
    for (const [direction, label] of [[1, 'Zoom in'], [0, 'Actual size (100%)'], [-1, 'Zoom out']] as const) {
      const button = this.button(label, undefined, () => this.change_zoom(direction));
      button.innerHTML = preview_zoom_symbol(direction);
      left.append(button);
    }
    const right = document.createElement('div');
    right.className = 'preview-toolbar-right';
    const zoom_control = document.createElement('span');
    zoom_control.className = 'preview-zoom-control preview-control';
    this.zoom_select.title = 'Zoom';
    this.zoom_select.setAttribute('aria-label', 'Zoom');
    for (const value of [25, 50, 75, 100, 125, 150, 200, 300, 400]) {
      const option = document.createElement('option');
      option.textContent = `${value}%`; option.value = String(value / 100);
      this.zoom_select.add(option);
    }
    this.zoom_select.value = '1';
    this.zoom_select.addEventListener('change', () => this.set_zoom(Number(this.zoom_select.value)), { signal: this.events.signal });
    const chevron = document.createElement('span');
    chevron.className = 'codicon codicon-chevron-down';
    chevron.setAttribute('aria-hidden', 'true');
    zoom_control.append(this.zoom_select, chevron);
    right.append(zoom_control, ...actions.map(action => {
      const button = this.button(action.label, action.icon, () => action.run(button));
      return button;
    }));
    this.root.append(left, right);
    this.outline.className = 'reading-outline preview-outline';
    this.outline.setAttribute('aria-label', 'Document outline');
    this.outline.hidden = true;
    this.outline.addEventListener('keydown', event => {
      if (event.isComposing || event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation();
      this.set_outline(false);
      this.outline_button?.focus();
    }, { signal: this.events.signal });
  }

  /** The floating outline stays open while navigating; its button or Escape closes it. */
  private set_outline(open: boolean): void {
    if (!this.outline_button) return;
    this.outline.hidden = !open;
    this.outline_button.setAttribute('aria-expanded', String(open));
    this.outline_button.setAttribute('aria-pressed', String(open));
  }

  private button(label: string, symbol: string | undefined, action: () => void): HTMLButtonElement {
    return preview_button(label, symbol, action, this.events.signal);
  }

  /** Rebuild references after refresh, without leaving listeners on old headings. */
  set_content(root: HTMLElement): void {
    if (this.disposed) return;
    this.outline.replaceChildren();
    if (this.outline_button) {
      const headings = [...root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')].slice(0, 1000);
      this.outline_button.disabled = !headings.length;
      if (!headings.length) this.set_outline(false);
      for (const heading of headings) {
        const label = heading.textContent?.trim() || 'Untitled section';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'reading-outline-item';
        button.textContent = label;
        button.title = `Go to ${label}`;
        button.setAttribute('aria-label', button.title);
        button.style.paddingInlineStart = `${8 + (Number(heading.tagName.slice(1)) - 1) * 12}px`;
        button.addEventListener('click', () => heading.scrollIntoView({ block: 'start' }));
        this.outline.append(button);
      }
    }
    this.callbacks.zoom(this.zoom, this.zoom);
  }

  private change_zoom(direction: -1 | 0 | 1): void {
    this.set_zoom(direction === 0 ? 1 : Math.round(this.zoom * (direction > 0 ? 1.2 : 1 / 1.2) * 100) / 100);
  }

  private set_zoom(value: number): void {
    if (this.disposed || !Number.isFinite(value)) return;
    const previous = this.zoom;
    this.zoom = Math.max(0.25, Math.min(4, value));
    this.custom_zoom?.remove(); this.custom_zoom = undefined;
    const selected = String(this.zoom);
    if (![...this.zoom_select.options].some(option => option.value === selected)) {
      this.custom_zoom = document.createElement('option');
      this.custom_zoom.value = selected;
      this.custom_zoom.textContent = `${Math.round(this.zoom * 1000) / 10}%`;
      this.zoom_select.add(this.custom_zoom);
    }
    this.zoom_select.value = selected;
    if (this.zoom !== previous) this.callbacks.zoom(this.zoom, previous);
  }

  keydown(event: KeyboardEvent): boolean {
    if (!this.disposed && !event.isComposing && event.key === 'Escape' && !this.outline.hidden) {
      this.set_outline(false);
      event.preventDefault(); event.stopPropagation();
      return true;
    }
    if (this.disposed || event.isComposing || event.altKey || (!event.metaKey && !event.ctrlKey)
      || !['+', '=', '-', '0'].includes(event.key)) return false;
    this.change_zoom(event.key === '0' ? 0 : event.key === '-' ? -1 : 1);
    event.preventDefault(); event.stopPropagation();
    return true;
  }

  wheel(event: WheelEvent): void {
    if (this.disposed || (!event.metaKey && !event.ctrlKey) || event.altKey || !Number.isFinite(event.deltaY)) return;
    event.preventDefault(); event.stopPropagation();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.callbacks.height() : 1);
    this.set_zoom(Math.round(this.zoom * Math.exp(-Math.max(-500, Math.min(500, delta)) * 0.002) * 1000) / 1000);
  }

  dispose(): void {
    this.disposed = true;
    this.events.abort();
    this.outline.replaceChildren();
    this.outline.remove(); this.root.remove();
  }
}
