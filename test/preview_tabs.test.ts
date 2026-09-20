import assert from 'node:assert/strict';
import test from 'node:test';
import { sidebar_tabs } from '../src/tabs';
import { is_pdf_tab, is_markdown_tab, is_terminal_tab } from '../src/types';
import { is_client_message } from '../src/profiles';
import { is_pdf_uri, is_pdf_source_uri, is_pdf_position } from '../src/pdf_state';

test('mixed document and terminal tabs restore order, reading position and markers without launch data', () => {
  const profiles = [{ id: 'vim', name: 'Vim', command: 'vim', shell: '' }];
  const model = new sidebar_tabs(profiles);
  const pdf = model.open_pdf('file:///work/thesis.pdf', 'thesis.pdf');
  const markdown = model.open_markdown('file:///work/notes.md', 'notes.md');
  const shell = model.add_tab();
  assert.equal(shell.name, 'Term 0');
  model.set_pdf_position(pdf.id, { page: 20, zoom: 'page-fit' });
  model.set_markdown_position(markdown.id, { scroll: 1200 });
  model.set_marker(pdf.id, { icon: 'bookmark', color: 'ansiBlue' });
  model.rename_tab(markdown.id, 'Notes');
  model.move_tab(markdown.id, pdf.id, 'before');
  model.select_tab(pdf.id);
  model.set_expanded(pdf.id, false);
  const memory = model.remember();
  const restored = new sidebar_tabs(profiles, memory);
  assert.deepEqual(restored.tabs, model.tabs);
  assert.equal(restored.active_id, pdf.id);
  assert.deepEqual(restored.expanded_ids, model.expanded_ids);
  for (const tab of memory.tabs.filter(tab => tab.pdf || tab.markdown)) {
    assert.ok(!('command' in tab) && !('shell' in tab) && !('cwd' in tab) && !('profile_id' in tab));
  }
  assert.equal(restored.open_pdf(pdf.uri, pdf.name).id, pdf.id);
  assert.equal(restored.open_markdown(markdown.uri, markdown.name).id, markdown.id);
  assert.equal(restored.tabs.length, 4);
  assert.equal(restored.set_cwd(pdf.id, '/work'), false);
  assert.equal(restored.set_pdf_position(markdown.id, { page: 1, zoom: 1 }), false);
  assert.equal(restored.set_markdown_position(pdf.id, { scroll: 100 }), false);
  restored.close_tab(shell.id);
  assert.equal(restored.add_tab().name, 'Term 0', 'previews never affect terminal numbering');
});

test('malformed document memory is discarded independently and cannot reserve another valid tab ID', () => {
  const model = new sidebar_tabs([], { version: 1, tabs: [
    { id: 'duplicate', name: 'Bad', pdf: { uri: 'https://example.com/a.pdf', page: 1, zoom: 1 } },
    { id: 'duplicate', name: 'Good', markdown: { uri: 'file:///notes.md', scroll: 100 } },
    { id: 'both', name: 'Both', pdf: { uri: 'file:///a.pdf', page: 1, zoom: 1 }, markdown: { uri: 'file:///a.md', scroll: 0 } },
    { id: 'wrong', name: 'Wrong', profile_id: 'profile', pdf: { uri: 'file:///a.pdf', page: 1, zoom: 1 } },
    { id: 'bad_position', name: 'Bad position', pdf: { uri: 'file:///a.pdf', page: 0, zoom: 1 } },
    { id: 'ok', name: 'Terminal' },
  ] });
  assert.deepEqual(model.tabs.map(tab => tab.id), ['duplicate', 'ok']);
  assert.ok(is_markdown_tab(model.tabs[0]));
  assert.ok(is_terminal_tab(model.tabs[1]));
});

test('preview capacity is shared and restoration reserves space for new startup profiles', () => {
  const model = new sidebar_tabs([]);
  for (let index = 0; index < 8; index++) {
    if (index % 2) model.open_pdf(`file:///p${index}.pdf`, `PDF ${index}`);
    else model.open_markdown(`file:///p${index}.md`, `Markdown ${index}`);
  }
  assert.throws(() => model.open_pdf('file:///extra.pdf', 'Extra'), /maximum 8/);
  for (let index = 0; index < 32; index++) model.add_tab();
  const profiles = Array.from({ length: 32 }, (_, index) => ({ id: `profile_${index}`, name: `Profile ${index}`, command: '', shell: '' }));
  const restored = new sidebar_tabs(profiles, model.remember());
  assert.equal(restored.tabs.length, 64);
  assert.equal(restored.tabs.filter(tab => is_terminal_tab(tab) && tab.profile_id !== undefined).length, 32);
  assert.equal(restored.tabs.filter(is_pdf_tab).length, 4);
});

