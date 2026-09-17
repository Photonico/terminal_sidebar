type tab_placement = 'before' | 'after';

interface reordering_options {
  container: HTMLElement;
  axis: 'horizontal' | 'vertical';
  get_ids(): readonly string[];
  enabled(): boolean;
  move(id: string, target_id: string, placement: tab_placement): void;
}

/** One controller per sidebar. Only a drag started on its own headers is accepted;
 * external text, files, and drags from the other sidebar are ignored. */
export class tab_reordering {
  private dragged_id?: string;
  private indicator?: HTMLElement;

  constructor(private readonly options: reordering_options) {
    const { container } = options;
    container.addEventListener('dragstart', event => this.start(event));
    container.addEventListener('dragover', event => this.over(event));
    container.addEventListener('drop', event => this.drop(event));
    container.addEventListener('dragend', () => this.cancel());
    container.addEventListener('dragleave', event => {
      if (!(event.relatedTarget instanceof Node) || !container.contains(event.relatedTarget)) {
        this.clear_indicator();
      }
    });
    container.addEventListener('keydown', event => this.keydown(event));
  }

  cancel(): void {
    this.dragged_id = undefined;
    this.clear_indicator();
  }

  private header(target: EventTarget | null): HTMLElement | undefined {
    const header = target instanceof Element ? target.closest<HTMLElement>('[data-reorder-id]') : null;
    return header && this.options.container.contains(header) ? header : undefined;
  }

  private clear_indicator(): void {
    if (this.indicator) {
      delete this.indicator.dataset.dropPlacement;
      this.indicator = undefined;
    }
  }

  private start(event: DragEvent): void {
    this.cancel();
    const header = this.header(event.target);
    if (!header) {
      return;
    }
    if (!this.options.enabled() || !event.dataTransfer) {
      event.preventDefault();
      return;
    }
    this.dragged_id = header.dataset.reorderId;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-terminal-sidebar-tab', this.dragged_id!);
  }

  private destination(event: DragEvent): { header: HTMLElement; id: string; placement: tab_placement } | undefined {
    const { container, axis, get_ids, enabled } = this.options;
    if (!enabled() || !this.dragged_id || !get_ids().includes(this.dragged_id)
        || !event.dataTransfer?.types.includes('application/x-terminal-sidebar-tab')) {
      return;
    }
    let header = this.header(event.target);
    let placement: tab_placement = 'after';
    if (header) {
      const bounds = header.getBoundingClientRect();
      const before = axis === 'horizontal'
        ? event.clientX < bounds.left + bounds.width / 2
        : event.clientY < bounds.top + bounds.height / 2;
      placement = before ? 'before' : 'after';
    } else if (event.target === container) {
      header = [...container.querySelectorAll<HTMLElement>('[data-reorder-id]')].at(-1);
    }
    const id = header?.dataset.reorderId;
    if (header && id && id !== this.dragged_id && get_ids().includes(id)) {
      return { header, id, placement };
    }
  }

  private over(event: DragEvent): void {
    this.clear_indicator();
    const destination = this.destination(event);
    if (!destination) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    this.indicator = destination.header;
    this.indicator.dataset.dropPlacement = destination.placement;

    // Native dragover repeats while held near the edge, allowing long lists to scroll.
    const { container, axis } = this.options;
    const bounds = container.getBoundingClientRect();
    const pointer = axis === 'horizontal' ? event.clientX : event.clientY;
    const start = axis === 'horizontal' ? bounds.left : bounds.top;
    const end = axis === 'horizontal' ? bounds.right : bounds.bottom;
    const distance = pointer < start + 24 ? -16 : pointer > end - 24 ? 16 : 0;
    if (axis === 'horizontal') {
      container.scrollLeft += distance;
    } else {
      container.scrollTop += distance;
    }
  }

  private drop(event: DragEvent): void {
    const destination = this.destination(event);
    const id = this.dragged_id;
    this.cancel();
    if (!destination || !id) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.options.move(id, destination.id, destination.placement);
  }

  private keydown(event: KeyboardEvent): void {
    // A keyboard equivalent for dragging. Ordinary arrow keys retain navigation.
    if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey || event.isComposing || !this.options.enabled()) {
      return;
    }
    const id = this.header(event.target)?.dataset.reorderId;
    const { axis, get_ids } = this.options;
    const previous_key = axis === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
    const next_key = axis === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
    if (!id || (event.key !== previous_key && event.key !== next_key)) {
      return;
    }
    event.preventDefault();
    const ids = get_ids();
    const index = ids.indexOf(id);
    const target_id = ids[index + (event.key === previous_key ? -1 : 1)];
    if (index >= 0 && target_id) {
      this.options.move(id, target_id, event.key === previous_key ? 'before' : 'after');
    }
  }
}
