import { build, context } from 'esbuild';
import { mkdir, copyFile as copy_file, cp as copy_directory, rm as remove_directory, writeFile as write_file } from 'node:fs/promises';
import { existsSync as exists_sync } from 'node:fs';
import './prepare_pty.mjs';
import './generate_codicons.mjs';

await mkdir('dist', { recursive: true });

// Keep PDF parsing in its own worker and load fonts/decoders only when needed.
// The legacy build includes compatibility shims for the minimum supported VS Code.
await remove_directory('dist/pdfjs', { recursive: true, force: true });
await mkdir('dist/pdfjs', { recursive: true });
for (const name of ['pdf.mjs', 'pdf.worker.mjs']) {
  await copy_file(`node_modules/pdfjs-dist/legacy/build/${name}`, `dist/pdfjs/${name}`);
}
for (const name of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  await copy_directory(`node_modules/pdfjs-dist/${name}`, `dist/pdfjs/${name}`, { recursive: true });
}
await copy_file('node_modules/pdfjs-dist/LICENSE', 'dist/pdfjs/LICENSE');
await copy_file('assets/pdfjs_core_js.LICENSE', 'dist/pdfjs/core_js.LICENSE');
await write_file('dist/pdfjs/NOTICE', `PDF.js by Mozilla Foundation and contributors
Source: https://github.com/mozilla/pdf.js
The compatibility build embeds core-js 3.50.0 under the MIT license (core_js.LICENSE).
Core-js source: https://github.com/zloirock/core-js/tree/v3.50.0
The renderer, worker, decoder, font and CMap assets are copied without modification.
`);

// Ship this platform's native runtime. An installed VSIX must work without the source checkout.
await remove_directory('dist/node-pty', { recursive: true, force: true });
await mkdir('dist/node-pty', { recursive: true });
const runtime_file = source => !/\.(?:map|pdb)$/.test(source) && !/\.test\.js$/.test(source);
for (const entry of ['package.json', 'LICENSE', 'lib']) {
  await copy_directory(`node_modules/node-pty/${entry}`, `dist/node-pty/${entry}`, {
    recursive: true,
    filter: runtime_file,
  });
}

const native_directory = `prebuilds/${process.platform}-${process.arch}`;
if (exists_sync(`node_modules/node-pty/${native_directory}`)) {
  await copy_directory(`node_modules/node-pty/${native_directory}`, `dist/node-pty/${native_directory}`, {
    recursive: true,
    filter: runtime_file,
  });
} else if (exists_sync('node_modules/node-pty/build/Release/pty.node')) {
  await mkdir('dist/node-pty/build', { recursive: true });
  await copy_directory('node_modules/node-pty/build/Release', 'dist/node-pty/build/Release', {
    recursive: true,
    filter: runtime_file,
  });
} else {
  throw new Error(`No node-pty native runtime for ${process.platform}-${process.arch}. Run npm rebuild node-pty.`);
}

// Property names below belong to esbuild. Keep those API names unchanged.
const shared_options = { bundle: true, sourcemap: false, logLevel: 'info', legalComments: 'eof' };
const build_targets = [
  {
    ...shared_options,
    entryPoints: ['webview/document_format_worker.ts'],
    outfile: 'dist/document_format_worker.js',
    platform: 'browser',
    format: 'iife',
    target: 'chrome130',
  },
  {
    ...shared_options,
    entryPoints: ['webview/document_search_worker.ts'],
    outfile: 'dist/document_search_worker.js',
    platform: 'browser',
    format: 'iife',
    target: 'chrome130',
  },
  {
    ...shared_options,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['vscode'],
    plugins: [{
      name: 'packaged-pty',
      setup(builder) {
        builder.onResolve({ filter: /^node-pty$/ }, () => ({ path: './node-pty', external: true }));
      },
    }],
  },
  {
    ...shared_options,
    entryPoints: ['webview/main.ts'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
    target: 'chrome130',
    loader: { '.ttf': 'file', '.woff': 'file', '.woff2': 'file' },
    assetNames: '[name]',
  },
];
if (process.argv.includes('--watch')) {
  for (const build_target of build_targets) {
    const build_context = await context(build_target);
    await build_context.watch();
  }
} else {
  await Promise.all(build_targets.map(build_target => build(build_target)));
}

// Keep dependency licence texts beside the distributed runtime.
for (const [name, source] of [
  ['codicons', 'node_modules/@vscode/codicons/LICENSE'],
  ['codicons_code', 'node_modules/@vscode/codicons/LICENSE-CODE'],
  ['xterm', 'node_modules/@xterm/xterm/LICENSE'],
  ['xterm-addon-fit', 'node_modules/@xterm/addon-fit/LICENSE'],
  ['xterm_addon_search', 'node_modules/@xterm/addon-search/LICENSE'],
  ['xterm_addon_web_links', 'node_modules/@xterm/addon-web-links/LICENSE'],
  ['xterm_addon_unicode11', 'node_modules/@xterm/addon-unicode11/LICENSE'],
  // SerializeAddon declares MIT and shares xterm's licence; its npm tarball omits LICENSE.
  ['xterm_addon_serialize', 'node_modules/@xterm/xterm/LICENSE'],
  ['pdf_lib', 'node_modules/pdf-lib/LICENSE.md'],
  ['pdf_lib_standard_fonts', 'node_modules/@pdf-lib/standard-fonts/LICENSE.md'],
  ['pdf_lib_upng', 'node_modules/@pdf-lib/upng/LICENSE'],
  ['pako', 'node_modules/pako/LICENSE'],
  ['markdown_it', 'node_modules/markdown-it/LICENSE'],
  ['markdown_tex', 'node_modules/@mdit/plugin-tex/LICENSE'],
  ['markdown_footnote', 'node_modules/@mdit/plugin-footnote/LICENSE'],
  ['markdown_tasklist', 'node_modules/@mdit/plugin-tasklist/LICENSE'],
  ['markdown_helper', 'node_modules/@mdit/helper/LICENSE'],
  ['katex', 'node_modules/katex/LICENSE'],
  ['prettier', 'node_modules/prettier/LICENSE'],
  ['jsonc_parser', 'node_modules/jsonc-parser/LICENSE.md'],
  ['dompurify', 'node_modules/dompurify/LICENSE'],
  ['css_tree', 'node_modules/css-tree/LICENSE'],
  ['mdn_data', 'node_modules/mdn-data/LICENSE'],
  ['mdurl', 'node_modules/mdurl/LICENSE'],
  ['linkify_it', 'node_modules/linkify-it/LICENSE'],
  ['uc_micro', 'node_modules/uc.micro/LICENSE.txt'],
  ['entities', 'node_modules/entities/LICENSE'],
  ['argparse', 'node_modules/argparse/LICENSE'],
  ['punycode', 'node_modules/punycode.js/LICENSE-MIT.txt'],
  ['tslib', 'node_modules/tslib/LICENSE.txt'],
  ['node-pty', 'node_modules/node-pty/LICENSE'],
]) {
  await copy_file(source, `dist/${name}.LICENSE`);
}

await write_file('dist/codicons.NOTICE', `Codicons by Microsoft Corporation and contributors
Source: https://github.com/microsoft/vscode-codicons
Icons and font: Creative Commons Attribution 4.0 (codicons.LICENSE)
Code: MIT (codicons_code.LICENSE)
The bundled font is unmodified; CSS is bundled and the icon-name catalog is derived from it.
`);
