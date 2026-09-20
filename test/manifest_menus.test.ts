import assert from 'node:assert/strict';
import { readFileSync as read_file } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { preview_extensions } from '../src/preview_format';

const manifest = JSON.parse(read_file(path.resolve(__dirname, '../package.json'), 'utf8'));
type menu_item = { command: string; when: string; group: string };
const view_menu = manifest.contributes.menus['view/title'] as menu_item[];

test('parent sidebar menus contain navigation and configuration without duplicating child tab operations', () => {
  for (const side of ['left', 'right']) {
    for (const action of ['add', 'save', 'close', 'openPreview', 'openPdf']) {
      assert.equal(view_menu.some(item => item.command === `terminalSidebar.${side}.${action}`), false);
    }
    for (const action of ['selectProfile', 'configure', 'restart', 'undo', 'redo']) {
      assert.ok(view_menu.some(item => item.command === `terminalSidebar.${side}.${action}`));
    }
  }
  assert.ok(view_menu.some(item => item.command === 'terminalSidebar.open'));
  assert.ok(view_menu.some(item => item.command === 'terminalSidebar.openLeft'));
});

test('Usage and About share a final separate sidebar menu group with the requested native icons', () => {
  const help = view_menu.filter(item => ['terminalSidebar.usage', 'terminalSidebar.about'].includes(item.command));
  assert.equal(help.length, 2);
  assert.deepEqual(help.map(item => item.command), ['terminalSidebar.usage', 'terminalSidebar.about']);
  assert.deepEqual(help.map(item => item.group), ['z_help@0', 'z_help@1']);
  for (const entry of help) {
    assert.match(entry.when, /terminalSidebar\.left/);
    assert.match(entry.when, /terminalSidebar\.terminals/);
  }
  for (const item of view_menu.filter(item => !item.group.startsWith('navigation') && !help.includes(item))) {
    assert.ok('z_help' > item.group.split('@')[0], 'Help has its own group after the existing overflow entries');
  }
  for (const [command, icon] of [['terminalSidebar.usage', '$(question)'], ['terminalSidebar.about', '$(info)']]) {
    assert.equal(manifest.contributes.commands.find((item: menu_item) => item.command === command).icon, icon);
  }
});

test('editor and explorer preview entries include every routed file format and keep unsupported files hidden', () => {
  for (const location of ['editor/title', 'editor/title/context', 'explorer/context']) {
    const entry = manifest.contributes.menus[location].find((item: menu_item) => item.command === 'terminalSidebar.openPreview');
    assert.ok(entry, location);
    assert.match(entry.when, /resourceScheme =~ \/\^\(file\|vscode-remote\)\$\//);
    const suffix = entry.when.match(/resourceExtname =~ \/(.+)\/([a-z]*)$/);
    assert.ok(suffix, location);
    const supported = new RegExp(suffix[1], suffix[2]);
    for (const extension of preview_extensions) {
      assert.ok(supported.test(`.${extension}`), `${location}: ${extension}`);
      assert.ok(supported.test(`.${extension.toUpperCase()}`), `${location}: uppercase ${extension}`);
    }
    for (const extension of ['js', 'exe', 'txt', 'docx']) assert.equal(supported.test(`.${extension}`), false);
    if (location === 'editor/title') assert.equal(entry.group, 'navigation@9');
  }
});
