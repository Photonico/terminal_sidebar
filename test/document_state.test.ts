import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sidebar_tabs } from '../src/tabs';
import { is_document_tab, is_terminal_tab } from '../src/types';
import { is_client_message } from '../src/profiles';
import { document_format_for_uri, is_document_position } from '../src/document_state';

test('source preview memory preserves reading state and ignores conflicting or malformed document descriptors', () => {
  const model = new sidebar_tabs([], { version: 1, tabs: [
    { id: 'shared', name: 'Bad format', document: { uri: 'file:///a.css', format: 'html', scroll: 0 } },
    { id: 'shared', name: 'CSS', document: { uri: 'file:///a.css', format: 'css', scroll: 70 } },
    { id: 'remote', name: 'HTML', document: { uri: 'vscode-remote://ssh-remote+host/a.htm', format: 'html', scroll: 30 } },
    { id: 'both', name: 'Both', document: { uri: 'file:///a.html', format: 'html', scroll: 0 }, markdown: { uri: 'file:///a.md', scroll: 0 } },
    { id: 'profile', name: 'Profile', profile_id: 'shell', document: { uri: 'file:///a.json', format: 'json', scroll: 0 } },
    { id: 'negative', name: 'Negative', document: { uri: 'file:///a.json', format: 'json', scroll: -1 } },
    { id: 'script', name: 'Script', document: { uri: 'file:///a.js', format: 'html', scroll: 0 } },
    { id: 'terminal', name: 'Terminal' },
  ] });
  assert.deepEqual(model.tabs.map(tab => tab.id), ['shared', 'remote', 'terminal']);
  assert.ok(model.tabs.slice(0, 2).every(is_document_tab));
  assert.ok(is_terminal_tab(model.tabs[2]));
  assert.equal(model.open_document('file:///a.css', 'CSS again').id, 'shared');
  model.set_document_position('shared', { scroll: 99.5 });
  model.set_marker('shared', { icon: 'bookmark', color: 'ansiBlue' });
  const memory = model.remember();
  const restored = new sidebar_tabs([], memory);
  assert.deepEqual(restored.tabs, model.tabs);
  for (const tab of memory.tabs.filter(tab => tab.document)) {
    assert.ok(!('command' in tab) && !('shell' in tab) && !('cwd' in tab) && !('profile_id' in tab));
  }
  assert.equal(model.set_document_position('terminal', { scroll: 1 }), false);
  assert.equal(model.set_cwd('shared', '/work'), false);
});

test('source previews share the existing document capacity and never consume terminal numbering', () => {
  const model = new sidebar_tabs([]);
  for (let index = 0; index < 8; index++) {
    if (index % 3 === 0) model.open_pdf(`file:///paper${index}.pdf`, 'PDF');
    else if (index % 3 === 1) model.open_markdown(`file:///notes${index}.md`, 'Markdown');
    else model.open_document(`file:///source${index}.jsonc`, 'Source');
  }
  assert.throws(() => model.open_document('file:///extra.html', 'Extra'), /maximum 8/);
  assert.equal(model.add_tab().name, 'Term 0');
  assert.throws(() => model.open_document('file:///unsupported.js', 'Script'), /HTML, CSS, JSON or JSONC/);
});

test('source document commands validate scroll bounds and forbid executable or malformed links', () => {
  assert.equal(document_format_for_uri('file:///note.HTM'), 'html');
  assert.equal(document_format_for_uri('file:///style.%63ss'), 'css');
  assert.ok(is_client_message({ type: 'load_document', id: 'one' }));
  assert.ok(is_client_message({ type: 'document_position', id: 'one', position: { scroll: 100 } }));
  assert.ok(is_client_message({ type: 'open_document_link', id: 'one', href: 'sibling.css' }));
  for (const href of ['command:workbench.action.closeWindow', 'javascript:alert(1)', '//example.com/file', 'data:text/html,hi']) {
    assert.equal(is_client_message({ type: 'open_document_link', id: 'one', href }), false);
  }
  for (const scroll of [-1, NaN, Infinity, '1', 100_000_001]) {
    assert.equal(is_document_position({ scroll }), false);
    assert.equal(is_client_message({ type: 'document_position', id: 'one', position: { scroll } }), false);
  }
});
