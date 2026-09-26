import assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist';

const bundle = (entry: string) => build({ entryPoints: [path.resolve(__dirname, `../webview/${entry}.ts`)],
  bundle: true, write: false, platform: 'browser', format: 'cjs', loader: { '.css': 'empty' },
}).then(result => result.outputFiles[0].text);
const bundled_links = bundle('pdf_links');
const bundled_destination = bundle('pdf_destination');

async function load<exports>(source: Promise<string>, dom?: JSDOM): Promise<exports> {
  const module = { exports: {} as exports };
  runInNewContext(await source, { module, exports: module.exports, URL, ...(dom ? { document: dom.window.document } : {}) });
  return module.exports;
}

function document_proxy(destinations: Record<string, unknown>, pages = 20): PDFDocumentProxy {
  return {
    numPages: pages,
    getDestination: async (name: string) => destinations[name] ?? null,
    getPageIndex: async (reference: { num: number }) => {
      if (reference.num === 99) throw new Error('missing reference');
      return reference.num - 1;
    },
  } as unknown as PDFDocumentProxy;
}

test('named and explicit destinations resolve to a one-based page and the point the link names', async () => {
  const { resolve_destination } = await load<typeof import('../webview/pdf_destination')>(bundled_destination);
  const pdf = document_proxy({
    'section.2': [{ num: 5, gen: 0 }, { name: 'XYZ' }, 72, 540, null],
    'figure.3': [{ num: 7, gen: 0 }, { name: 'FitH' }, 300],
    region: [{ num: 8, gen: 0 }, { name: 'FitR' }, 10, 20, 30, 400],
    whole: [{ num: 9, gen: 0 }, { name: 'Fit' }],
    unknown_top: [{ num: 3, gen: 0 }, { name: 'XYZ' }, null, null, 0],
    missing: [{ num: 99, gen: 0 }, { name: 'Fit' }],
    far: [{ num: 21, gen: 0 }, { name: 'Fit' }],
  });
  const resolve = async (destination: unknown) => JSON.stringify(await resolve_destination(pdf, destination));
  assert.equal(await resolve('section.2'), JSON.stringify({ page: 5, left: 72, top: 540 }));
  assert.equal(await resolve('figure.3'), JSON.stringify({ page: 7, top: 300 }));
  assert.equal(await resolve('region'), JSON.stringify({ page: 8, left: 10, top: 400 }));
  assert.equal(await resolve('whole'), JSON.stringify({ page: 9 }));
  assert.equal(await resolve('unknown_top'), JSON.stringify({ page: 3 }), 'Null coordinates keep the page top');
  assert.equal(await resolve([2, { name: 'XYZ' }, 0, 700, 0]), JSON.stringify({ page: 3, left: 0, top: 700 }), 'A numeric reference is a page index');
  for (const destination of ['not-there', '', 'x'.repeat(9000), [], [{ num: 0, gen: 0 }], [-1], 'far', { dest: 1 }]) {
    assert.equal(await resolve(destination), undefined, `rejects ${JSON.stringify(destination).slice(0, 40)}`);
  }
  await assert.rejects(resolve_destination(pdf, 'missing'), /missing reference/, 'Worker failures reach the caller, which ignores them');
});

async function link_fixture(annotations: unknown) {
  const dom = new JSDOM('<!doctype html><body><div id="page"></div></body>');
  const { render_pdf_links } = await load<typeof import('../webview/pdf_links')>(bundled_links, dom);
  const calls: Array<[string, unknown]> = [];
  const page = { getAnnotations: async () => annotations } as unknown as PDFPageProxy;
  // A 2x scaled, 600x800 page: PDF y grows upwards from the bottom edge.
  const viewport = { convertToViewportPoint: (x: number, y: number) => [x * 2, (800 - y) * 2] } as unknown as PageViewport;
  const layer = await render_pdf_links(page, viewport, {
    destination: destination => calls.push(['destination', destination]),
    describe: async destination => destination === 'chapter.1' ? 'Go to page 4' : undefined,
    named: action => calls.push(['named', action]),
    open: href => calls.push(['open', href]),
  });
  if (layer) dom.window.document.getElementById('page')!.append(layer);
  const links = [...(layer?.children ?? [])] as HTMLAnchorElement[];
  const click = (link: Element) => {
    const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
    let reached_window = false;
    const listener = () => { reached_window = true; };
    dom.window.addEventListener('click', listener);
    link.dispatchEvent(event);
    dom.window.removeEventListener('click', listener);
    return { prevented: event.defaultPrevented, reached_window };
  };
  return { dom, layer, links, calls, click };
}

