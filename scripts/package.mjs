import { spawnSync } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const target = `${process.platform}-${process.arch}`;
const index = args.indexOf('--target');
if (index !== -1) {
  if (args[index + 1] !== target) throw new Error(`Native PTY packages must be built on their target platform (${target}). Use the CI matrix for other platforms.`);
  args.splice(index, 2);
}
if (args.some(arg => arg.startsWith('--target='))) throw new Error('Use --target followed by the platform name.');
const result = spawnSync(process.execPath, [path.resolve('node_modules/@vscode/vsce/vsce'), 'package', '--no-dependencies', '--target', target, ...args], { stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