test('preview messages validate file types, positions and SyncTeX coordinates at the host boundary', () => {
  assert.ok(is_pdf_uri('file:///a%20b.pdf'));
  assert.ok(is_pdf_uri('vscode-remote://ssh-remote+host/home/a.pdf'));
  for (const value of ['file:///a%00.pdf', 'https://example.com/a.pdf', 'file:///a.pdf?query', 'file:///a.pdf#x', 'file:///a.md']) assert.equal(is_pdf_uri(value), false);
  assert.ok(is_pdf_position({ page: 3, zoom: 'page-width' }));
  for (const zoom of [0, Infinity, NaN, 5, 'cover']) assert.equal(is_pdf_position({ page: 1, zoom }), false);
  assert.ok(is_client_message({ type: 'load_pdf', id: 'one' }));
  assert.ok(is_client_message({ type: 'load_markdown', id: 'one' }));
  assert.ok(is_client_message({ type: 'pdf_reverse_sync', id: 'one', page: 3, x: 100.25, y: 200 }));
  for (const x of [-1, Infinity, NaN, '100', 100001]) assert.equal(is_client_message({ type: 'pdf_reverse_sync', id: 'one', page: 1, x, y: 1 }), false);
  assert.equal(is_client_message({ type: 'open_markdown_link', id: 'one', href: 'command:workbench.action.closeWindow' }), false);
  assert.equal(is_client_message({ type: 'markdown_position', id: 'one', position: { scroll: -1 } }), false);
});

test('PDF source associations survive restore and direct reopening without losing reading state', () => {
  const model = new sidebar_tabs([]);
  const pdf_uri = 'file:///project/build/pdf/main.pdf';
  const source_uri = 'file:///project/main.tex';
  const tab = model.open_pdf(pdf_uri, 'Main', source_uri);
  model.set_pdf_position(tab.id, { page: 8, zoom: 'page-fit' });
  assert.equal(model.open_pdf(pdf_uri, 'Direct PDF open').source_uri, source_uri);
  const restored = new sidebar_tabs([], model.remember());
  assert.deepEqual(restored.tabs, model.tabs);
  assert.equal(restored.open_pdf(pdf_uri, 'Main').source_uri, source_uri);
  assert.equal(restored.open_pdf(pdf_uri, 'Main', 'https://example.com/evil.tex').source_uri, source_uri);
  assert.equal(restored.open_pdf(pdf_uri, 'Main').page, 8);
});

test('invalid PDF source associations are discarded without dropping the PDF or its reading position', () => {
  const pdf_uri = 'vscode-remote://ssh-remote+one/project/build/main.pdf';
  const good = 'vscode-remote://ssh-remote+one/project/main.tex';
  assert.ok(is_pdf_source_uri(good, pdf_uri));
  for (const source_uri of [null, 42, 'file:///project/main.tex', 'vscode-remote://ssh-remote+two/project/main.tex',
    'vscode-remote://ssh-remote+one/project/main.md', 'vscode-remote://ssh-remote+one/project/main%00.tex',
    'vscode-remote://ssh-remote+one/project/main.tex?x', 'command:workbench.action.closeWindow']) {
    assert.equal(is_pdf_source_uri(source_uri, pdf_uri), false);
    const model = new sidebar_tabs([], { version: 1, tabs: [
      { id: 'pdf', name: 'Main', pdf: { uri: pdf_uri, source_uri, page: 9, zoom: 1.5 } },
    ], active_id: 'pdf', expanded_ids: ['pdf'], next_number: 0 });
    const tab = model.tabs[0];
    assert.ok(is_pdf_tab(tab));
    assert.equal(tab.source_uri, undefined);
    assert.equal(tab.page, 9);
    assert.equal(tab.zoom, 1.5);
  }
});
