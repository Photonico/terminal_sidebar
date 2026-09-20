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
