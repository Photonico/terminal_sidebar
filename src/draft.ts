import type { Profile } from './types';

const copy = (profiles: readonly Profile[]): Profile[] => profiles.map(profile => ({ ...profile }));
const same = (left: readonly Profile[], right: readonly Profile[]): boolean => JSON.stringify(left) === JSON.stringify(right);

/** Bounded, immutable configuration history. It never represents terminal input. */
export class ProfileDraft {
  private current: Profile[] = [];
  private original: Profile[] = [];
  private past: Profile[][] = [];
  private future: Profile[][] = [];
  private group: string | undefined;
  private changedAt = 0;

  constructor(profiles: readonly Profile[] = [], private readonly limit = 100) { this.reset(profiles); }
  get value(): readonly Profile[] { return this.current; }
  get base(): Profile[] { return copy(this.original); }
  get dirty(): boolean { return !same(this.current, this.original); }
  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }

  reset(profiles: readonly Profile[]): void {
    this.current = copy(profiles);
    this.original = copy(profiles);
    this.past = [];
    this.future = [];
    this.group = undefined;
  }

  change(update: (profiles: Profile[]) => void, group?: string, now = Date.now()): boolean {
    const next = copy(this.current);
    update(next);
    if (same(next, this.current)) return false;
    if (!group || group !== this.group || now - this.changedAt > 750 || this.future.length > 0) {
      this.past.push(this.current);
      if (this.past.length > this.limit) this.past.shift();
    }
    this.current = next;
    this.future = [];
    this.group = group;
    this.changedAt = now;
    return true;
  }

  endGroup(): void { this.group = undefined; }

  undo(): boolean {
    const previous = this.past.pop();
    if (!previous) return false;
    this.future.push(this.current);
    this.current = previous;
    this.endGroup();
    return true;
  }

  redo(): boolean {
    const next = this.future.pop();
    if (!next) return false;
    this.past.push(this.current);
    this.current = next;
    this.endGroup();
    return true;
  }
}
