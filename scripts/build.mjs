import { build, context } from 'esbuild';
import { mkdir, copyFile as copy_file, cp as copy_directory, rm as remove_directory } from 'node:fs/promises';
import { existsSync as exists_sync } from 'node:fs';
import './prepare_pty.mjs';

await mkdir('dist', { recursive: true });

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
  ['tslib', 'node_modules/tslib/LICENSE.txt'],
  ['node-pty', 'node_modules/node-pty/LICENSE'],
]) {
  await copy_file(source, `dist/${name}.LICENSE`);
}
