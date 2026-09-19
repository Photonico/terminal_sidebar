import { readFile as read_file, writeFile as write_file } from 'node:fs/promises';

// The allowlist must match the font/CSS actually shipped, including upstream aliases.
const package_root = new URL('../node_modules/@vscode/codicons/', import.meta.url);
const { version } = JSON.parse(await read_file(new URL('package.json', package_root), 'utf8'));
const css = await read_file(new URL('dist/codicon.css', package_root), 'utf8');
const names = [...new Set([...css.matchAll(/\.codicon-([a-z0-9-]+):before\s*\{/g)].map(match => match[1]))].sort();
if (!names.length) throw new Error('No Codicon glyphs found in the installed package.');

const rows = [];
for (let index = 0; index < names.length; index += 5) {
  rows.push(`  ${names.slice(index, index + 5).map(name => `'${name}'`).join(', ')},`);
}
const output = `// Generated from @vscode/codicons ${version}; run npm run generate:codicons to update.
// Names refer only to glyphs in the bundled font, never arbitrary CSS classes.
export const codicon_names: readonly string[] = Object.freeze([
${rows.join('\n')}
]);

const codicon_name_set = new Set(codicon_names);

export function is_codicon_name(value: unknown): value is string {
  return typeof value === 'string' && codicon_name_set.has(value);
}
`;
const target = new URL('../src/codicons.ts', import.meta.url);
// Windows checkouts may use CRLF; only content differences make the catalog stale.
if (process.argv.includes('--write')) {
  await write_file(target, output);
} else if ((await read_file(target, 'utf8')).replace(/\r\n/g, '\n') !== output) {
  throw new Error('Codicon catalog differs from the bundled package. Run npm run generate:codicons.');
}
