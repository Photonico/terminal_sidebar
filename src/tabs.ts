import { is_identifier, is_tab_name, parse_profiles } from './profiles';
import { is_local_cwd } from './shell_state';
import { copy_tab_marker, is_tab_marker, type tab_marker } from './tab_marker';
import { is_pdf_tab, is_markdown_tab, is_document_tab, is_terminal_tab, type terminal_profile, type terminal_tab, type sidebar_tab, type pdf_tab, type markdown_tab, type document_tab } from './types';
import { document_format_for_uri, is_document_position, type document_format, type document_position } from './document_state';
import { is_markdown_uri, is_markdown_position, type markdown_position } from './markdown_state';
import { is_pdf_uri, is_pdf_source_uri, is_pdf_position, copy_pdf_position, type pdf_position } from './pdf_state';

export interface remembered_tab {
  id: string;
  name: string;
  profile_id?: string;
  renamed?: true;
  cwd?: string;
  marker?: tab_marker;
  pdf?: { uri: string; source_uri?: string } & pdf_position;
  markdown?: { uri: string } & markdown_position;
  document?: { uri: string; format: document_format } & document_position;
}

/** Workspace-local layout, decoration, and last known cwd. Shells, commands, input, and output never belong here. */
export interface tab_memory {
  version: 1;
  tabs: remembered_tab[];
  active_id?: string;
  expanded_ids: string[];
  next_number: number;
}

const maximum_tabs = 64;
const maximum_temporary_tabs = 32;

function copy_tab<tab_type extends sidebar_tab>(tab: tab_type): tab_type {
  return {
    ...tab,
    ...(is_terminal_tab(tab) && tab.args !== undefined ? { args: [...tab.args] } : {}),
    ...(is_terminal_tab(tab) && tab.env !== undefined ? { env: { ...tab.env } } : {}),
    ...(tab.marker === undefined ? {} : { marker: copy_tab_marker(tab.marker) }),
  };
}

/** Sanitize each remembered descriptor separately so one damaged entry cannot erase the rest. */
function read_memory(value: unknown): tab_memory {
  const empty: tab_memory = { version: 1, tabs: [], expanded_ids: [], next_number: 0 };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return empty;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.tabs)) {
    return empty;
  }

  const identifiers = new Set<string>();
  for (const entry of record.tabs.slice(0, maximum_tabs)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const { id, name, profile_id, renamed, cwd, marker, pdf, markdown, document } = entry as Record<string, unknown>;
    if (!is_identifier(id) || identifiers.has(id) || !is_tab_name(name)) {
      continue;
    }
    if (profile_id !== undefined && !is_identifier(profile_id)) {
      continue;
    }
    const descriptor: remembered_tab = { id, name: name.trim() };
    if ([pdf, markdown, document].filter(value => value !== undefined).length > 1) continue;
    if (pdf !== undefined) {
      const uri = pdf && typeof pdf === 'object' && 'uri' in pdf ? pdf.uri : undefined;
      if (profile_id !== undefined || markdown !== undefined || !is_pdf_position(pdf) || !is_pdf_uri(uri)) continue;
      descriptor.pdf = { uri, ...copy_pdf_position(pdf) };
      const source_uri = 'source_uri' in pdf ? pdf.source_uri : undefined;
      if (is_pdf_source_uri(source_uri, uri)) descriptor.pdf.source_uri = source_uri;
    }
    if (markdown !== undefined) {
      const uri = markdown && typeof markdown === 'object' && 'uri' in markdown ? markdown.uri : undefined;
      if (profile_id !== undefined || !is_markdown_position(markdown) || !is_markdown_uri(uri)) continue;
      descriptor.markdown = { uri, scroll: markdown.scroll };
    }
    if (document !== undefined) {
      const uri = document && typeof document === 'object' && 'uri' in document ? document.uri : undefined;
      const format = document_format_for_uri(uri);
      if (profile_id !== undefined || typeof uri !== 'string' || !format || !is_document_position(document)
        || !('format' in document) || document.format !== format) continue;
      descriptor.document = { uri, format, scroll: document.scroll };
    }
    identifiers.add(id);
    if (profile_id !== undefined) {
      descriptor.profile_id = profile_id;
    }
    if (renamed === true) {
      descriptor.renamed = true;
    }
    if (is_local_cwd(cwd)) descriptor.cwd = cwd;
    if (is_tab_marker(marker)) descriptor.marker = copy_tab_marker(marker);
    empty.tabs.push(descriptor);
  }
  if (is_identifier(record.active_id)) {
    empty.active_id = record.active_id;
  }
  if (Array.isArray(record.expanded_ids)) {
    empty.expanded_ids = record.expanded_ids.slice(0, maximum_tabs).filter(is_identifier);
  }
  if (Number.isSafeInteger(record.next_number) && Number(record.next_number) >= 0 && Number(record.next_number) <= 1_000_000_000) {
    empty.next_number = Number(record.next_number);
  }
  return empty;
}

