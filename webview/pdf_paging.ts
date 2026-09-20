export interface pdf_wheel_event {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export interface pdf_scroll_position {
  top: number;
  height: number;
  visible: number;
  previous: boolean;
  next: boolean;
}

/** One page turn per wheel/trackpad gesture; momentum cannot cascade through pages. */
export class pdf_page_wheel {
  private last_event?: number;
  private accumulated = 0;
  private direction = 0;
  private locked = false;

  step(event: pdf_wheel_event, position: pdf_scroll_position, now: number): { page: number; consume: boolean } {
    if (event.ctrlKey || event.metaKey || event.shiftKey || !Number.isFinite(event.deltaY)
      || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return { page: 0, consume: false };
    if (this.last_event === undefined || now - this.last_event >= 250) {
      this.accumulated = 0;
      this.locked = false;
    }
    this.last_event = now;
    if (this.locked) return { page: 0, consume: true };
    const direction = Math.sign(event.deltaY);
    const boundary = direction < 0 ? position.top <= 1 && position.previous
      : position.top + position.visible >= position.height - 1 && position.next;
    if (!boundary) { this.accumulated = 0; return { page: 0, consume: false }; }
    if (direction !== this.direction) { this.direction = direction; this.accumulated = 0; }
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? Math.max(position.visible, 1) : 1;
    this.accumulated += Math.abs(event.deltaY) * unit;
    if (this.accumulated < 80) return { page: 0, consume: true };
    this.locked = true;
    this.accumulated = 0;
    return { page: direction, consume: true };
  }
}
