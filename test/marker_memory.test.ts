import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { setImmediate as next_turn } from 'node:timers/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { marker_memory, type marker_storage } from '../src/marker_memory';
import type { tab_marker } from '../src/tab_marker';
import { sidebar_tabs } from '../src/tabs';

const bookmark: tab_marker = { icon: 'bookmark', color: 'ansiBlue' };
const flag: tab_marker = { icon: 'flag', color: 'tab_inactive_foreground' };
const directories: string[] = [];
after(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }); });

function store(legacy: Map<string, unknown> = new Map()) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'terminal_sidebar_markers_'));
  directories.push(directory);
  const errors: string[] = [];
  const storage: marker_storage = { get: name => structuredClone(legacy.get(name)) };
  return {
    directory, storage, legacy, errors,
    memory: new marker_memory(directory, storage, message => errors.push(message)),
    read: (id: string, side = 'left') => JSON.parse(readFileSync(path.join(directory, `${side}_${id}.json`), 'utf8')),
  };
}

test('startup markers follow profile IDs across workspaces without sharing names, launch data, or sides', async () => {
  const profiles = [{ id: 'editor', name: 'Editor', command: 'nvim', shell: '/bin/zsh', env: { TOKEN: 'secret' } }];
  const first = new sidebar_tabs(profiles);
  const shared = store();
  await shared.memory.set('left', first.tabs[0], bookmark);
  await shared.memory.set('right', first.tabs[0], flag);
  const next = new sidebar_tabs([{ ...profiles[0], name: 'Changed profile name' }]);
  const next_window = new marker_memory(shared.directory, shared.storage);
  assert.deepEqual(next_window.marker_for('left', next.tabs[0]), bookmark);
  assert.deepEqual(next_window.marker_for('right', next.tabs[0]), flag);
  assert.equal(next_window.marker_for('left', { profile_id: 'unrelated' }), undefined);
  assert.deepEqual(shared.read('editor'), { version: 1, marker: bookmark });
  assert.doesNotMatch(JSON.stringify(shared.read('editor')), /Editor|nvim|zsh|TOKEN|secret|tab_0/);
  assert.equal(shared.legacy.size, 0, 'new preferences never rewrite Memento snapshots');
});

test('simultaneous independent windows retain every profile and read the latest explicit removal', async () => {
  const shared = store();
  const other_window = new marker_memory(shared.directory, { get: () => undefined });
  await Promise.all(Array.from({ length: 20 }, (_, index) =>
    (index % 2 ? shared.memory : other_window).set('left', { profile_id: `profile_${index}` }, index % 2 ? flag : bookmark)));
  for (let index = 0; index < 20; index++) {
    assert.deepEqual(shared.memory.marker_for('left', { profile_id: `profile_${index}` }), index % 2 ? flag : bookmark);
  }
  await other_window.set('left', { profile_id: 'profile_0' }, undefined);
  await shared.memory.migrate('left', [{ profile_id: 'profile_0', marker: bookmark }]);
  assert.equal(shared.memory.marker_for('left', { profile_id: 'profile_0', marker: bookmark }), undefined);
  assert.deepEqual(shared.read('profile_0'), { version: 1, marker: null });
  assert.equal(readdirSync(shared.directory).length, 20, 'no temporary files remain after writes');
});

test('migration never overwrites a concurrent explicit choice or removal', async () => {
  const shared = store();
  const other_window = new marker_memory(shared.directory, { get: () => undefined });
  for (let index = 0; index < 10; index++) {
    const tab = { profile_id: `profile_${index}`, marker: bookmark };
    const chosen = index % 2 ? flag : undefined;
    await Promise.all([shared.memory.migrate('left', [tab]), other_window.set('left', tab, chosen)]);
    assert.deepEqual(shared.memory.marker_for('left', tab), chosen);
  }
});

test('readers see complete records while another window repeatedly replaces the same marker', async () => {
  const shared = store();
  const tab = { profile_id: 'editor' };
  await shared.memory.set('left', tab, bookmark);
  let finished = false;
  const writing = (async () => {
    for (let index = 0; index < 20; index++) await shared.memory.set('left', tab, index % 2 ? bookmark : flag);
    finished = true;
  })();
  while (!finished) {
    const marker = shared.memory.marker_for('left', tab);
    assert.ok(marker && [bookmark.icon, flag.icon].includes(marker.icon));
    await next_turn();
  }
  await writing;
  assert.deepEqual(shared.errors, []);
});

