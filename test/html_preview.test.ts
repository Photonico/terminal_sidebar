import assert from 'node:assert/strict';
import * as path from 'node:path';
import { runInNewContext as run_in_new_context } from 'node:vm';
import test from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import type { prepare_html, html_search_text } from '../webview/html_preview';
import { local_document_resource } from '../webview/document_resources';

const base_url = 'https://file+.vscode-resource.vscode-cdn.net/work/paper/';
const policy_root = 'https://*.vscode-resource.vscode-cdn.net/work/paper/';
const bundled_preview = build({
  entryPoints: [path.resolve(__dirname, '../webview/html_preview.ts')], bundle: true,
  write: false, platform: 'browser', format: 'cjs',
}).then(result => result.outputFiles[0].text);

async function harness() {
  // No resource loader or script execution: tests exercise the actual sanitizer,
  // while browser CSP enforcement remains part of the extension's UI checks.
  const dom = new JSDOM('', { url: base_url });
  const module = { exports: {} as { prepare_html: typeof prepare_html; html_search_text: typeof html_search_text } };
  run_in_new_context(await bundled_preview, {
    module, exports: module.exports, window: dom.window, document: dom.window.document,
    DOMParser: dom.window.DOMParser, NodeFilter: dom.window.NodeFilter, URL,
  });
  const render = (text: string, resource_root = base_url) => new dom.window.DOMParser()
    .parseFromString(module.exports.prepare_html({ text, base_url: resource_root }), 'text/html');
  return { ...module.exports, render, close: () => dom.window.close() };
}

test('HTML preserves document structure and resolves local stylesheets and media', async () => {
  const h = await harness();
  try {
    const document = h.render(`<!doctype html><html lang="en"><head><title>Report</title>
      <link rel="stylesheet" href="styles/page.css"><style>.note { color: currentColor }</style></head>
      <body><main><h1 id="report">Report</h1><p class="note">Readable <strong>text</strong>.</p>
      <table><tbody><tr><td>Data</td></tr></tbody></table>
      <img src="images/figure%20one.png" alt="Figure">
      <video controls poster="images/poster.png"><source src="media/demo.webm"></video>
      <a href="#report">Top</a><a href="next.html#details">Next</a></main></body></html>`);
    assert.equal(document.documentElement.lang, 'en');
    assert.equal(document.title, 'Report');
    assert.equal(document.querySelector('main h1')?.textContent, 'Report');
    assert.equal(document.querySelector('table td')?.textContent, 'Data');
    assert.equal(document.querySelector('link')?.href, `${base_url}styles/page.css`);
    assert.equal(document.querySelector('img')?.src, `${base_url}images/figure%20one.png`);
    assert.equal(document.querySelector('video')?.poster, `${base_url}images/poster.png`);
    assert.equal(document.querySelector('source')?.src, `${base_url}media/demo.webm`);
    assert.deepEqual([...document.querySelectorAll('a')].map(anchor => anchor.getAttribute('href')), ['#report', 'next.html#details']);
    assert.match(document.querySelector('head')?.textContent ?? '', /\.note \{ color: currentColor \}/);
  } finally { h.close(); }
});

