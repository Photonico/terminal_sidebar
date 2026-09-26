import './hover_hint.css';

const show_delay = 500;
const warm_period = 300;

/** Native title tooltips are slow or absent in webviews, so titled controls get a themed hint.
 * The title moves aside while hovered and returns on leave, keeping one source of truth. */
export class hover_hints {
  readonly hint = document.createElement('div');
  private readonly events = new AbortController();
  private readonly observer = new MutationObserver(() => this.adopt_title());
  private target?: HTMLElement;
  private text = '';
  private timer?: ReturnType<typeof setTimeout>;
  private dismissed = false;
  private hidden_at = -Infinity;

  constructor() {
    this.hint.className = 'hover_hint';
    this.hint.setAttribute('role', 'tooltip');
    this.hint.hidden = true;
    document.body.append(this.hint);
    const options = { signal: this.events.signal, capture: true };
    document.addEventListener('pointerover', event => this.over(event.target), options);
    document.addEventListener('pointermove', event => {
      if (this.target && !this.target.isConnected) this.over(event.target);
    }, options);
    document.addEventListener('pointerout', event => {
      if (this.target && !(event.relatedTarget instanceof Node && this.target.contains(event.relatedTarget))) this.leave();
    }, options);
    // Terminal output scrolls continuously, so only user gestures dismiss a hint.
    for (const type of ['pointerdown', 'keydown', 'wheel', 'dragstart'] as const) {
      document.addEventListener(type, () => this.dismiss(), options);
    }
    window.addEventListener('blur', () => this.leave(), { signal: this.events.signal });
  }

  dispose(): void {
    this.leave();
    this.events.abort();
    this.observer.disconnect();
    this.hint.remove();
  }

  private over(node: EventTarget | null): void {
    const element = node instanceof Element ? node.closest<HTMLElement>('[title]') ?? undefined : undefined;
    // Moving onto an untitled child keeps the current hint; a titled child replaces it.
    if (this.target?.isConnected && node instanceof Node && this.target.contains(node)
      && (!element || element.contains(this.target))) return;
    if (element === this.target) return;
    this.leave();
    if (!element) return;
    this.target = element;
    this.adopt_title();
    this.observer.observe(element, { attributes: true, attributeFilter: ['title'] });
    this.timer = setTimeout(() => this.show(), Date.now() - this.hidden_at < warm_period ? 0 : show_delay);
  }

  /** Controls may retitle themselves while hovered; take the new text before the native tooltip can. */
  private adopt_title(): void {
    const target = this.target;
    if (!target?.hasAttribute('title')) return;
    this.text = target.getAttribute('title') ?? '';
    target.removeAttribute('title');
    if (!this.hint.hidden) this.show();
  }

  private show(): void {
    const target = this.target;
    if (!target?.isConnected || this.dismissed || !this.text.trim() || this.redundant(target)) return;
    this.hint.textContent = this.text;
    this.hint.hidden = false;
    this.hint.style.left = '0px';
    this.hint.style.top = '0px';
    const anchor = target.getBoundingClientRect();
    const width = this.hint.offsetWidth;
    const height = this.hint.offsetHeight;
    const below = anchor.bottom + 4;
    const top = below + height <= window.innerHeight - 4 ? below : anchor.top - height - 4;
    const left = anchor.left + anchor.width / 2 - width / 2;
    this.hint.style.left = `${Math.max(4, Math.min(left, window.innerWidth - width - 4))}px`;
    this.hint.style.top = `${Math.max(4, top)}px`;
  }

  /** A label that is already fully visible needs no second copy under the pointer. */
  private redundant(target: HTMLElement): boolean {
    return target.textContent?.trim() === this.text.trim() && target.scrollWidth <= target.clientWidth;
  }

  private dismiss(): void {
    if (!this.target) return;
    clearTimeout(this.timer);
    this.dismissed = true;
    this.hide();
  }

  private leave(): void {
    clearTimeout(this.timer);
    this.observer.disconnect();
    const target = this.target;
    if (target && !target.hasAttribute('title') && this.text) target.setAttribute('title', this.text);
    this.target = undefined;
    this.text = '';
    this.dismissed = false;
    this.hide();
  }

  private hide(): void {
    if (this.hint.hidden) return;
    this.hint.hidden = true;
    this.hidden_at = Date.now();
  }
}
