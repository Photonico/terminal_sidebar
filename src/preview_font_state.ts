export const preview_fonts = [
  { label: 'Default', description: 'Follow VS Code', value: 'default' },
  { label: 'Editor font', description: 'Follow the editor font setting', value: 'editor' },
  { label: 'System font', description: 'Use the system interface font', value: 'system-ui' },
  { label: 'Serif', description: 'Use a serif font', value: 'serif' },
  { label: 'Sans serif', description: 'Use a sans serif font', value: 'sans-serif' },
  { label: 'Monospace', description: 'Use a monospace font', value: 'monospace' },
] as const;

const reserved_font_names = new Set(['default', 'inherit', 'initial', 'unset', 'revert', 'revert-layer']);
const generic_font_names = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong']);

function font_identifier(value: string): boolean {
  // CSS identifiers cannot start with an ASCII digit (including after one dash).
  const name_start = (character: string | undefined) => !!character
    && (/[a-z_]/i.test(character) || character.charCodeAt(0) >= 0x80);
  return !!value && (name_start(value[0]) || (value[0] === '-' && (value[1] === '-' || name_start(value[1]))))
    && !/[.'" ]/.test(value) && !reserved_font_names.has(value.toLowerCase());
}

/** A bounded list of quoted names or CSS identifiers; no declarations or resource URLs. */
export function valid_preview_font(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 256 || !value.trim()
    || !/^[\p{L}\p{N}\p{M}\s_,.'"-]*$/u.test(value) || /[\x00-\x1f\x7f]/.test(value)) return false;
  if (value.trim() === 'default' || value.trim() === 'editor') return true;
  let index = 0;
  const space = () => { while (value[index] === ' ') index++; };
  while (index < value.length) {
    space();
    const quote = value[index];
    if (quote === '"' || quote === "'") {
      const end = value.indexOf(quote, index + 1);
      if (end < 0 || !value.slice(index + 1, end).trim()) return false;
      index = end + 1;
    } else {
      const end = value.indexOf(',', index);
      const family = value.slice(index, end < 0 ? value.length : end).trim();
      const names = family.split(/ +/);
      if (!names.every(font_identifier) || (names.length > 1 && generic_font_names.has(names[0].toLowerCase()))) return false;
      index = end < 0 ? value.length : end;
    }
    space();
    if (index === value.length) return true;
    if (value[index++] !== ',') return false;
    space();
    if (index === value.length) return false;
  }
  return false;
}
