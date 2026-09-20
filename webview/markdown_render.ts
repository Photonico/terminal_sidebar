import MarkdownIt from 'markdown-it';
import { is_markdown_link, type markdown_source } from '../src/markdown_state';

/** Images can only read descendants of the selected document's resource root. */
export function markdown_image_url(value: string, base_url: string): string | undefined {
  if (!value || /[\x00-\x20\x7f\\]/.test(value) || /^[a-z][a-z\d+.-]*:/i.test(value)
    || value.startsWith('/')) return undefined;
  try {
    const base = new URL(base_url);
    const image = new URL(value, base);
    if (!base.pathname.endsWith('/') || image.origin !== base.origin || image.protocol !== base.protocol
      || image.host !== base.host || !image.pathname.startsWith(base.pathname) || image.search) return undefined;
    // Encoded path separators must not bypass the subtree check at the resource server.
    const decoded = decodeURIComponent(image.pathname);
    if (/[\x00-\x1f\x7f\\]/.test(decoded) || decoded.split('/').some(part => part === '..')) return undefined;
    return image.toString();
  } catch { return undefined; }
}

/** Raw HTML remains text. Every generated URL is separately constrained. */
export function render_markdown(source: markdown_source): string {
  const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false, maxNesting: 40 });
  markdown.validateLink = is_markdown_link;
  const default_image = markdown.renderer.rules.image!;
  markdown.renderer.rules.image = (tokens, index, options, environment, renderer) => {
    const token = tokens[index];
    const url = markdown_image_url(String(token.attrGet('src') ?? ''), source.base_url);
    if (!url) return `<span class="markdown-image-unavailable">${markdown.utils.escapeHtml(token.content || 'Image unavailable')}</span>`;
    token.attrSet('src', url);
    token.attrSet('loading', 'lazy');
    return default_image(tokens, index, options, environment, renderer);
  };
  const heading_ids = new Map<string, number>();
  markdown.renderer.rules.heading_open = (tokens, index, options, _environment, renderer) => {
    const label = tokens[index + 1]?.content ?? '';
    const slug = label.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-') || 'section';
    const count = heading_ids.get(slug) ?? 0;
    heading_ids.set(slug, count + 1);
    tokens[index].attrSet('id', count ? `${slug}-${count}` : slug);
    return renderer.renderToken(tokens, index, options);
  };
  return markdown.render(source.text);
}
