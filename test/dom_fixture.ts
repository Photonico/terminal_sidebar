/** Small DOM event fixture for webview controls; CSS/layout still need browser QA. */
export class dom_event {
  defaultPrevented = false;
  propagation_stopped = false;
  target?: dom_element;
  currentTarget?: dom_target;
  key = '';
  isComposing = false;
  constructor(readonly type: string, values: Partial<dom_event> = {}) { Object.assign(this, values); }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.propagation_stopped = true; }
}

class dom_target {
  private readonly listeners = new Map<string, Array<{ callback: (event: dom_event) => void; signal?: AbortSignal }>>();
  addEventListener(type: string, callback: (event: dom_event) => void, options?: { signal?: AbortSignal }) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({ callback, signal: options?.signal });
    this.listeners.set(type, listeners);
  }
  dispatch(type: string, values: Partial<dom_event> = {}): dom_event {
    const event = new dom_event(type, values);
    this.deliver(event);
    return event;
  }
  deliver(event: dom_event): void {
    event.currentTarget = this;
    for (const { callback, signal } of this.listeners.get(event.type) ?? []) {
      if (!signal?.aborted) callback(event);
    }
  }
}

export class dom_element extends dom_target {
  hidden = false;
  disabled = false;
  value = '';
  textContent = '';
  className = '';
  title = '';
  id = '';
  tabIndex = 0;
  style: Record<string, string> = {};
  children: dom_element[] = [];
  parentElement?: dom_element;
  readonly attributes = new Map<string, string>();
  readonly classList = {
    add: (...names: string[]) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...names])].join(' '); },
    contains: (name: string) => this.className.split(' ').includes(name),
  };
  constructor(readonly tag: string, readonly ownerDocument: dom_document) { super(); }
  get firstElementChild(): dom_element | undefined { return this.children[0]; }
  get options(): dom_element[] { return this.children; }
  get valueAsNumber(): number { return this.value.trim() ? Number(this.value) : NaN; }
  get offsetWidth(): number { return this.className === 'pdf-settings-menu' ? 170 : 24; }
  get offsetHeight(): number { return this.className === 'pdf-settings-menu' ? 140 : 24; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  append(...children: dom_element[]) {
    for (const child of children) {
      child.remove();
      child.parentElement = this;
      this.children.push(child);
    }
  }
  add(child: dom_element) { this.append(child); }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = undefined;
    if (this.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body;
  }
  contains(target?: unknown): boolean {
    return target === this || this.children.some(child => child.contains(target));
  }
  querySelectorAll(tag: string): dom_element[] {
    return this.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag)]);
  }
  querySelector(tag: string): dom_element | undefined { return this.querySelectorAll(tag)[0]; }
  getBoundingClientRect() { return { left: 250, right: 274, top: 0, bottom: 24, width: 24, height: 24 }; }
  focus() {
    if (this.disabled || this.ownerDocument.activeElement === this) return;
    this.ownerDocument.activeElement = this;
    this.dispatch('focusin');
  }
  click() { if (!this.disabled) this.dispatch('click'); }
  override dispatch(type: string, values: Partial<dom_event> = {}): dom_event {
    const event = new dom_event(type, { target: this, ...values });
    let current: dom_element | undefined = this;
    while (current) {
      current.deliver(event);
      if (event.propagation_stopped) return event;
      current = current.parentElement;
    }
    this.ownerDocument.deliver(event);
    return event;
  }
}

export class dom_document extends dom_target {
  readonly elements: dom_element[] = [];
  readonly body = this.createElement('body');
  activeElement = this.body;
  createElement(tag: string): dom_element {
    const element = new dom_element(tag, this);
    this.elements.push(element);
    return element;
  }
}

export function create_dom() {
  const document = new dom_document();
  const window = Object.assign(new dom_target(), { innerWidth: 300, innerHeight: 480 });
  return {
    document, window, Node: dom_element, Element: dom_element, AbortController,
    Option: class extends dom_element {
      constructor(text = '', value = '') { super('option', document); this.textContent = text; this.value = value; }
    },
  };
}