/**
 * One side's open tabs, independent from both the other side and saved startup settings.
 * Construct once per window: remembered temporary tabs return, and all startup profiles reopen.
 * The host owns processes. This class only changes the layout and returns safe snapshots.
 */
export class sidebar_tabs {
  private current_tabs: sidebar_tab[] = [];
  private selected_id: string | undefined;
  private expanded = new Set<string>();
  private renamed_profiles = new Set<string>();
  private next_number = 0;
  private next_identifier = 0;

  constructor(startup_profiles: readonly terminal_profile[], remembered?: unknown) {
    const profiles = parse_profiles(startup_profiles);
    const profiles_by_id = new Map(profiles.map(profile => [profile.id, profile]));
    const restored_profiles = new Set<string>();
    const memory = read_memory(remembered);
    let temporary_count = 0;
    let preview_count = 0;

    // Restore the previous order; removed startup settings cannot recover an old command.
    for (const descriptor of memory.tabs) {
      // Reserve room for every current startup profile, including newly added ones.
      if (descriptor.profile_id === undefined && temporary_count + preview_count >= maximum_tabs - profiles.length) continue;
      if (descriptor.pdf) {
        if (preview_count >= 8 || this.current_tabs.some(tab => is_pdf_tab(tab) && tab.uri === descriptor.pdf!.uri)) continue;
        this.current_tabs.push({ id: descriptor.id, name: descriptor.name, kind: 'pdf', ...descriptor.pdf,
          ...(descriptor.marker === undefined ? {} : { marker: copy_tab_marker(descriptor.marker) }) });
        preview_count++;
      } else if (descriptor.markdown) {
        const state = descriptor.markdown;
        if (preview_count >= 8 || this.current_tabs.some(tab => is_markdown_tab(tab) && tab.uri === state.uri)) continue;
        this.current_tabs.push({ id: descriptor.id, name: descriptor.name, kind: 'markdown', ...state,
          ...(descriptor.marker === undefined ? {} : { marker: copy_tab_marker(descriptor.marker) }) });
        preview_count++;
      } else if (descriptor.document) {
        const state = descriptor.document;
        if (preview_count >= 8 || this.current_tabs.some(tab => is_document_tab(tab) && tab.uri === state.uri)) continue;
        this.current_tabs.push({ id: descriptor.id, name: descriptor.name, kind: 'document', ...state,
          ...(descriptor.marker === undefined ? {} : { marker: copy_tab_marker(descriptor.marker) }) });
        preview_count++;
      } else if (descriptor.profile_id !== undefined) {
        const profile = profiles_by_id.get(descriptor.profile_id);
        if (!profile || restored_profiles.has(profile.id)) {
          continue;
        }
        const name = descriptor.renamed ? descriptor.name : profile.name;
        this.current_tabs.push({ ...profile, id: descriptor.id, name, profile_id: profile.id,
          ...(descriptor.cwd === undefined ? {} : { cwd: descriptor.cwd }),
          ...(descriptor.marker === undefined ? {} : { marker: copy_tab_marker(descriptor.marker) }) });
        if (descriptor.renamed) {
          this.renamed_profiles.add(descriptor.id);
        }
        restored_profiles.add(profile.id);
      } else if (temporary_count < maximum_temporary_tabs) {
        this.current_tabs.push({ id: descriptor.id, name: descriptor.name, command: '', shell: '',
          ...(descriptor.cwd === undefined ? {} : { cwd: descriptor.cwd }),
          ...(descriptor.marker === undefined ? {} : { marker: copy_tab_marker(descriptor.marker) }) });
        temporary_count += 1;
      }
    }
    this.next_number = temporary_count === 0 ? 0 : memory.next_number;
    for (const tab of this.current_tabs) {
      if (memory.expanded_ids.includes(tab.id)) {
        this.expanded.add(tab.id);
      }
    }

    // Closing a runtime tab never removes its startup setting: it returns next window.
    for (const profile of profiles) {
      if (!restored_profiles.has(profile.id)) {
        this.append_profile(profile);
      }
    }
    this.selected_id = this.current_tabs.some(tab => tab.id === memory.active_id)
      ? memory.active_id : this.current_tabs[0]?.id;
  }

