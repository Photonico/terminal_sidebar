import type { PageViewport, PDFPageProxy } from 'pdfjs-dist';
import { is_markdown_link } from '../src/markdown_state';
import './pdf_links.css';

const link_annotation = 2; // pdf.js AnnotationType.LINK
const maximum_links = 1000;
const named_labels: Record<string, string> = {
  NextPage: 'Next page', PrevPage: 'Previous page', FirstPage: 'First page', LastPage: 'Last page',
};

type pdf_link =
  | { kind: 'web'; href: string }
  | { kind: 'destination'; destination: string | unknown[] }
  | { kind: 'named'; action: string }
  | { kind: 'file'; href: string };

export interface pdf_link_actions {
  destination(destination: string | unknown[]): void;
  /** A hover description such as "Go to page 12", resolved only when the pointer reaches the link. */
  describe(destination: string | unknown[]): Promise<string | undefined>;
  named(action: string): void;
  /** A document beside the PDF, resolved by the extension host like other preview links. */
  open(href: string): void;
}

function web_href(value: string): string | undefined {
  if (value.length > 8192 || /[\x00-\x20\x7f]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === 'mailto:') return url.href;
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname && !url.username && !url.password
      ? url.href : undefined;
  } catch { return undefined; }
}

function classify(annotation: Record<string, unknown>): pdf_link | undefined {
  const web = typeof annotation.url === 'string' ? web_href(annotation.url) : undefined;
  if (web) return { kind: 'web', href: web };
  const destination = annotation.dest;
  if ((typeof destination === 'string' && destination.length > 0 && destination.length <= 8192) || Array.isArray(destination)) {
    return { kind: 'destination', destination };
  }
  if (typeof annotation.action === 'string' && Object.hasOwn(named_labels, annotation.action)) {
    return { kind: 'named', action: annotation.action };
  }
  // pdf.js keeps relative file actions only as unsafeUrl; the host accepts paths beside the PDF.
  const unsafe = annotation.unsafeUrl;
  if (typeof unsafe === 'string' && is_markdown_link(unsafe) && (!/^[a-z][a-z\d+.-]*:/i.test(unsafe) || /^file:/i.test(unsafe))) {
    return { kind: 'file', href: unsafe };
  }
  return undefined;
}

/** Transparent link areas over one rendered page. Web links remain real anchors so the VS Code webview opens
 * them itself (without a trust prompt in trusted workspaces); other links are handled here and stop there. */
export async function render_pdf_links(page: PDFPageProxy, viewport: PageViewport,
  actions: pdf_link_actions): Promise<HTMLDivElement | undefined> {
  let annotations: unknown;
  try { annotations = await page.getAnnotations({ intent: 'display' }); } catch { return undefined; }
  if (!Array.isArray(annotations)) return undefined;
  const layer = document.createElement('div');
  layer.className = 'pdf-link-layer';
  for (const annotation of annotations) {
    if (layer.childElementCount >= maximum_links) break;
    if (!annotation || typeof annotation !== 'object' || annotation.annotationType !== link_annotation) continue;
    const link = classify(annotation as Record<string, unknown>);
    const rect: unknown = annotation.rect;
    if (!link || !Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite)) continue;
    const [x1, y1] = viewport.convertToViewportPoint(rect[0], rect[1]) as number[];
    const [x2, y2] = viewport.convertToViewportPoint(rect[2], rect[3]) as number[];
    const [left, top, width, height] = [Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)];
    if (!Number.isFinite(left + top + width + height) || width < 1 || height < 1) continue;
    const anchor = document.createElement('a');
    anchor.className = 'pdf-link';
    Object.assign(anchor.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
    anchor.tabIndex = -1;
    anchor.draggable = false;
    if (link.kind === 'web') {
      anchor.href = link.href;
      anchor.rel = 'noreferrer';
      anchor.title = link.href;
    } else {
      anchor.setAttribute('role', 'link');
      anchor.title = link.kind === 'file' ? `Open ${link.href}` : link.kind === 'named' ? named_labels[link.action] : 'Go to linked location';
      anchor.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        if (link.kind === 'destination') actions.destination(link.destination);
        else if (link.kind === 'named') actions.named(link.action);
        else actions.open(link.href);
      });
      if (link.kind === 'destination') {
        anchor.addEventListener('pointerenter', () => {
          void actions.describe(link.destination).then(label => { if (label) anchor.title = label; }, () => undefined);
        }, { once: true });
      }
    }
    layer.append(anchor);
  }
  return layer.childElementCount ? layer : undefined;
}