test('old workspace and Memento preferences migrate once, while file tombstones remain authoritative', async () => {
  const legacy = new Map<string, unknown>([
    ['terminalSidebar.profileMarker.v1.left.individual', flag],
    ['terminalSidebar.profileMarkers', { version: 1, entries: [
      { side: 'left', profile_id: 'editor', marker: bookmark },
      { side: 'right', profile_id: 'editor', marker: null },
    ] }],
  ]);
  const shared = store(legacy);
  const before = structuredClone(legacy);
  await shared.memory.migrate('left', [{ profile_id: 'individual' }, { profile_id: 'editor' }, { profile_id: 'local', marker: flag }]);
  await shared.memory.migrate('right', [{ profile_id: 'editor', marker: flag }]);
  assert.deepEqual(shared.read('individual').marker, flag);
  assert.deepEqual(shared.read('local').marker, flag);
  assert.deepEqual(shared.read('editor').marker, bookmark);
  assert.equal(shared.read('editor', 'right').marker, null);
  await shared.memory.set('left', { profile_id: 'editor' }, undefined);
  await shared.memory.migrate('left', [{ profile_id: 'editor', marker: bookmark }]);
  assert.equal(shared.memory.marker_for('left', { profile_id: 'editor' }), undefined);
  assert.deepEqual(legacy, before);
});

test('temporary and document markers remain local and invalid identities cannot escape storage', async () => {
  const shared = store();
  for (const tab of [
    { id: 'tab_0', name: 'Term 0', marker: bookmark },
    { kind: 'pdf', profile_id: 'editor', marker: flag },
    { kind: 'markdown', profile_id: 'editor', marker: flag },
    { profile_id: '../invalid', marker: bookmark },
  ]) {
    await shared.memory.migrate('left', [tab]);
    assert.equal(await shared.memory.set('left', tab, flag), false);
    assert.deepEqual(shared.memory.marker_for('left', tab), tab.marker);
  }
  assert.equal(await shared.memory.set('left', { profile_id: 'valid' }, { ...bookmark, color: '#ff0000' } as unknown as tab_marker), false);
  assert.deepEqual(readdirSync(shared.directory), []);
});

test('bounded corrupt reads fall back safely, report once, and explicit edits repair the record', async () => {
  const shared = store();
  writeFileSync(path.join(shared.directory, 'left_editor.json'), 'x'.repeat(10_000));
  const tab = { profile_id: 'editor', marker: flag };
  assert.deepEqual(shared.memory.marker_for('left', tab), flag);
  assert.deepEqual(shared.memory.marker_for('left', tab), flag);
  assert.equal(shared.errors.length, 1);
  await shared.memory.set('left', tab, bookmark);
  assert.deepEqual(shared.read('editor'), { version: 1, marker: bookmark });
  const snapshot = shared.memory.marker_for('left', tab)!;
  snapshot.icon = 'ask';
  assert.deepEqual(shared.memory.marker_for('left', tab), bookmark);
});

test('unwritable storage does not erase workspace markers or leak unfinished temporary files', async () => {
  const shared = store();
  const blocked = path.join(shared.directory, 'blocked');
  writeFileSync(blocked, 'a file cannot be a directory');
  const errors: string[] = [];
  const memory = new marker_memory(blocked, shared.storage, message => errors.push(message));
  const tab = { profile_id: 'editor', marker: bookmark };
  assert.deepEqual(memory.marker_for('left', tab), bookmark);
  await assert.rejects(memory.set('left', tab, flag));
  assert.deepEqual(memory.marker_for('left', tab), bookmark);
  assert.equal(errors.length, 1);
  assert.deepEqual(readdirSync(shared.directory), ['blocked']);
});

test('storage does not evict removal records when its preference limit is reached', async () => {
  const shared = store();
  for (let index = 0; index < 1024; index++) writeFileSync(path.join(shared.directory, `left_profile_${index}.json`), '{"version":1,"marker":null}');
  await assert.rejects(shared.memory.set('left', { profile_id: 'another' }, bookmark), /Too many saved/);
  await shared.memory.set('left', { profile_id: 'profile_0' }, bookmark);
  await shared.memory.set('left', { profile_id: 'profile_0' }, undefined);
  assert.equal(shared.read('profile_0').marker, null);
  assert.equal(readdirSync(shared.directory).length, 1024);
});
