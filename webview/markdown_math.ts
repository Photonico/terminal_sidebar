import type { MarkdownIt } from 'markdown-it';
import { tex } from '@mdit/plugin-tex';
import { renderToString } from 'katex';

// Bound work before entering the TeX parser. Excess or invalid formulas remain readable.
const max_expression_length = 16_384;
const max_document_math_length = 65_536;
const max_document_expressions = 512;

/** KaTeX runs without document-defined HTML, external resources, or shared macros. */
export function install_markdown_math(markdown: MarkdownIt): void {
  let expression_count = 0;
  let document_math_length = 0;
  markdown.use(tex, {
    delimiters: 'all',
    mathFence: true,
    render: (content: string, display_mode: boolean): string => {
      const tag = display_mode ? 'div' : 'span';
      const source = markdown.utils.escapeHtml(content.trim());
      const fallback = () => `<${tag} class="markdown_math_error" title="Formula could not be rendered">${source}</${tag}>`;
      expression_count++;
      document_math_length += content.length;
      if (content.length > max_expression_length || document_math_length > max_document_math_length
        || expression_count > max_document_expressions) return fallback();
      try {
        const output = renderToString(content, {
          displayMode: display_mode,
          output: 'html',
          trust: false,
          throwOnError: true,
          strict: 'ignore',
          errorColor: 'var(--vscode-errorForeground)',
          maxExpand: 1_000,
          maxSize: 20,
          macros: {},
        });
        // HTML-only output avoids indexing the same formula three times through HTML,
        // MathML and the source annotation. The wrapper supplies its accessible name.
        return `<${tag} class="markdown_math${display_mode ? ' markdown_math_display' : ''}" role="math" aria-label="${source}">${output}</${tag}>`;
      } catch {
        return fallback();
      }
    },
  });
}
