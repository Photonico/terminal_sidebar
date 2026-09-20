import assert from 'node:assert/strict';
import * as path from 'node:path';
import { runInNewContext as run_in_new_context } from 'node:vm';
import test from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import type { hydrate_html_resources, html_resource_options } from '../webview/html_resources';

const base_url = 'https://file+.vscode-resource.vscode-cdn.net/work/paper/';
const bundled = build({ entryPoints: [path.resolve(__dirname, '../webview/html_resources.ts')], bundle: true,
  write: false, platform: 'browser', format: 'cjs' }).then(result => result.outputFiles[0].text);
const decode_data = (value: string) => Buffer.from(value.slice(value.indexOf(',') + 1).split('#')[0], 'base64').toString('utf8');

async function harness(files: Record<string, string> = {}) {
  const dom = new JSDOM('', { url: base_url });
  const module = { exports: {} as { hydrate_html_resources: typeof hydrate_html_resources } };
  const requests: string[] = [];
  const request: typeof fetch = async (input, options) => {
    const url = String(input);
    requests.push(url);
    assert.equal(options?.credentials, 'omit');
    assert.equal(options?.redirect, 'error');
    assert.equal(options?.referrerPolicy, 'no-referrer');
    const text = files[url.slice(base_url.length)];
    return new Response(text ?? 'Missing', { status: text === undefined ? 404 : 200 });
  };
  run_in_new_context(await bundled, { module, exports: module.exports, window: dom.window, document: dom.window.document,
    DOMParser: dom.window.DOMParser, URL, AbortController, TextEncoder, TextDecoder, Uint8Array, setTimeout, clearTimeout,
    btoa: (text: string) => Buffer.from(text, 'latin1').toString('base64') });
  const render = async (text: string, options: html_resource_options = {}) => {
    const result = await module.exports.hydrate_html_resources({ text, base_url }, { fetch: request, ...options });
    return { ...result, document: new dom.window.DOMParser().parseFromString(result.html, 'text/html') };
  };
  return { render, requests, close: () => dom.window.close() };
}

test('HTML parent hydration resolves nested CSS, sibling images, fonts and inline styles', async () => {
  const h = await harness({
    'styles/main.css': '@import "nested/theme.css" screen; .picture{background:url(../images/logo.png)}',
    'styles/nested/theme.css': '@font-face{font-family:demo;src:url(../../fonts/demo.woff2)}p{color:teal}',
    'images/logo.png': 'image bytes', 'fonts/demo.woff2': 'font bytes',
  });
  try {
    const result = await h.render('<link rel="STYLESHEET" href="styles/main.css"><img src="images/logo.png"><p style="background:url(images/logo.png)">Text</p>');
    assert.equal(result.warnings.length, 0);
    const css = decode_data(result.document.querySelector('link')!.getAttribute('href')!);
    assert.match(css, /@import "data:text\/css;base64,/);
    assert.match(css, /background:url\(data:image\/png;base64,/);
    const imported = /@import "([^"]+)"/.exec(css)![1];
    assert.match(decode_data(imported), /src:url\(data:font\/woff2;base64,/);
    assert.match(result.document.querySelector('img')!.getAttribute('src')!, /^data:image\/png;base64,/);
    assert.match(result.document.querySelector('p')!.getAttribute('style')!, /data:image\/png;base64,/);
    assert.equal(h.requests.filter(url => url.endsWith('/images/logo.png')).length, 1, 'Shared asset bytes are fetched once');
    assert.equal(result.document.querySelector('base'), null);
    const policy = result.document.querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy"]')!.content;
    assert.match(policy, /connect-src 'none';/);
    assert.match(policy, /script-src 'none';/);
    assert.match(policy, /frame-src 'none';/);
    assert.match(policy, /style-src data: 'unsafe-inline';/);
    assert.doesNotMatch(policy, /https:|vscode-resource/);
  } finally { h.close(); }
});

test('HTML hydration never fetches remote, encoded traversal, script or author data resources', async () => {
  const h = await harness();
  try {
    const result = await h.render(`<style>@import "https://evil.example/a.css";p{background:url(assets%2f..%2f..%2fsecret.png)}
      i{background:url(data:image/png;base64,AAAA)} b{background:url(../secret.png)}</style>
      <img src="https://evil.example/track.png"><script src="run.js"></script>`);
    assert.equal(h.requests.length, 0);
    assert.ok(result.warnings.length > 0);
    assert.equal(result.document.querySelector('script'), null);
    assert.equal(result.document.querySelector('img')?.hasAttribute('src'), false);
    assert.doesNotMatch(result.document.querySelector('style:last-of-type')?.textContent ?? '', /evil|secret|base64,AAAA/);
  } finally { h.close(); }
});

test('HTML CSS parsing covers escaped URLs, image-set strings and custom properties', async () => {
  const h = await harness({ 'images/a.png': 'image' });
  try {
    const result = await h.render('<style>p{--picture:url("images/a.png");background:image-set("images/a.png" 1x);mask:url("images/\\61.png")}</style>');
    assert.equal(h.requests.length, 1);
    const css = result.document.querySelector('style:last-of-type')?.textContent ?? '';
    assert.equal((css.match(/data:image\/png;base64,/g) ?? []).length, 3);
    assert.equal(result.warnings.length, 0);
  } finally { h.close(); }
});

test('HTML CSS cycles and import depth cannot keep resources loading indefinitely', async () => {
  const h = await harness({
    'a.css': '@import "b.css";a{color:red}',
    'b.css': '@import "a.css";@import "c.css";b{color:blue}',
    'c.css': 'c{color:green}',
  });
  try {
    const result = await h.render('<link rel="stylesheet" href="a.css">', { limits: { max_depth: 1 } });
    assert.deepEqual(h.requests, [`${base_url}a.css`, `${base_url}b.css`]);
    assert.ok(result.warnings.some(warning => /Nested or circular/.test(warning)));
    const css = decode_data(result.document.querySelector('link')!.getAttribute('href')!);
    assert.match(css, /a\{color:red\}/);
    const nested = /@import "([^"]+)"/.exec(css)![1];
    assert.equal(decode_data(nested), 'b{color:blue}');
  } finally { h.close(); }
});