  get tabs(): sidebar_tab[] {
    return this.current_tabs.map(copy_tab);
  }

  get active_id(): string | undefined {
    return this.selected_id;
  }

  get expanded_ids(): string[] {
    return this.current_tabs.filter(tab => this.expanded.has(tab.id)).map(tab => tab.id);
  }

  /** Number ordinary tabs upward, restarting from zero after all are closed and skipping occupied names. */
  add_tab(): terminal_tab {
    this.assert_capacity();
    if (this.current_tabs.filter(tab => is_terminal_tab(tab) && tab.profile_id === undefined).length >= maximum_temporary_tabs) {
      throw new Error('Each sidebar supports at most 32 temporary terminal tabs. Close one before adding another.');
    }
    const names = new Set(this.current_tabs.map(tab => tab.name));
    let name = `Term ${this.next_number++}`;
    while (names.has(name)) {
      name = `Term ${this.next_number++}`;
    }
    const tab: terminal_tab = { id: this.create_identifier(), name, command: '', shell: '' };
    this.current_tabs.push(tab);
    this.selected_id = tab.id;
    this.expanded.add(tab.id);
    return copy_tab(tab);
  }

  /** Reopen a startup profile on demand, or select its existing runtime tab without restarting it. */
  open_profile(value: terminal_profile): terminal_tab {
    const profile = parse_profiles([value])[0];
    const existing = this.current_tabs.find((tab): tab is terminal_tab => is_terminal_tab(tab) && tab.profile_id === profile.id);
    const tab = existing ?? this.append_profile(profile);
    this.selected_id = tab.id;
    this.expanded.add(tab.id);
    return copy_tab(tab);
  }

  open_pdf(uri: string, name: string, source_uri?: string): pdf_tab {
    if (!is_pdf_uri(uri) || !is_tab_name(name)) throw new Error('Choose a local PDF file.');
    let tab = this.current_tabs.find((item): item is pdf_tab => is_pdf_tab(item) && item.uri === uri);
    if (!tab) {
      this.assert_capacity();
      if (this.current_tabs.filter(tab => !is_terminal_tab(tab)).length >= 8) throw new Error('Close a preview tab before opening another (maximum 8 per sidebar).');
      tab = { kind: 'pdf', id: this.create_identifier(), name: name.trim(), uri, page: 1, zoom: 'page-width' };
      this.current_tabs.push(tab);
    }
    if (is_pdf_source_uri(source_uri, uri)) tab.source_uri = source_uri;
    this.selected_id = tab.id;
    this.expanded.add(tab.id);
    return copy_tab(tab);
  }

