import assert from 'node:assert/strict';
import * as path from 'node:path';
import { runInNewContext as run_in_new_context } from 'node:vm';
import test from 'node:test';
import { build } from 'esbuild';

type font_api = typeof import('../src/preview_font');
const bundle = build({ entryPoints: [path.resolve(__dirname, '../src/preview_font.ts')], bundle: true,
  write: false, platform: 'node', format: 'cjs', external: ['vscode'] }).then(result => result.outputFiles[0].text);

async function harness(initial: unknown = 'default') {
  let current = initial;
  const writes: unknown[][] = [];
  const module = { exports: {} as font_api };
  const vscode = {
    ConfigurationTarget: { Global: 1 },
    workspace: { getConfiguration: (section: string) => ({
      get: (_key: string, fallback: unknown) => section === 'editor' ? 'Editor Face, monospace' : current ?? fallback,
      update: async (...args: unknown[]) => { writes.push([section, ...args]); current = args[1]; },
    }) },
  };
  run_in_new_context(await bundle, { module, exports: module.exports, require: () => vscode });
  return { api: module.exports, writes };
}

test('Markdown font defaults follow VS Code and editor choice tracks the editor setting', async () => {
  const defaults = await harness();
  assert.equal(defaults.api.preview_font_family(), '');
  const editor = await harness('editor');
  assert.equal(editor.api.preview_font_family(), 'Editor Face, monospace');
  const invalid = await harness('Arial; color: red');
  assert.equal(invalid.api.preview_font_family(), '');
});

test('font choice saves to user scope and default removes the override', async () => {
  const h = await harness();
  await h.api.set_preview_font('serif');
  assert.deepEqual(h.writes, [['terminalSidebar', 'markdownFontFamily', 'serif', 1]]);
  assert.equal(h.api.preview_font_family(), 'serif');
  await h.api.set_preview_font('default');
  assert.deepEqual(h.writes[1], ['terminalSidebar', 'markdownFontFamily', undefined, 1]);
  assert.equal(h.api.preview_font_family(), '');
});

test('empty or invalid font values leave the saved preference intact', async () => {
  const h = await harness('serif');
  for (const value of [undefined, null, '', '   ', 42]) await h.api.set_preview_font(value);
  assert.equal(h.writes.length, 0);
  assert.equal(h.api.preview_font_family(), 'serif');
});

test('custom font lists retain Unicode and cannot inject CSS declarations or resource URLs', async () => {
  const h = await harness();
  await h.api.set_preview_font('  Georgia, "思源宋体", serif  ');
  assert.equal(h.api.preview_font_family(), 'Georgia, "思源宋体", serif');
  for (const value of ['Arial; color: red', 'url(https://evil.test/font)', 'Arial\nserif', '<style>', 'x'.repeat(257)]) {
    assert.equal(h.api.valid_preview_font(value), false);
    await h.api.set_preview_font(value);
  }
  assert.equal(h.writes.length, 1);
});

test('font grammar accepts quoted names but rejects malformed fallback lists before saving', async () => {
  const h = await harness('serif');
  for (const value of ['123', 'Font 123', '-123', 'Georgia,,serif', 'Georgia,', ',serif', '"Georgia',
    'Georgia"', '"Georgia" serif', '""', "''", '.SF NS', 'Arial.Bold', 'inherit', 'serif, initial', 'serif Foo']) {
    assert.equal(h.api.valid_preview_font(value), false, value);
    await h.api.set_preview_font(value);
  }
  assert.equal(h.writes.length, 0);
  for (const value of ['"123"', "'Font 123'", '"Georgia, Times", serif', '"Rock \'n\' Roll", serif',
    'Noto Serif CJK SC, serif', '思源宋体, serif', '".SF NS", system-ui', '_Font2, monospace', '-Example, serif']) {
    assert.equal(h.api.valid_preview_font(value), true, value);
    await h.api.set_preview_font(value);
    assert.equal(h.api.preview_font_family(), value);
  }
});
