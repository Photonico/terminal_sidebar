import { chmod } from 'node:fs/promises';
import { existsSync as exists_sync } from 'node:fs';

// npm tarballs may omit executable bits for the macOS PTY launcher.
const launcher_paths = [
  'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
  'node_modules/node-pty/prebuilds/darwin-x64/spawn-helper',
  'node_modules/node-pty/build/Release/spawn-helper',
];
for (const launcher_path of launcher_paths) {
  if (exists_sync(launcher_path) && process.platform !== 'win32') {
    await chmod(launcher_path, 0o755);
  }
}