  open_markdown(uri: string, name: string): markdown_tab {
    if (!is_markdown_uri(uri) || !is_tab_name(name)) throw new Error('Choose a local Markdown file.');
    let tab = this.current_tabs.find((item): item is markdown_tab => is_markdown_tab(item) && item.uri === uri);
    if (!tab) {
      this.assert_capacity();
      if (this.current_tabs.filter(item => !is_terminal_tab(item)).length >= 8) {
        throw new Error('Close a preview tab before opening another (maximum 8 per sidebar).');
      }
      tab = { kind: 'markdown', id: this.create_identifier(), name: name.trim(), uri, scroll: 0 };
      this.current_tabs.push(tab);
    }
    this.selected_id = tab.id;
    this.expanded.add(tab.id);
    return copy_tab(tab);
  }

  set_markdown_position(id: string, position: markdown_position): boolean {
    const tab = this.current_tabs.find(tab => tab.id === id);
    if (!tab || !is_markdown_tab(tab) || !is_markdown_position(position) || tab.scroll === position.scroll) return false;
    tab.scroll = position.scroll;
    return true;
  }

  open_document(uri: string, name: string): document_tab {
    const format = document_format_for_uri(uri);
    if (!format || !is_tab_name(name)) throw new Error('Choose an HTML, CSS, JSON or JSONC file.');
    let tab = this.current_tabs.find((item): item is document_tab => is_document_tab(item) && item.uri === uri);
    if (!tab) {
      this.assert_capacity();
      if (this.current_tabs.filter(item => !is_terminal_tab(item)).length >= 8) {
        throw new Error('Close a preview tab before opening another (maximum 8 per sidebar).');
      }
      tab = { kind: 'document', id: this.create_identifier(), name: name.trim(), uri, format, scroll: 0 };
      this.current_tabs.push(tab);
    }
    this.selected_id = tab.id;
    this.expanded.add(tab.id);
    return copy_tab(tab);
  }

  set_document_position(id: string, position: document_position): boolean {
    const tab = this.current_tabs.find(tab => tab.id === id);
    if (!tab || !is_document_tab(tab) || !is_document_position(position) || tab.scroll === position.scroll) return false;
    tab.scroll = position.scroll;
    return true;
  }

  set_pdf_position(id: string, position: pdf_position): boolean {
    const tab = this.current_tabs.find(tab => tab.id === id);
    if (!tab || !is_pdf_tab(tab) || !is_pdf_position(position)
      || (tab.page === position.page && tab.zoom === position.zoom
        && tab.mode === position.mode && tab.dark === position.dark)) return false;
    tab.page = position.page;
    tab.zoom = position.zoom;
    if (position.mode === undefined) delete tab.mode; else tab.mode = position.mode;
    if (position.dark === undefined) delete tab.dark; else tab.dark = position.dark;
    return true;
  }

  /** Select the right neighbour after closing, or the left neighbour when closing the last tab. */
  close_tab(identifier: string): boolean {
    const index = this.current_tabs.findIndex(tab => tab.id === identifier);
    if (index < 0) {
      return false;
    }
    this.current_tabs.splice(index, 1);
    if (!this.current_tabs.some(tab => is_terminal_tab(tab) && tab.profile_id === undefined)) {
      this.next_number = 0;
    }
    this.expanded.delete(identifier);
    this.renamed_profiles.delete(identifier);
    if (this.selected_id === identifier) {
      this.selected_id = this.current_tabs[Math.min(index, this.current_tabs.length - 1)]?.id;
    }
    return true;
  }

  /** Runtime names are remembered, but never written back into the startup profile. */
  rename_tab(identifier: string, name: string): boolean {
    const tab = this.current_tabs.find(entry => entry.id === identifier);
    if (!tab || !is_tab_name(name)) {
      return false;
    }
    const trimmed_name = name.trim();
    if (tab.name === trimmed_name) {
      return false;
    }
    tab.name = trimmed_name;
    if (is_terminal_tab(tab) && tab.profile_id !== undefined) {
      this.renamed_profiles.add(identifier);
    }
    return true;
  }

