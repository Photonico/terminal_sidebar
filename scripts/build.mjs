import { build, context } from 'esbuild';
import { mkdir, copyFile, cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import './prepare-pty.mjs';

await mkdir('dist', { recursive: true });
// Ship only this platform's native runtime; VSIX must not depend on the source checkout.
await rm('dist/node-pty', { recursive: true, force: true });
await mkdir('dist/node-pty', { recursive: true });
const runtimeFiles = source => !/\.(?:map|pdb)$/.test(source) && !/\.test\.js$/.test(source);
for (const item of ['package.json', 'LICENSE', 'lib']) await cp(`node_modules/node-pty/${item}`, `dist/node-pty/${item}`, { recursive: true, filter: runtimeFiles });
const native = `prebuilds/${process.platform}-${process.arch}`;
if (existsSync(`node_modules/node-pty/${native}`)) {
  await cp(`node_modules/node-pty/${native}`, `dist/node-pty/${native}`, { recursive: true, filter: runtimeFiles });
} else if (existsSync('node_modules/node-pty/build/Release/pty.node')) {
  await mkdir('dist/node-pty/build', { recursive: true });
  await cp('node_modules/node-pty/build/Release', 'dist/node-pty/build/Release', { recursive: true, filter: runtimeFiles });
} else {
  throw new Error(`No node-pty native runtime for ${process.platform}-${process.arch}. Run npm rebuild node-pty.`);
}
const shared = { bundle: true, sourcemap: false, logLevel: 'info', legalComments: 'eof' };
const targets = [
  { ...shared, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', target: 'node22', external: ['vscode'], plugins: [{
    name: 'packaged-pty', setup(builder) { builder.onResolve({ filter: /^node-pty$/ }, () => ({ path: './node-pty', external: true })); }
  }] },
  { ...shared, entryPoints: ['webview/main.ts'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'chrome130' }
];
if (process.argv.includes('--watch')) {
  for (const target of targets) await (await context(target)).watch();
} else {
  await Promise.all(targets.map(target => build(target)));
}
// Bundle the runtime dependency licenses with the distribution.
for (const [name, source] of [
  ['xterm', 'node_modules/@xterm/xterm/LICENSE'],
  ['xterm-addon-fit', 'node_modules/@xterm/addon-fit/LICENSE'],
  ['node-pty', 'node_modules/node-pty/LICENSE']
]) await copyFile(source, `dist/${name}.LICENSE`);
