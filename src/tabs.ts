import { is_identifier, is_tab_name, parse_profiles } from './profiles';
import { is_local_cwd } from './shell_state';
import { is_tab_color, type tab_color } from './tab_color';
import { is_tab_marker } from './tab_marker';
import type { terminal_profile, terminal_tab } from './types';

export interface remembered_tab {
  id: string;
  name: string;
  profile_id?: string;
  renamed?: true;
  cwd?: string;
  name_color?: tab_color;
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

function copy_tab(tab: terminal_tab): terminal_tab {
  return {
    ...tab,
    ...(tab.args === undefined ? {} : { args: [...tab.args] }),
    ...(tab.env === undefined ? {} : { env: { ...tab.env } }),
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
    const { id, name, profile_id, renamed, cwd, name_color, marker } = entry as Record<string, unknown>;
    if (!is_identifier(id) || identifiers.has(id) || !is_tab_name(name)) {
      continue;
    }
    if (profile_id !== undefined && !is_identifier(profile_id)) {
      continue;
    }
    identifiers.add(id);
    const descriptor: remembered_tab = { id, name: name.trim() };
    if (profile_id !== undefined) {
      descriptor.profile_id = profile_id;
    }
    if (renamed === true) {
      descriptor.renamed = true;
    }
    if (is_local_cwd(cwd)) descriptor.cwd = cwd;
    if (is_tab_color(name_color)) descriptor.name_color = name_color;
    // Migrate only when no newer preference exists; an invalid explicit value must not resurrect a marker.
    else if (!Object.hasOwn(entry, 'name_color') && is_tab_marker(marker)) descriptor.name_color = marker.color;
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
  private current_tabs: terminal_tab[] = [];
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

    // Restore the previous order; removed startup settings cannot recover an old command.
    for (const descriptor of memory.tabs) {
      if (descriptor.profile_id !== undefined) {
        const profile = profiles_by_id.get(descriptor.profile_id);
        if (!profile || restored_profiles.has(profile.id)) {
          continue;
        }
        const name = descriptor.renamed ? descriptor.name : profile.name;
        this.current_tabs.push({ ...profile, id: descriptor.id, name, profile_id: profile.id,
          ...(descriptor.cwd === undefined ? {} : { cwd: descriptor.cwd }),
          ...(descriptor.name_color === undefined ? {} : { name_color: descriptor.name_color }) });
        if (descriptor.renamed) {
          this.renamed_profiles.add(descriptor.id);
        }
        restored_profiles.add(profile.id);
      } else if (temporary_count < maximum_temporary_tabs) {
        this.current_tabs.push({ id: descriptor.id, name: descriptor.name, command: '', shell: '',
          ...(descriptor.cwd === undefined ? {} : { cwd: descriptor.cwd }),
          ...(descriptor.name_color === undefined ? {} : { name_color: descriptor.name_color }) });
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

  get tabs(): terminal_tab[] {
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
    if (this.current_tabs.filter(tab => tab.profile_id === undefined).length >= maximum_temporary_tabs) {
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
    const existing = this.current_tabs.find(tab => tab.profile_id === profile.id);
    const tab = existing ?? this.append_profile(profile);
    this.selected_id = tab.id;
    this.expanded.add(tab.id);
    return copy_tab(tab);
  }

  /** Select the right neighbour after closing, or the left neighbour when closing the last tab. */
  close_tab(identifier: string): boolean {
    const index = this.current_tabs.findIndex(tab => tab.id === identifier);
    if (index < 0) {
      return false;
    }
    this.current_tabs.splice(index, 1);
    if (!this.current_tabs.some(tab => tab.profile_id === undefined)) {
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
    if (tab.profile_id !== undefined) {
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
    if (!tab || !is_local_cwd(cwd) || tab.cwd === cwd) return false;
    tab.cwd = cwd;
    return true;
  }

  /** Name colors are runtime preferences, stored locally without changing startup settings. */
  set_color(identifier: string, color: tab_color | undefined): boolean {
    if (color !== undefined && !is_tab_color(color)) return false;
    const tab = this.current_tabs.find(entry => entry.id === identifier);
    if (!tab || tab.name_color === color) return false;
    if (color === undefined) delete tab.name_color;
    else tab.name_color = color;
    return true;
  }

  /** Deliberately enumerate the persisted fields. Never spread a runtime tab into storage. */
  remember(): tab_memory {
    const descriptors: remembered_tab[] = [];
    for (const tab of this.current_tabs) {
      const descriptor: remembered_tab = { id: tab.id, name: tab.name };
      if (tab.profile_id !== undefined) {
        descriptor.profile_id = tab.profile_id;
      }
      if (this.renamed_profiles.has(tab.id)) {
        descriptor.renamed = true;
      }
      if (tab.cwd !== undefined) descriptor.cwd = tab.cwd;
      if (tab.name_color !== undefined) descriptor.name_color = tab.name_color;
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