test('HTML hydration enforces byte/resource limits and omits failures without losing the page', async () => {
  const h = await harness({ 'big.png': 'a'.repeat(64), 'small.png': 'b', 'extra.png': 'c', 'fake.html': '<script>bad</script>' });
  try {
    const result = await h.render('<h1>Kept</h1><img src="big.png"><img src="small.png"><img src="extra.png"><img src="fake.html">', {
      limits: { max_bytes: 32, max_resources: 2 },
    });
    assert.equal(h.requests.length, 2);
    assert.equal(result.document.querySelector('h1')?.textContent, 'Kept');
    assert.equal(result.document.querySelectorAll('img[src]').length, 0);
    assert.ok(result.warnings.some(warning => /byte limit/.test(warning)));
    assert.ok(result.warnings.some(warning => /loading budget/.test(warning)));
    const unsupported = await h.render('<img src="fake.html">');
    assert.equal(unsupported.document.querySelector('img')?.hasAttribute('src'), false);
    assert.ok(unsupported.warnings.some(warning => /unsupported/.test(warning)));
  } finally { h.close(); }
});

test('HTML parent resource requests abort on cancellation and time out with a partial preview', async () => {
  const h = await harness();
  const request: typeof fetch = (_input, options) => new Promise((_resolve, reject) => {
    const fail = () => reject(new DOMException('Aborted', 'AbortError'));
    if (options?.signal?.aborted) fail(); else options?.signal?.addEventListener('abort', fail, { once: true });
  });
  try {
    const controller = new AbortController();
    const pending = h.render('<link rel="stylesheet" href="theme.css">', { signal: controller.signal, fetch: request });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    const timed = await h.render('<h1>Retained</h1><link rel="stylesheet" href="theme.css">', { fetch: request, limits: { timeout_ms: 20 } });
    assert.equal(timed.document.querySelector('h1')?.textContent, 'Retained');
    assert.equal(timed.document.querySelector('link'), null);
    assert.ok(timed.warnings.some(warning => /time limit/.test(warning)));
  } finally { h.close(); }
});

test('HTML SVG assets are static sanitized images and large CSS does not enter the parser', async () => {
  const h = await harness({
    'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><foreignObject><p>bad</p></foreignObject><animate/><image href="https://evil.example/a.png"/><path fill="red" d="M0 0h10v10z"/></svg>',
    'large.css': 'p{color:red}'.repeat(50_000),
  });
  try {
    const result = await h.render('<img src="icon.svg"><link rel="stylesheet" href="large.css">');
    const svg = decode_data(result.document.querySelector('img')!.getAttribute('src')!);
    assert.match(svg, /<path/);
    assert.doesNotMatch(svg, /script|foreignObject|animate|onload|evil/);
    assert.equal(result.document.querySelector('link'), null);
    assert.ok(result.warnings.some(warning => /oversized stylesheet/.test(warning)));
  } finally { h.close(); }
});
