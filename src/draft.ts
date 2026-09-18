import type { sidebar_configuration, terminal_profile } from './types';

function copy_profile(profile: terminal_profile): terminal_profile {
  return {
    ...profile,
    ...(profile.args === undefined ? {} : { args: [...profile.args] }),
    ...(profile.env === undefined ? {} : { env: { ...profile.env } }),
  };
}

function copy_configuration(configuration: sidebar_configuration): sidebar_configuration {
  return {
    left: configuration.left.map(copy_profile),
    right: configuration.right.map(copy_profile),
  };
}

function same_configuration(left: sidebar_configuration, right: sidebar_configuration): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** A bounded editing history, independent from terminal input and executed commands. */
export class configuration_draft {
  private current: sidebar_configuration = { left: [], right: [] };
  private original: sidebar_configuration = { left: [], right: [] };
  private past: sidebar_configuration[] = [];
  private future: sidebar_configuration[] = [];
  private group: string | undefined;
  private changed_at = 0;
  private readonly limit: number;

  constructor(configuration: sidebar_configuration = { left: [], right: [] }, limit = 100) {
    this.limit = Math.max(1, Math.min(100, Math.trunc(limit) || 100));
    this.reset(configuration);
  }

  get value(): sidebar_configuration {
    return copy_configuration(this.current);
  }

  get base(): sidebar_configuration {
    return copy_configuration(this.original);
  }

  get dirty(): boolean {
    return !same_configuration(this.current, this.original);
  }

  get can_undo(): boolean {
    return this.past.length > 0;
  }

  get can_redo(): boolean {
    return this.future.length > 0;
  }

  reset(configuration: sidebar_configuration): void {
    this.current = copy_configuration(configuration);
    this.original = copy_configuration(configuration);
    this.past = [];
    this.future = [];
    this.group = undefined;
  }

  /** Group consecutive edits to one field for 750 milliseconds. */
  change(update: (configuration: sidebar_configuration) => void, group?: string, now = Date.now()): boolean {
    const next = copy_configuration(this.current);
    update(next);
    if (same_configuration(next, this.current)) {
      return false;
    }
    if (!group || group !== this.group || now - this.changed_at > 750 || this.future.length > 0) {
      this.past.push(this.current);
      if (this.past.length > this.limit) {
        this.past.shift();
      }
    }
    // The callback may assign caller-owned arrays or retain its draft reference.
    this.current = copy_configuration(next);
    this.future = [];
    this.group = group;
    this.changed_at = now;
    return true;
  }

  end_group(): void {
    this.group = undefined;
  }

  undo(): boolean {
    const previous = this.past.pop();
    if (!previous) {
      return false;
    }
    this.future.push(this.current);
    this.current = previous;
    this.end_group();
    return true;
  }

  redo(): boolean {
    const next = this.future.pop();
    if (!next) {
      return false;
    }
    this.past.push(this.current);
    this.current = next;
    this.end_group();
    return true;
  }
}
