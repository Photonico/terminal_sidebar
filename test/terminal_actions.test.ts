import assert from 'node:assert/strict';
import { test } from 'node:test';
import { export_filename, terminal_file, web_link } from '../src/terminal_actions';

test('terminal web links allow HTTP(S) and reject command schemes, credentials and controls', () => {
  assert.equal(web_link('https://example.com/build?q=1#failure'), 'https://example.com/build?q=1#failure');
  for (const value of ['command:workbench.action.closeWindow', 'javascript:alert(1)', 'file:///etc/passwd', 'https://user:pass@example.com', 'https://example.com\n']) {
    assert.equal(web_link(value), undefined, value);
  }
});

test('compiler locations resolve relative to cwd without interpreting commands or network paths', () => {
  assert.equal(terminal_file('src/程序.ts', '/work/project', 'linux'), '/work/project/src/程序.ts');
  assert.equal(terminal_file('../other/file.ts', '/work/project', 'linux'), '/work/other/file.ts');
  assert.equal(terminal_file('~/project/file.ts', '/work', 'linux', '/home/user'), '/home/user/project/file.ts');
  assert.equal(terminal_file('file:///work/my%20project/file.ts', '/work', 'linux'), '/work/my project/file.ts');
  assert.equal(terminal_file('src\\app.ts', 'C:\\work', 'win32'), 'C:\\work\\src\\app.ts');
  assert.equal(terminal_file('file:///C:/work/app.ts', 'C:\\work', 'win32'), 'C:\\work\\app.ts');
  for (const value of ['https://example.com/code.ts', 'command:evil', 'file://server/share/file.ts', '//server/share/file.ts', '\\\\server\\share\\file.ts', 'file:///work/%00.ts', 'src/a\nb.ts']) {
    assert.equal(terminal_file(value, '/work', 'linux'), undefined, value);
  }
});

test('export filenames retain Unicode while removing path delimiters and trailing dots', () => {
  assert.equal(export_filename('构建/result:1', 'html'), '构建_result_1.html');
  assert.equal(export_filename('test...', 'text'), 'test.txt');
  assert.equal(export_filename('...', 'text'), 'terminal.txt');
  assert.equal(export_filename('CON', 'html'), '_CON.html');
});
