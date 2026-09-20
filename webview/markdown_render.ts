import MarkdownIt from 'markdown-it';
import { footnote } from '@mdit/plugin-footnote';
import { tasklist } from '@mdit/plugin-tasklist';
import { is_markdown_link, type markdown_source } from '../src/markdown_state';
import { install_markdown_math } from './markdown_math';

import { local_document_resource as markdown_image_url } from './document_resources';
export { local_document_resource as markdown_image_url } from './document_resources';

/** Raw HTML remains text. Every generated URL is separately constrained. */
export function render_markdown(source: markdown_source): string {
  const markdown = new MarkdownIt({ html: false, linkify: true, typographer: false, maxNesting: 40 });
  markdown.use(footnote).use(tasklist, { disabled: true, label: false });
  install_markdown_math(markdown);
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
