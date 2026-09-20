import assert from 'node:assert/strict';
import * as path from 'node:path';
import { createRequire as create_require } from 'node:module';
import { runInNewContext as run_in_new_context } from 'node:vm';
import { setImmediate as next_turn } from 'node:timers/promises';
import test from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { usage_guides, usage_languages } from '../src/usage_content';

type usage_api = typeof import('../src/usage');
const bundle = build({ entryPoints: [path.resolve(__dirname, '../src/usage.ts')], bundle: true,
  write: false, platform: 'node', format: 'cjs', external: ['vscode'] }).then(result => result.outputFiles[0].text);
const require_builtin = create_require(path.resolve(__dirname, '../package.json'));

async function harness(saved?: unknown, locale = 'en') {
  const memory = new Map<string, unknown>([['usage_language', saved]]);
  const writes: unknown[] = [];
  const panels: Array<{ webview: { html: string }; closed: boolean; reveals: number; listeners: number;
    receive(message: unknown): void; dispose(): void }> = [];
  const vscode = {
    ViewColumn: { Active: -1 },
    env: { language: locale },
    window: {
      showWarningMessage: async () => {},
      createWebviewPanel: (_type: string, title: string, _column: unknown, options: { localResourceRoots: unknown[] }) => {
        assert.equal(title, 'Terminal Sidebar: Usage');
        assert.equal(options.localResourceRoots.length, 0);
        let receive = (_message: unknown): void => {};
        let on_dispose = (): void => {};
        const panel = {
          webview: { html: '', onDidReceiveMessage: (listener: typeof receive) => {
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
  const module = { exports: {} as usage_api };
  run_in_new_context(await bundle, { module, exports: module.exports,
    require: (name: string) => name === 'vscode' ? vscode : require_builtin(name) });
  const context = { globalState: {
    get: (key: string) => memory.get(key),
    update: async (key: string, value: unknown) => { await next_turn(); writes.push(value); memory.set(key, value); },
  } } as never;
  return { api: module.exports, context, panels, writes, memory };
}

test('Usage prefers a valid remembered language and otherwise follows supported VS Code locales', async () => {
  const h = await harness();
  assert.equal(h.api.initial_usage_language('ja', 'zh-cn'), 'ja');
  assert.equal(h.api.initial_usage_language(undefined, 'zh-tw'), 'zh');
  assert.equal(h.api.initial_usage_language(undefined, 'ja'), 'ja');
  assert.equal(h.api.initial_usage_language('invalid', 'de'), 'en');
  for (const value of [null, {}, [], 1, 'EN', '<script>']) assert.equal(h.api.is_usage_language(value), false);
});

test('all Usage translations contain the same workflows and valid local navigation targets', async () => {
  const h = await harness();
  for (const language of usage_languages) {
    assert.deepEqual(usage_guides[language].sections.map(section => section.id), usage_guides.en.sections.map(section => section.id));
    const document = new JSDOM(h.api.usage_html(language, 'test_nonce')).window.document;
    assert.equal(document.querySelectorAll('article:not([hidden])').length, 1);
    assert.equal(document.querySelector('article:not([hidden])')?.id, `guide-${language}`);
    for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a')) {
      assert.ok(anchor.getAttribute('href')?.startsWith('#'));
      assert.ok(document.getElementById(anchor.getAttribute('href')!.slice(1)));
    }
    for (const button of document.querySelectorAll('button')) assert.ok(button.title && button.getAttribute('aria-label'));
    assert.equal(document.querySelectorAll('[src], link').length, 0, 'Help has no network or local asset dependencies');
    assert.match(document.querySelector('meta[http-equiv]')!.getAttribute('content')!, /default-src 'none'/);
  }
});

test('Usage restores webview language after reload and switches in place with accessible state', async () => {
  const h = await harness();
  const messages: unknown[] = [];
  const states: unknown[] = [];
  const browser = new JSDOM(h.api.usage_html('en', 'test_nonce'), {
    runScripts: 'dangerously', beforeParse(window) {
      Object.assign(window, { acquireVsCodeApi: () => ({
        getState: () => ({ language: 'ja' }),
        setState: (state: unknown) => states.push(JSON.parse(JSON.stringify(state))),
        postMessage: (message: unknown) => messages.push(JSON.parse(JSON.stringify(message))),
      }), scrollTo: () => {} });
    },
  });
  const document = browser.window.document;
  assert.equal(document.querySelector('article:not([hidden])')?.id, 'guide-ja');
  for (const language of ['zh', 'ja', 'en']) {
    document.querySelector<HTMLButtonElement>(`button[data-language="${language}"]`)!.click();
    assert.equal(document.querySelector('article:not([hidden])')?.id, `guide-${language}`);
    assert.equal(document.querySelectorAll('button[aria-pressed="true"]').length, 1);
    assert.equal(document.documentElement.lang, language === 'zh' ? 'zh-Hans' : language);
  }
  assert.deepEqual(messages, ['zh', 'ja', 'en'].map(language => ({ type: 'usage_language', language })));
  assert.deepEqual(states, ['zh', 'ja', 'en'].map(language => ({ language })));
  browser.window.close();
});

test('Usage remembers language switches in order and ignores unknown or retired-panel messages', async () => {
  const h = await harness(undefined, 'zh-cn');
  const usage = new h.api.usage_panel(h.context);
  usage.show(); usage.show();
  assert.equal(h.panels.length, 1);
  const panel = h.panels[0];
  assert.equal(panel.reveals, 1);
  assert.equal(new JSDOM(panel.webview.html).window.document.documentElement.lang, 'zh-Hans');
  for (const language of ['ja', 'en', 'zh']) panel.receive({ type: 'usage_language', language });
  for (const message of [null, [], { type: 'open_url', language: 'en' }, { type: 'usage_language', language: 'bad' }]) panel.receive(message);
  for (let step = 0; step < 5; step++) await next_turn();
  assert.deepEqual(h.writes, ['ja', 'en', 'zh']);
  usage.dispose();
  assert.equal(panel.listeners, 0);
  panel.receive({ type: 'usage_language', language: 'en' });
  await next_turn();
  assert.equal(h.memory.get('usage_language'), 'zh');
  const reopened = new h.api.usage_panel(h.context);
  reopened.show();
  assert.equal(new JSDOM(h.panels[1].webview.html).window.document.documentElement.lang, 'zh-Hans');
  reopened.dispose();
});
