import assert from 'node:assert/strict';
import test from 'node:test';
import { configuration_draft } from '../src/draft';
import type { sidebar_configuration } from '../src/types';

const original = (): sidebar_configuration => ({ left: [], right: [{ id: 'one', name: 'Terminal', command: '', shell: '' }] });

test('configuration history groups typing across both sides, preserves its baseline, and branches after undo', () => {
  const configuration = original();
  const history = new configuration_draft(configuration);
  history.change(draft => { draft.right[0].name = 'A'; }, 'right:one:name', 1000);
  history.change(draft => { draft.right[0].name = 'AB'; }, 'right:one:name', 1100);
  history.change(draft => { draft.left.push({ id: 'one', name: 'Left', command: '', shell: '/bin/bash' }); }, 'left:add', 1200);
  assert.equal(history.value.right[0].name, 'AB');
  assert.deepEqual(history.base, configuration);
  assert.equal(configuration.left.length, 0);
  assert.equal(history.undo(), true);
  assert.equal(history.value.left.length, 0);
  assert.equal(history.value.right[0].name, 'AB');
  assert.equal(history.undo(), true);
  assert.deepEqual(history.value, original());
  assert.equal(history.dirty, false);
  assert.equal(history.redo(), true);
  history.change(draft => { draft.right[0].command = 'nvim'; });
  assert.equal(history.can_redo, false);
  assert.deepEqual(history.base, original());
  history.value.right[0].name = 'Mutation outside history';
  assert.equal(history.value.right[0].name, 'AB');
});

test('configuration history bounds snapshots and separates paused or refocused edits', () => {
  const history = new configuration_draft(original(), 2);
  history.change(draft => { draft.right[0].name = 'A'; }, 'name', 1000);
  history.change(draft => { draft.right[0].name = 'B'; }, 'name', 2000);
  history.end_group();
  history.change(draft => { draft.right[0].name = 'C'; }, 'name', 2100);
  assert.equal(history.undo(), true);
  assert.equal(history.value.right[0].name, 'B');
  assert.equal(history.undo(), true);
  assert.equal(history.value.right[0].name, 'A');
  assert.equal(history.undo(), false);
  history.reset(original());
  assert.equal(history.can_undo, false);
  assert.equal(history.can_redo, false);
  assert.equal(history.dirty, false);
});