test('link annotations become positioned link areas: web links stay native, others are handled here', async () => {
  const h = await link_fixture([
    { annotationType: 2, rect: [100, 700, 200, 720], url: 'https://example.com/paper', unsafeUrl: 'https://example.com/paper' },
    { annotationType: 2, rect: [50, 100, 80, 110], dest: 'chapter.1' },
    { annotationType: 2, rect: [10, 10, 20, 20], dest: [{ num: 3, gen: 0 }, { name: 'Fit' }] },
    { annotationType: 2, rect: [10, 30, 20, 40], action: 'NextPage' },
    { annotationType: 2, rect: [10, 50, 20, 60], unsafeUrl: 'appendix.pdf#results' },
    { annotationType: 2, rect: [10, 70, 20, 80], url: 'mailto:author@example.com' },
  ]);
  assert.equal(h.layer?.className, 'pdf-link-layer');
  assert.equal(h.links.length, 6);
  const [web, named, explicit, next, file, mail] = h.links;
  assert.deepEqual([web.style.left, web.style.top, web.style.width, web.style.height], ['200px', '160px', '200px', '40px'],
    'PDF rectangles map through the page viewport, with y measured from the top');
  assert.equal(web.getAttribute('href'), 'https://example.com/paper');
  assert.equal(web.title, 'https://example.com/paper');
  assert.equal(web.tabIndex, -1);
  assert.equal(web.draggable, false);
  const web_click = h.click(web);
  assert.equal(web_click.prevented, false, 'The webview host opens web links itself');
  assert.equal(web_click.reached_window, true, 'VS Code listens for link clicks on the window');
  assert.equal(mail.getAttribute('href'), 'mailto:author@example.com');
  for (const link of [named, explicit, next, file]) {
    assert.equal(link.hasAttribute('href'), false, 'Internal links never navigate the webview');
    assert.equal(link.getAttribute('role'), 'link');
    const result = h.click(link);
    assert.equal(result.prevented, true);
    assert.equal(result.reached_window, false, 'The webview host does not also handle internal links');
  }
  assert.deepEqual(h.calls.map(([kind, value]) => [kind, JSON.stringify(value)]), [
    ['destination', '"chapter.1"'], ['destination', JSON.stringify([{ num: 3, gen: 0 }, { name: 'Fit' }])],
    ['named', '"NextPage"'], ['open', '"appendix.pdf#results"'],
  ]);
  assert.equal(next.title, 'Next page');
  assert.equal(file.title, 'Open appendix.pdf#results');
  assert.equal(named.title, 'Go to linked location');
  named.dispatchEvent(new h.dom.window.Event('pointerenter'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(named.title, 'Go to page 4', 'Hover resolves the destination page lazily');
});

test('unsafe, unsupported and malformed annotations create no link areas', async () => {
  const h = await link_fixture([
    { annotationType: 2, rect: [0, 0, 10, 10], unsafeUrl: 'javascript:alert(1)' },
    { annotationType: 2, rect: [0, 0, 10, 10], url: 'https://user:secret@example.com/' },
    { annotationType: 2, rect: [0, 0, 10, 10], unsafeUrl: 'command:workbench.action.closeWindow' },
    { annotationType: 2, rect: [0, 0, 10, 10], action: 'GoBack' },
    { annotationType: 2, rect: [0, 0, 10, 10], url: 'ftp://example.com/file' },
    { annotationType: 2, rect: [0, 0, 0, 10], dest: 'zero-width' },
    { annotationType: 2, rect: [0, 0, Infinity, 10], dest: 'infinite' },
    { annotationType: 2, rect: [0, 0, 10], dest: 'short' },
    { annotationType: 1, rect: [0, 0, 10, 10], dest: 'text-annotation' },
    null, 'text',
  ]);
  assert.equal(h.layer, undefined);
  const failing = { getAnnotations: async () => { throw new Error('worker gone'); } } as unknown as PDFPageProxy;
  const { render_pdf_links } = await load<typeof import('../webview/pdf_links')>(bundled_links, h.dom);
  assert.equal(await render_pdf_links(failing, {} as PageViewport, {} as never), undefined, 'Links never break page rendering');
  const many = await link_fixture(Array.from({ length: 1500 }, () => ({ annotationType: 2, rect: [0, 0, 10, 10], dest: 'x' })));
  assert.equal(many.links.length, 1000, 'Link areas per page are bounded');
});
