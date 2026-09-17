import { spawnSync as spawn_sync } from 'node:child_process';
import path from 'node:path';

const arguments_list = process.argv.slice(2);
const target_platform = `${process.platform}-${process.arch}`;
const target_argument_index = arguments_list.indexOf('--target');

// Native dependencies must be packaged on the operating system and architecture they run on.
if (target_argument_index !== -1) {
  if (arguments_list[target_argument_index + 1] !== target_platform) {
    throw new Error(`Native PTY packages must be built on their target platform (${target_platform}). Use the CI matrix for other platforms.`);
  }
  arguments_list.splice(target_argument_index, 2);
}
if (arguments_list.some(argument => argument.startsWith('--target='))) {
  throw new Error('Use --target followed by the platform name.');
}

const package_arguments = [
  path.resolve('node_modules/@vscode/vsce/vsce'),
  'package',
  '--no-dependencies',
  '--target',
  target_platform,
  ...arguments_list,
];
const package_result = spawn_sync(process.execPath, package_arguments, { stdio: 'inherit', env: process.env });
if (package_result.error) {
  throw package_result.error;
}
process.exitCode = package_result.status ?? 1;