  /** Move relative to a still-open tab, preserving selection, expansion, and runtime identity. */
  move_tab(identifier: string, target_identifier: string, placement: 'before' | 'after'): boolean {
    const source_index = this.current_tabs.findIndex(tab => tab.id === identifier);
    const target_index = this.current_tabs.findIndex(tab => tab.id === target_identifier);
    if (source_index < 0 || target_index < 0 || source_index === target_index) {
      return false;
    }
    // Removing the source shifts every later target left by one position.
    const destination_index = target_index + (placement === 'after' ? 1 : 0)
      - (source_index < target_index ? 1 : 0);
    if (source_index === destination_index) {
      return false;
    }
    const [tab] = this.current_tabs.splice(source_index, 1);
    this.current_tabs.splice(destination_index, 0, tab);
    return true;
  }

  select_tab(identifier: string): boolean {
    if (!this.current_tabs.some(tab => tab.id === identifier)) {
      return false;
    }
    this.selected_id = identifier;
    return true;
  }

  set_expanded(identifier: string, expanded: boolean): boolean {
    if (!this.current_tabs.some(tab => tab.id === identifier)) {
      return false;
    }
    if (expanded) {
      this.expanded.add(identifier);
    } else {
      this.expanded.delete(identifier);
    }
    return true;
  }

  /** Remember a local directory separately from the synced startup profile. */
  set_cwd(identifier: string, cwd: string): boolean {
    const tab = this.current_tabs.find(entry => entry.id === identifier);
    if (!tab || !is_terminal_tab(tab) || !is_local_cwd(cwd) || tab.cwd === cwd) return false;
    tab.cwd = cwd;
    return true;
  }

  /** Markers are runtime preferences, stored locally without changing startup settings. */
  set_marker(identifier: string, marker: tab_marker | undefined): boolean {
    if (marker !== undefined && !is_tab_marker(marker)) return false;
    const tab = this.current_tabs.find(entry => entry.id === identifier);
    if (!tab || (tab.marker?.icon === marker?.icon && tab.marker?.color === marker?.color)) return false;
    if (marker === undefined) delete tab.marker;
    else tab.marker = copy_tab_marker(marker);
    return true;
  }

  /** Deliberately enumerate the persisted fields. Never spread a runtime tab into storage. */
  remember(): tab_memory {
    const descriptors: remembered_tab[] = [];
    for (const tab of this.current_tabs) {
      const descriptor: remembered_tab = { id: tab.id, name: tab.name };
      if (is_terminal_tab(tab) && tab.profile_id !== undefined) {
        descriptor.profile_id = tab.profile_id;
      }
      if (this.renamed_profiles.has(tab.id)) {
        descriptor.renamed = true;
      }
      if (is_terminal_tab(tab) && tab.cwd !== undefined) descriptor.cwd = tab.cwd;
      if (is_pdf_tab(tab)) descriptor.pdf = { uri: tab.uri, ...copy_pdf_position(tab),
        ...(tab.source_uri === undefined ? {} : { source_uri: tab.source_uri }) };
      if (is_markdown_tab(tab)) descriptor.markdown = { uri: tab.uri, scroll: tab.scroll };
      if (is_document_tab(tab)) descriptor.document = { uri: tab.uri, format: tab.format, scroll: tab.scroll };
      if (tab.marker !== undefined) descriptor.marker = copy_tab_marker(tab.marker);
      descriptors.push(descriptor);
    }
    return {
      version: 1,
      tabs: descriptors,
      ...(this.selected_id === undefined ? {} : { active_id: this.selected_id }),
      expanded_ids: this.expanded_ids,
      next_number: this.next_number,
    };
  }

  private append_profile(profile: terminal_profile): terminal_tab {
    this.assert_capacity();
    const tab = { ...profile, id: this.create_identifier(), profile_id: profile.id };
    this.current_tabs.push(tab);
    this.expanded.add(tab.id);
    return tab;
  }

  private assert_capacity(): void {
    if (this.current_tabs.length >= maximum_tabs) {
      throw new Error('Each sidebar supports at most 64 open terminal tabs. Close one before adding another.');
    }
  }

  private create_identifier(): string {
    let identifier = `tab_${this.next_identifier++}`;
    while (this.current_tabs.some(tab => tab.id === identifier)) {
      identifier = `tab_${this.next_identifier++}`;
    }
    return identifier;
  }
}
