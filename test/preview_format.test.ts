import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markdown_extensions, preview_extensions, preview_kind } from '../src/preview_format';

test('preview routing supports local and remote documents, Markdown aliases and encoded filenames', () => {
  for (const scheme of ['file://', 'vscode-remote://ssh-remote+example']) {
    for (const extension of markdown_extensions) {
      assert.equal(preview_kind(`${scheme}/project/my%20notes.${extension.toUpperCase()}`), 'markdown');
    }
    assert.equal(preview_kind(`${scheme}/project/paper.PDF`), 'pdf');
    assert.equal(preview_kind(`${scheme}/project/paper.TEX`), 'latex');
    assert.equal(preview_kind(`${scheme}/project/paper.%74ex`), 'latex');
    for (const extension of ['html', 'htm', 'css', 'json', 'jsonc']) {
      assert.equal(preview_kind(`${scheme}/project/example.${extension}`), extension === 'htm' ? 'html' : extension);
    }
  }
  assert.equal(new Set(preview_extensions).size, preview_extensions.length);
});

test('preview routing refuses unsupported formats, virtual documents and ambiguous URI targets', () => {
  for (const extension of ['pdf', 'md', 'tex', 'html', 'css', 'json', 'jsonc']) {
    for (const uri of [
      `https://example.com/document.${extension}`,
      `untitled:/document.${extension}`,
      `vscode-remote://name:password@host/document.${extension}`,
      `file:///document.${extension}?alternate=1`,
      `file:///document.${extension}#chapter`,
      `file:///bad%00name.${extension}`,
      `file:///bad%1fname.${extension}`,
      `file:///bad%name.${extension}`,
      `file:///bad\nname.${extension}`,
      `file:///${'a'.repeat(8192)}.${extension}`,
    ]) assert.equal(preview_kind(uri), undefined, uri);
  }
  for (const extension of ['js', 'xml', 'yaml', 'txt', 'docx']) {
    assert.equal(preview_kind(`file:///document.${extension}`), undefined);
  }
  assert.equal(preview_kind('not a URI'), undefined);
});
