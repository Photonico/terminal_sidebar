import { codicon_names } from '../src/codicons';
import './codicon_picker.css';

const common_icons = ['bookmark', 'tag', 'flag', 'star', 'ask'] as const;

export function codicon(icon: string): HTMLSpanElement {
  const glyph = document.createElement('span');
  glyph.className = `codicon codicon-${icon}`;
  glyph.setAttribute('aria-hidden', 'true');
  return glyph;
}

interface codicon_picker_options {
  change(icon: string): void;
  layout(): void;
}

/** A short favourites row plus a keyboard-searchable dropdown of the bundled icon font. */
export class codicon_picker {
  readonly root = document.createElement('fieldset');
  private readonly common = new Map<string, HTMLButtonElement>();
  private readonly others = document.createElement('button');
  private readonly dropdown = document.createElement('div');
  private readonly search = document.createElement('input');
  private readonly list = document.createElement('div');
  private readonly empty = document.createElement('p');
  private choices: HTMLButtonElement[] = [];
  private active_index = -1;
  private selected = 'bookmark';

  constructor(private readonly options: codicon_picker_options) {
    this.root.className = 'codicon_picker';
    const legend = document.createElement('legend');
    legend.textContent = 'Icon';
    const row = document.createElement('div');
    row.className = 'codicon_common';
    for (const name of common_icons) {
      const button = document.createElement('button');
      button.type = 'button';
      button.title = name;
      button.setAttribute('aria-label', name);
      button.append(codicon(name));
      button.addEventListener('click', () => this.choose(name));
      this.common.set(name, button);
      row.append(button);
    }
    this.others.type = 'button';
    this.others.className = 'codicon_others';
    this.others.textContent = 'Others';
    this.others.setAttribute('aria-expanded', 'false');
    this.others.addEventListener('click', () => this.toggle());
    row.append(this.others);

    this.dropdown.className = 'codicon_dropdown';
    this.dropdown.hidden = true;
    this.search.type = 'search';
    this.search.placeholder = 'Search Codicons';
    this.search.setAttribute('aria-label', 'Search all Codicons');
    this.search.setAttribute('role', 'combobox');
    this.search.setAttribute('aria-autocomplete', 'list');
    this.search.setAttribute('aria-controls', 'codicon_options');
    this.search.setAttribute('aria-expanded', 'false');
    this.search.addEventListener('input', () => this.filter());
    this.list.id = 'codicon_options';
    this.list.className = 'codicon_options';
    this.list.role = 'listbox';
    this.list.setAttribute('aria-label', 'All Codicons');
    this.empty.textContent = 'No matching icons.';
    this.empty.role = 'status';
    this.empty.hidden = true;
    this.dropdown.append(this.search, this.list, this.empty);
    this.dropdown.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.close(true);
        this.options.layout();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        const count = this.choices.length;
        if (count) this.highlight((this.active_index + (event.key === 'ArrowDown' ? 1 : count - 1) + count) % count);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        this.choices[this.active_index]?.click();
      }
    });
    this.root.append(legend, row, this.dropdown);
  }

  set(icon: string): void {
    this.selected = icon;
    for (const [name, button] of this.common) button.setAttribute('aria-pressed', String(name === icon));
    this.others.dataset.selected = String(!this.common.has(icon));
    this.others.title = this.common.has(icon) ? 'Choose from all Codicons' : `Selected icon: ${icon}`;
  }

  close(restore = false): void {
    this.dropdown.hidden = true;
    this.others.setAttribute('aria-expanded', 'false');
    this.search.setAttribute('aria-expanded', 'false');
    this.search.removeAttribute('aria-activedescendant');
    if (restore) this.others.focus();
  }

  private toggle(): void {
    if (!this.dropdown.hidden) {
      this.close(true);
    } else {
      this.search.value = '';
      this.dropdown.hidden = false;
      this.others.setAttribute('aria-expanded', 'true');
      this.search.setAttribute('aria-expanded', 'true');
      this.filter();
      this.search.focus();
    }
    this.options.layout();
  }

  private filter(): void {
    const query = this.search.value.trim().toLowerCase().replace(/[ _]+/g, '-');
    const names = codicon_names.filter(name => name.includes(query));
    this.choices = names.map(name => {
      const option = document.createElement('button');
      option.type = 'button';
      option.role = 'option';
      option.id = `codicon_option_${name}`;
      option.tabIndex = -1;
      option.setAttribute('aria-selected', String(name === this.selected));
      const caption = document.createElement('span');
      caption.textContent = name;
      option.append(codicon(name), caption);
      option.addEventListener('click', () => this.choose(name));
      return option;
    });
    this.list.replaceChildren(...this.choices);
    this.empty.hidden = names.length !== 0;
    this.highlight(names.length ? Math.max(0, names.indexOf(this.selected)) : -1);
    this.options.layout();
  }

  private highlight(index: number): void {
    this.choices[this.active_index]?.removeAttribute('data-highlighted');
    this.active_index = index;
    const option = this.choices[index];
    if (option) {
      option.dataset.highlighted = 'true';
      this.search.setAttribute('aria-activedescendant', option.id);
      option.scrollIntoView({ block: 'nearest' });
    } else this.search.removeAttribute('aria-activedescendant');
  }

  private choose(icon: string): void {
    const from_dropdown = !this.dropdown.hidden;
    this.set(icon);
    this.close();
    if (from_dropdown) (this.common.get(icon) ?? this.others).focus();
    this.options.change(icon);
    this.options.layout();
  }
}
