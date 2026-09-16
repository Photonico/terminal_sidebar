import assert from 'node:assert/strict';
import test from 'node:test';
import { ProfileDraft } from '../src/draft';
import type { Profile } from '../src/types';

const original = (): Profile[] => [{ id: 'one', name: 'Terminal', command: '', shell: '' }];

test('configuration history groups typing, preserves the save baseline, and branches after undo', () => {
  const profiles = original();
  const history = new ProfileDraft(profiles);
  history.change(draft => { draft[0].name = 'A'; }, 'one:name', 1000);
  history.change(draft => { draft[0].name = 'AB'; }, 'one:name', 1100);
  history.change(draft => { draft[0].shell = '/bin/bash'; }, 'one:shell', 1200);
  assert.equal(history.value[0].name, 'AB');
  assert.deepEqual(history.base, profiles);
  assert.equal(profiles[0].shell, '');
  assert.equal(history.undo(), true);
  assert.equal(history.value[0].shell, '');
  assert.equal(history.value[0].name, 'AB');
  assert.equal(history.undo(), true);
  assert.deepEqual(history.value, original());
  assert.equal(history.dirty, false);
  assert.equal(history.redo(), true);
  history.change(draft => { draft[0].command = 'grok'; });
  assert.equal(history.canRedo, false);
  assert.deepEqual(history.base, original());
});

test('configuration history bounds snapshots and separates paused or refocused edits', () => {
  const history = new ProfileDraft(original(), 2);
  history.change(draft => { draft[0].name = 'A'; }, 'name', 1000);
  history.change(draft => { draft[0].name = 'B'; }, 'name', 2000);
  history.endGroup();
  history.change(draft => { draft[0].name = 'C'; }, 'name', 2100);
  assert.equal(history.undo(), true);
  assert.equal(history.value[0].name, 'B');
  assert.equal(history.undo(), true);
  assert.equal(history.value[0].name, 'A');
  assert.equal(history.undo(), false);
  history.reset(original());
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, false);
  assert.equal(history.dirty, false);
});
