import assert from 'node:assert/strict';
import * as path from 'node:path';
import { createRequire as create_require } from 'node:module';
import { runInNewContext as run_in_new_context } from 'node:vm';
import test from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

type about_api = typeof import('../src/about');
const bundle = build({ entryPoints: [path.resolve(__dirname, '../src/about.ts')], bundle: true,
  write: false, platform: 'node', format: 'cjs', external: ['vscode'] }).then(result => result.outputFiles[0].text);
const require_builtin = create_require(path.resolve(__dirname, '../package.json'));
const package_metadata = { displayName: 'Terminal Sidebar', version: '0.10.0', author: 'Lu Niu (Photonico)',
  license: 'MIT', repository: { url: 'https://github.com/Photonico/terminal_sidebar.git' } };

async function harness() {
  const opened: string[] = [];
  const errors: string[] = [];
  const panels: Array<{ webview: { html: string }; closed: boolean; reveals: number; listeners: number;
    receive(message: unknown): Promise<void>; dispose(): void }> = [];
  let fail_license = false;
  const uri = (value: string) => ({ toString: () => value });
  const vscode = {
    ViewColumn: { Active: -1 },
    Uri: { parse: uri, joinPath: (base: { toString(): string }, ...parts: string[]) => uri(`${base}/${parts.join('/')}`) },
    env: { openExternal: async (value: { toString(): string }) => { opened.push(String(value)); } },
    workspace: { openTextDocument: async (value: { toString(): string }) => {
      if (fail_license) throw new Error('Missing license');
      return { uri: value };
    } },
    window: {
      showTextDocument: async (value: { uri: { toString(): string } }) => { opened.push(String(value.uri)); },
      showErrorMessage: async (message: string) => { errors.push(message); },
      createWebviewPanel: () => {
        let receive = async (_message: unknown): Promise<void> => {};
        let on_dispose = (): void => {};
        const panel = {
          webview: { html: '', cspSource: 'https://webview.test', asWebviewUri: () => uri('https://webview.test/logo.png'),
            onDidReceiveMessage: (listener: typeof receive) => {
              receive = listener; panel.listeners++;
              return { dispose: () => { panel.listeners--; } };
            } },
          closed: false, reveals: 0, listeners: 0,
          receive: (message: unknown) => receive(message),
          onDidDispose: (listener: () => void) => { on_dispose = listener; },
          reveal: () => { panel.reveals++; },
          dispose: () => { if (!panel.closed) { panel.closed = true; on_dispose(); } },
        };
        panels.push(panel);
        return panel;
      },
    },
  };
  const module = { exports: {} as about_api };
  run_in_new_context(await bundle, { module, exports: module.exports, URL,
    require: (name: string) => name === 'vscode' ? vscode : require_builtin(name) });
  const context = { extensionUri: uri('file:///extension'), extension: { packageJSON: package_metadata } } as never;
  return { api: module.exports, context, opened, errors, panels, fail_license: () => { fail_license = true; } };
}

test('About reads current extension metadata and accepts only safe GitHub repository links', async () => {
  const h = await harness();
  const metadata = h.api.about_metadata(package_metadata);
  assert.equal(metadata.author, package_metadata.author);
  assert.equal(metadata.version, package_metadata.version);
  assert.equal(metadata.repository, 'https://github.com/Photonico/terminal_sidebar');
  assert.equal(h.api.about_metadata({ author: { name: 'Author' }, repository: 'git+https://github.com/org/repo.git' }).author, 'Author');
  for (const repository of ['javascript:alert(1)', 'https://evil.test/repo', 'https://github.com@evil.test/repo',
    'https://username:password@github.com/org/repo', 'https://github.com:8443/org/repo']) {
    assert.equal(h.api.about_metadata({ repository }).repository, undefined);
  }
});

test('About escapes metadata, uses theme colors, and gives every action a hover description', async () => {
  const h = await harness();
  const information = h.api.about_metadata({ ...package_metadata, displayName: '<img src=x onerror=evil()>', license: '"MIT"' });
  const html = h.api.about_html(information, 'https://webview.test/logo.png', 'https://webview.test', 'test_nonce');
  const document = new JSDOM(html).window.document;
  assert.equal(document.querySelector('h1')?.textContent, '<img src=x onerror=evil()>');
  assert.equal(document.querySelectorAll('img').length, 1);
  assert.ok(document.querySelector('style')?.textContent?.includes('var(--vscode-editor-background)'));
  assert.match(document.querySelector('meta[http-equiv]')!.getAttribute('content')!, /default-src 'none'/);
  for (const button of document.querySelectorAll('button')) {
    assert.ok(button.title);
    assert.ok(button.getAttribute('aria-label'));
  }
});

test('About reuses its panel and permits only fixed repository and local-license actions', async () => {
  const h = await harness();
  const about = new h.api.about_panel(h.context);
  about.show(); about.show();
  assert.equal(h.panels.length, 1);
  const panel = h.panels[0];
  assert.equal(panel.reveals, 1);
  await panel.receive({ type: 'open_repository', url: 'https://evil.test' });
  await panel.receive({ type: 'open_license', path: '/arbitrary/path' });
  await panel.receive({ type: 'open_url', url: 'https://evil.test' });
  await panel.receive(null);
  assert.deepEqual(h.opened, ['https://github.com/Photonico/terminal_sidebar', 'file:///extension/LICENSE']);
  about.dispose();
  assert.equal(panel.listeners, 0);
  await panel.receive({ type: 'open_repository' });
  assert.equal(h.opened.length, 2);
  about.show();
  assert.equal(h.panels.length, 2);
});

test('About reports an unavailable license without an unhandled rejection', async () => {
  const h = await harness();
  const about = new h.api.about_panel(h.context);
  about.show(); h.fail_license();
  await h.panels[0].receive({ type: 'open_license' });
  assert.equal(h.errors.length, 1);
  about.dispose();
});
