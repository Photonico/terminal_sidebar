import create_purifier from 'dompurify';
import type { markdown_source } from '../src/markdown_state';
import { is_markdown_link } from '../src/markdown_state';
import { local_document_resource } from './document_resources';

/** Static HTML is isolated in a scriptless iframe; only its own local resources may load. */
export function prepare_html(source: markdown_source): string {
  const purifier = create_purifier(window);
  const safe = purifier.sanitize(source.text, {
    WHOLE_DOCUMENT: true,
    ADD_TAGS: ['link'],
    FORBID_TAGS: ['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'base', 'meta'],
    FORBID_ATTR: ['srcdoc', 'srcset', 'action', 'formaction', 'ping', 'target', 'download'],
  });
  const html = new DOMParser().parseFromString(safe, 'text/html');
  for (const anchor of html.querySelectorAll('a, area')) {
    const href = anchor.getAttribute('href') ?? anchor.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
    anchor.removeAttributeNS('http://www.w3.org/1999/xlink', 'href');
    if (is_markdown_link(href)) anchor.setAttribute('href', href);
    else anchor.removeAttribute('href');
  }
  for (const element of html.querySelectorAll('[src], [href], [poster], [background]')) {
    for (const attribute of ['src', 'href', 'poster', 'background']) {
      const value = element.getAttribute(attribute);
      if (value === null) continue;
      if ((element.localName === 'a' || element.localName === 'area') && attribute === 'href') {
        if (!is_markdown_link(value)) element.removeAttribute(attribute);
        continue;
      }
      if (element.localName === 'link' && element.getAttribute('rel')?.toLowerCase() !== 'stylesheet') {
        element.remove();
        break;
      }
      const resource = local_document_resource(value, source.base_url);
      if (resource) element.setAttribute(attribute, resource);
      else element.removeAttribute(attribute);
    }
  }
  for (const control of html.querySelectorAll('input, select, textarea, button, fieldset')) control.setAttribute('disabled', '');
  // All resource URLs are checked by the browser as well as the sanitizer. The base
  // is ours, never the document's, so stylesheet-relative assets retain their paths.
  const base = new URL(source.base_url);
  if (base.protocol !== 'https:' || !base.pathname.endsWith('/') || base.search || base.hash || base.username || base.password) {
    throw new Error('Invalid preview resource root');
  }
  // VS Code resource hosts encode the original URI scheme with '+', which URL
  // accepts but CSP host-source syntax does not. Match only VS Code's resource
  // domain, retaining the complete directory restriction and exact resource URLs.
  // A CSP source expression is not a URL: Chromium percent-encodes '*' in URL.host.
  const policy_source = base.hostname.endsWith('.vscode-resource.vscode-cdn.net')
    ? `https://*.vscode-resource.vscode-cdn.net${base.port ? `:${base.port}` : ''}${base.pathname}`
    : base.href;
  const resource_root = policy_source.replace(/'/g, '%27');
  const policy = html.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = `default-src 'none'; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri ${resource_root}; img-src ${resource_root}; font-src ${resource_root}; media-src ${resource_root}; style-src ${resource_root} 'unsafe-inline';`;
  const resource_base = html.createElement('base');
  resource_base.href = base.href;
  const charset = html.createElement('meta');
  charset.setAttribute('charset', 'UTF-8');
  const viewport = html.createElement('meta');
  viewport.name = 'viewport';
  viewport.content = 'width=device-width,initial-scale=1';
  const search_style = html.createElement('style');
  search_style.textContent = `::highlight(sidebar_document_find_all) { background: Highlight; color: HighlightText; }
::highlight(sidebar_document_find) { background: Highlight; color: HighlightText; text-decoration: underline; }`;
  html.head.prepend(charset, policy, resource_base, viewport, search_style);
  return '<!DOCTYPE html>\n' + html.documentElement.outerHTML;
}

/** Read body text consistently in the visible reader and the inert global-search copy. */
export function html_search_text(root: HTMLElement): string {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest('style, script, template, noscript')) text += node.textContent ?? '';
  }
  return text;
}