test('HTML removes executable content, event handlers, frames and navigation metadata', async () => {
  const h = await harness();
  try {
    const document = h.render(`<html><head><base href="https://evil.example/">
      <meta http-equiv="refresh" content="0;url=https://evil.example/">
      <meta http-equiv="Content-Security-Policy" content="script-src * 'unsafe-inline'"></head>
      <body onload="alert(1)"><script>alert(1)</script>
      <iframe src="https://evil.example/" srcdoc="<script>alert(1)</script>"></iframe>
      <object data="https://evil.example/attack.svg"></object><embed src="attack.swf">
      <img src="images/safe.png" onerror="alert(1)" srcset="https://evil.example/track.png 2x">
      <svg onload="alert(1)"><script>alert(1)</script><circle r="5"/></svg>
      <a href="https://example.com/" target="_top" ping="https://evil.example/" download>Safe link</a>
      <p onclick="alert(1)">Retained text</p></body></html>`);
    assert.equal(document.querySelector('script, iframe, frame, frameset, object, embed'), null);
    for (const element of document.querySelectorAll('*')) {
      for (const attribute of element.attributes) {
        assert.doesNotMatch(attribute.name, /^on/i);
        assert.ok(!['srcdoc', 'srcset', 'target', 'ping', 'download'].includes(attribute.name), attribute.name);
      }
    }
    assert.equal(document.querySelectorAll('base').length, 1);
    assert.equal(document.querySelector('base')?.href, base_url);
    assert.equal(document.querySelector('meta[http-equiv="refresh"]'), null);
    assert.equal(document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').length, 1);
    assert.equal(document.querySelector('p')?.textContent, 'Retained text');
    assert.equal(document.querySelector('a')?.getAttribute('href'), 'https://example.com/');
  } finally { h.close(); }
});

test('HTML resource URLs cannot escape the document directory or load external origins', async () => {
  const h = await harness();
  try {
    const rejected = ['https://evil.example/a.png', '//evil.example/a.png', 'data:image/png,abc',
      'file:///private/data.png', '/work/elsewhere.png', '../secret.png', '%2e%2e/secret.png',
      'assets%2f..%2f..%2fsecret.png', 'assets%5c..%5csecret.png', 'image%00.png',
      'image.png?request=1', 'image%.png', '\\evil.example\image.png'];
    for (const value of rejected) {
      assert.equal(local_document_resource(value, base_url), undefined, value);
      const document = h.render(`<img src="${value}"><link rel="stylesheet" href="${value}">`);
      assert.equal(document.querySelector('img')?.hasAttribute('src'), false, value);
      assert.equal(document.querySelector('link')?.hasAttribute('href'), false, value);
    }
    const document = h.render('<link rel="preload" href="image.png"><link rel="preconnect" href="https://evil.example/">');
    assert.equal(document.querySelector('link'), null, 'Only ordinary local stylesheets survive');
    assert.equal(local_document_resource('assets/../image.png', base_url), `${base_url}image.png`);
    assert.equal(local_document_resource('images/%E4%B8%AD%E6%96%87.png', base_url), `${base_url}images/%E4%B8%AD%E6%96%87.png`);
  } finally { h.close(); }
});

test('HTML links deny executable and escaped schemes while preserving normal navigation', async () => {
  const h = await harness();
  try {
    for (const href of ['javascript:alert(1)', 'java&#x09;script:alert(1)', 'jav&#x61;script:alert(1)',
      'vbscript:alert(1)', 'command:workbench.action.closeWindow', 'data:text/html,hello',
      '//evil.example/', '\\evil.example/']) {
      const document = h.render(`<a href="${href}">Click</a>`);
      assert.equal(document.querySelector('a')?.hasAttribute('href'), false, href);
    }
    for (const href of ['#part', 'chapter%20one.html#part', '../chapter.html', 'https://example.com/a', 'mailto:test@example.com']) {
      const document = h.render(`<a href="${href}">Click</a>`);
      assert.equal(document.querySelector('a')?.getAttribute('href'), href);
    }
  } finally { h.close(); }
});

test('HTML image-map and SVG links use the same validated host navigation as ordinary links', async () => {
  const h = await harness();
  try {
    const document = h.render(`<map name="navigation"><area href="next.html#part" shape="rect" coords="0,0,20,20"></map>
      <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
      <a xlink:href="chapter.html#part"><text>Next</text></a>
      <a xlink:href="//evil.example/"><text>Disallowed</text></a></svg>`);
    assert.equal(document.querySelector('area')?.getAttribute('href'), 'next.html#part', 'A host link is not a webview resource URL');
    const links = [...document.querySelectorAll('svg a')];
    assert.equal(links[0]?.getAttribute('href'), 'chapter.html#part', 'Legacy SVG links are normalized for the shared click handler');
    for (const link of links) assert.equal(link.hasAttributeNS('http://www.w3.org/1999/xlink', 'href'), false);
    assert.equal(links[1]?.hasAttribute('href'), false);
  } finally { h.close(); }
});

test('HTML inserts a restrictive CSP before styles and replaces untrusted base roots', async () => {
  const h = await harness();
  try {
    const document = h.render('<style>@import "https://evil.example/tracker.css";p{background:url(https://evil.example/a.png)}</style><p>Text</p>');
    const policy = document.querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy"]')!;
    const directives = new Map(policy.content.split(';').map(part => part.trim().split(/\s+/)).filter(parts => parts[0]).map(([name, ...values]) => [name, values]));
    for (const name of ['default-src', 'script-src', 'connect-src', 'frame-src', 'object-src', 'form-action']) {
      assert.deepEqual(directives.get(name), ["'none'"], name);
    }
    for (const name of ['img-src', 'font-src', 'media-src', 'base-uri']) assert.deepEqual(directives.get(name), [policy_root], name);
    assert.deepEqual(directives.get('style-src'), [policy_root, "'unsafe-inline'"]);
    assert.ok([...document.head.children].indexOf(policy) < [...document.head.children].findIndex(element => element.localName === 'style'));
    for (const invalid of ['file:///work/paper/', 'http://example.com/paper/', 'https://user:password@example.com/paper/',
      'https://example.com/paper', 'https://example.com/paper/?token=1', 'https://example.com/paper/#part']) {
      assert.throws(() => h.render('<p>Text</p>', invalid), /Invalid preview resource root/, invalid);
    }
  } finally { h.close(); }
});

test('HTML resource CSP handles VS Code scheme hosts without broadening ordinary hosts or paths', async () => {
  const h = await harness();
  try {
    for (const root of [base_url, 'https://vscode-remote+ssh-remote-002bhost.vscode-resource.vscode-cdn.net/work/paper/']) {
      const document = h.render('<link rel="stylesheet" href="styles/page.css"><img src="images/figure.png">', root);
      const policy = document.querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy"]')!.content;
      assert.ok(policy.includes(`style-src ${policy_root} 'unsafe-inline';`));
      assert.ok(policy.includes(`img-src ${policy_root};`));
      assert.doesNotMatch(policy, /file\+|vscode-remote\+/);
      assert.equal(document.querySelector('base')?.href, root, 'CSP matching never rewrites the actual resource origin');
      assert.equal(document.querySelector('link')?.href, `${root}styles/page.css`);
      assert.equal(document.querySelector('img')?.src, `${root}images/figure.png`);
    }
    for (const root of ['https://preview.example.test/work/paper/', 'https://vscode-resource.vscode-cdn.net.evil.example/work/paper/']) {
      const document = h.render('<p>Text</p>', root);
      const policy = document.querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy"]')!.content;
      assert.ok(policy.includes(`style-src ${root} 'unsafe-inline';`));
      assert.ok(policy.includes(`img-src ${root};`));
      assert.doesNotMatch(policy, /\*/);
    }
  } finally { h.close(); }
});

test('HTML form contents remain visible but cannot edit, pick files or submit', async () => {
  const h = await harness();
  try {
    const document = h.render(`<form action="https://evil.example/" method="post"><fieldset><legend>Example form</legend>
      <input value="Sample"><input type="file"><textarea>Notes</textarea><select><option>Option</option></select>
      <button formaction="https://evil.example/">Submit</button></fieldset></form>`);
    assert.equal(document.querySelector('form')?.hasAttribute('action'), false);
    for (const element of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>('input, textarea, select, button')) {
      assert.equal(element.disabled, true, `${element.localName} must be inert in a static preview`);
      assert.equal(element.hasAttribute('formaction'), false);
    }
    assert.equal(document.querySelector('input')?.value, 'Sample');
    assert.equal(document.querySelector('textarea')?.textContent, 'Notes');
    assert.equal(document.querySelector('legend')?.textContent, 'Example form');
  } finally { h.close(); }
});

test('HTML search ignores scripts, styles, templates and noscript fallback text', async () => {
  const h = await harness();
  try {
    const document = h.render('<h1>Alpha</h1><p>Visible <strong>Beta</strong></p><style>.hidden_css { content:"secret" }</style><script>secret_script</script><template>secret_template</template><noscript>secret_fallback</noscript>');
    const text = h.html_search_text(document.body);
    assert.match(text, /Alpha/);
    assert.match(text, /Visible Beta/);
    assert.doesNotMatch(text, /secret|hidden_css/);
  } finally { h.close(); }
});
