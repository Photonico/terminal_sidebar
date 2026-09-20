import { is_identifier } from './profiles';
import { copy_tab_marker, is_tab_marker, type tab_marker } from './tab_marker';
import type { sidebar_side } from './types';
import { is_pdf_uri } from './pdf_state';
import { is_markdown_uri } from './markdown_state';
import { is_document_uri } from './document_state';
import { randomUUID as random_uuid, createHash as create_hash } from 'node:crypto';
import { closeSync as close_sync, openSync as open_sync, readSync as read_sync } from 'node:fs';
import { link, mkdir, readdir, rename, unlink, writeFile as write_file } from 'node:fs/promises';
import * as path from 'node:path';

/** Startup profile IDs and document URIs are stable across workspaces. */
interface marker_target { kind?: string; profile_id?: string; uri?: string; marker?: tab_marker }
export interface marker_storage {
  get(key: string): unknown;
}

const key_prefix = 'terminalSidebar.profileMarker.v1.';
const legacy_key = 'terminalSidebar.profileMarkers';
const maximum_entries = 1024;
const maximum_bytes = 1024;

function profile_key(side: sidebar_side, tab: marker_target): string | undefined {
  if ((side !== 'left' && side !== 'right') || (tab.kind !== undefined && tab.kind !== 'terminal')
    || !is_identifier(tab.profile_id)) return undefined;
  return `${key_prefix}${side}.${tab.profile_id}`;
}

function read_marker(value: unknown): tab_marker | null | undefined {
  return value === null ? null : is_tab_marker(value) ? copy_tab_marker(value) : undefined;
}

/** Independent files avoid Memento's whole-extension snapshots when multiple windows save together. */
export class marker_memory {
  private read_error_reported = false;

  constructor(
    private readonly directory: string,
    private readonly storage: marker_storage,
    private readonly report_error: (message: string) => void = () => {},
  ) {}

  private filename(side: sidebar_side, tab: marker_target): string | undefined {
    if ((tab.kind === 'pdf' && is_pdf_uri(tab.uri)) || (tab.kind === 'markdown' && is_markdown_uri(tab.uri))
      || (tab.kind === 'document' && is_document_uri(tab.uri))) {
      const identity = create_hash('sha256').update(tab.uri!).digest('hex');
      return path.join(this.directory, `document_${identity}.json`);
    }
    return profile_key(side, tab) ? path.join(this.directory, `${side}_${tab.profile_id}.json`) : undefined;
  }

  /** Read one bounded file; a storage failure must never stop terminal startup. */
  private read(filename: string): tab_marker | null | undefined {
    let descriptor: number | undefined;
    try {
      descriptor = open_sync(filename, 'r');
      const bytes = Buffer.alloc(maximum_bytes + 1);
      const size = read_sync(descriptor, bytes, 0, bytes.length, 0);
      if (size > maximum_bytes) throw new Error('Marker record is too large.');
      const value: unknown = JSON.parse(bytes.subarray(0, size).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid marker record.');
      const record = value as Record<string, unknown>;
      const marker = record.version === 1 && Object.keys(record).length === 2 ? read_marker(record.marker) : undefined;
      if (marker === undefined) throw new Error('Invalid marker record.');
      return marker;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !this.read_error_reported) {
        this.read_error_reported = true;
        this.report_error('A shared tab marker could not be read. Existing workspace markers are preserved.');
      }
      return undefined;
    } finally {
      if (descriptor !== undefined) close_sync(descriptor);
    }
  }

  private legacy_marker(side: sidebar_side, tab: marker_target): tab_marker | null | undefined {
    const key = profile_key(side, tab);
    if (!key) return undefined;
    const individual = read_marker(this.storage.get(key));
    if (individual !== undefined) return individual;
    const value = this.storage.get(legacy_key);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const memory = value as Record<string, unknown>;
    if (memory.version !== 1 || !Array.isArray(memory.entries)) return undefined;
    for (const value of memory.entries.slice(0, maximum_entries)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      if (entry.side === side && entry.profile_id === tab.profile_id) {
        const marker = read_marker(entry.marker);
        if (marker !== undefined) return marker;
      }
    }
    return undefined;
  }

  /** Import old workspace choices once. Explicit shared removals always win. */
  async migrate(side: sidebar_side, tabs: readonly marker_target[]): Promise<void> {
    for (const tab of tabs) {
      const filename = this.filename(side, tab);
      if (!filename || this.read(filename) !== undefined) continue;
      const legacy = this.legacy_marker(side, tab);
      const marker = legacy !== undefined ? legacy : read_marker(tab.marker);
      if (marker !== undefined) await this.persist(side, tab, marker ?? undefined, true);
    }
  }

  /** Read fresh storage on every lookup; temporary tabs stay workspace-local. */
  marker_for(side: sidebar_side, tab: marker_target): tab_marker | undefined {
    const filename = this.filename(side, tab);
    const current = filename ? this.read(filename) : undefined;
    const legacy = filename && current === undefined ? this.legacy_marker(side, tab) : undefined;
    const marker = current !== undefined ? current : legacy !== undefined ? legacy : tab.marker;
    return is_tab_marker(marker) ? copy_tab_marker(marker) : undefined;
  }

  /** Replace only this profile's record; readers see either the complete old or complete new JSON. */
  async set(side: sidebar_side, tab: marker_target, marker: tab_marker | undefined): Promise<boolean> {
    return this.persist(side, tab, marker, false);
  }

  private async persist(side: sidebar_side, tab: marker_target, marker: tab_marker | undefined, only_if_missing: boolean): Promise<boolean> {
    const filename = this.filename(side, tab);
    if (!filename || (marker !== undefined && !is_tab_marker(marker))) return false;
    const existing = this.read(filename);
    if (existing !== undefined && (only_if_missing || (existing?.icon === marker?.icon && existing?.color === marker?.color))) return false;
    await mkdir(this.directory, { recursive: true });
    // Never evict a removal: doing so could revive an old workspace's marker.
    if (existing === undefined) {
      const files = await readdir(this.directory);
      if (!files.includes(path.basename(filename))
        && files.filter(name => /^(?:(left|right)_[A-Za-z0-9_-]{1,64}|document_[a-f0-9]{64})\.json$/.test(name)).length >= maximum_entries) {
        throw new Error('Too many saved tab marker preferences. Existing preferences have been preserved.');
      }
    }
    const temporary = `${filename}.${random_uuid()}.tmp`;
    try {
      await write_file(temporary, JSON.stringify({ version: 1, marker: marker === undefined ? null : copy_tab_marker(marker) }),
        { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      if (only_if_missing) {
        // Linking a complete temporary record is an atomic create-if-absent operation.
        // A late migration can never replace another window's explicit choice/removal.
        try { await link(temporary, filename); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
      } else await rename(temporary, filename);
    } finally {
      await unlink(temporary).catch(() => {});
    }
    return true;
  }
}
