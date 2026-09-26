import './preview_controls.css';

/** A fixed 14px ring matches the arrow-circle Codicons in a 16px icon box. */
export function preview_zoom_symbol(direction: -1 | 0 | 1): string {
  const path = direction === 0 ? 'M6.5 5.5 8 4.5V11.5M6.5 11.5h3'
    : direction === 1 ? 'M5 8h6M8 5v6' : 'M5 8h6';
  return `<svg class="preview-zoom-symbol" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5"/><path d="${path}"/></svg>`;
}

export function preview_button(label: string, symbol: string | undefined, action: () => void,
  signal?: AbortSignal): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-button';
  button.title = label;
  button.setAttribute('aria-label', label);
  if (symbol) {
    const icon = document.createElement('span');
    icon.className = `codicon codicon-${symbol}`;
    icon.setAttribute('aria-hidden', 'true');
    button.append(icon);
  }
  button.addEventListener('click', action, { signal });
  return button;
}

const float_gap = 6;

/** Floats a preview's toolbar and notice over its document. The pane publishes the height they cover
 * as --preview_float_space, so documents start below the toolbar and scroll beneath it. */
export class preview_overlay {
  readonly root = document.createElement('div');
  space = 0;
  private readonly observer?: ResizeObserver;

  constructor(private readonly pane: HTMLElement, viewport: HTMLElement, children: HTMLElement[],
    scroller: () => Pick<HTMLElement, 'scrollBy'>, private readonly changed: () => void = () => {}) {
    this.root.className = 'preview-float';
    this.root.append(...children);
    // The toolbar covers the document, so wheel input over it still scrolls or zooms what lies beneath.
    this.root.addEventListener('wheel', event => {
      const forwarded = new WheelEvent('wheel', { deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode,
        ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, altKey: event.altKey, cancelable: true });
      viewport.dispatchEvent(forwarded);
      event.preventDefault();
      if (forwarded.defaultPrevented) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
      scroller().scrollBy({ left: event.deltaX * unit, top: event.deltaY * unit });
    }, { passive: false });
    if (typeof ResizeObserver === 'function') {
      this.observer = new ResizeObserver(() => this.measure());
      this.observer.observe(this.root);
    }
  }

  private measure(): void {
    const height = this.root.offsetHeight;
    if (!height) return; // A hidden pane keeps the space it last had.
    const space = Math.ceil(this.root.offsetTop + height + float_gap);
    if (space === this.space) return;
    this.space = space;
    this.pane.style.setProperty('--preview_float_space', `${space}px`);
    this.changed();
  }

  dispose(): void {
    this.observer?.disconnect();
    this.root.remove();
  }
}
