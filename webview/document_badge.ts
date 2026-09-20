import './document_badge.css';

/** Shared preview identity; formats without a Codicon use their extension. */
export function create_document_badge(format: string): HTMLSpanElement {
  const extension = format.trim().replace(/^\./, '').toLowerCase();
  const markdown = extension === 'md' || extension === 'markdown';
  const label = markdown ? 'Markdown' : extension.toUpperCase() || 'FILE';
  const badge = document.createElement('span');
  badge.className = 'document-badge';
  badge.title = `${label} document`;
  badge.setAttribute('role', 'img');
  badge.setAttribute('aria-label', badge.title);
  if (extension === 'pdf' || markdown) {
    const icon = document.createElement('span');
    icon.className = `codicon codicon-${markdown ? 'markdown' : 'file-pdf'}`;
    icon.setAttribute('aria-hidden', 'true');
    badge.append(icon);
  } else {
    badge.classList.add('document-badge-extension');
    badge.textContent = label;
  }
  return badge;
}
