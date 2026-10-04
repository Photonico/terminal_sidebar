import assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const bundled_svg = build({ entryPoints: [path.join(__dirname, '../webview/svg_preview.ts')],
  bundle: true, write: false, platform: 'browser', format: 'cjs',
}).then(result => result.outputFiles[0].text);

async function parser() {
  const dom = new JSDOM('');
  const module = { exports: {} as typeof import('../webview/svg_preview') };
  runInNewContext(await bundled_svg, { module, exports: module.exports, DOMParser: dom.window.DOMParser, TextEncoder, Blob });
  return { parse: module.exports.svg_image_blob, close: () => dom.window.close() };
}

test('SVG image data preserves gradients, clipping, use references, text and embedded resources', async () => {
  const h = await parser();
  try {
    const text = `<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs>
      <linearGradient id="color"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>
      <clipPath id="clip"><circle id="circle" cx="50" cy="50" r="40"/></clipPath></defs>
      <rect width="100" height="100" fill="url(#color)" clip-path="url(#clip)"/><use href="#circle"/>
      <text x="10" y="50">Unicode 矢量</text><image href="data:image/png;base64,aGVsbG8="/></svg>`;
    assert.equal(await h.parse(text).text(), text);
  } finally { h.close(); }
});

test('SVG image validation rejects malformed XML, other roots, custom entities and oversized UTF-8 files', async () => {
  const h = await parser();
  try {
    for (const text of ['', '<html/>', '<svg/>', '<svg xmlns="http://www.w3.org/2000/svg"><g></svg>']) {
      assert.throws(() => h.parse(text), /could not be parsed/);
    }
    assert.throws(() => h.parse('<!DOCTYPE svg [<!ENTITY x "expanded">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>'), /entity declarations/);
    assert.throws(() => h.parse(`<svg xmlns="http://www.w3.org/2000/svg">${'矢'.repeat(1_500_000)}</svg>`), /4 MiB/);
  } finally { h.close(); }
});
