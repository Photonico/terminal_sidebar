import { chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';

// npm tarballs may omit executable bits for the macOS PTY launcher.
for (const helper of [
  'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
  'node_modules/node-pty/prebuilds/darwin-x64/spawn-helper',
  'node_modules/node-pty/build/Release/spawn-helper'
]) if (existsSync(helper) && process.platform !== 'win32') await chmod(helper, 0o755);
