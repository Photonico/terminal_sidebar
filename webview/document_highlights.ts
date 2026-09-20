import { normalize_search_text, search_source_range, type document_match } from './document_search';

function text_nodes(root: HTMLElement): Array<{ node: Node; start: number; end: number }> {
  const nodes: Array<{ node: Node; start: number; end: number }> = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let offset = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest('style, script, template, noscript')) continue;
    const length = node.textContent?.length ?? 0;
    if (length) nodes.push({ node, start: offset, end: offset + length });
    offset += length;
  }
  return nodes;
}

export function document_search_text(root: HTMLElement): string {
  return text_nodes(root).map(entry => entry.node.textContent ?? '').join('');
}

/** Shared by Markdown, formatted source, and the HTML iframe's own document. */
export class document_highlights {
  private active?: Highlight;
  private others?: Highlight;
  private cached?: readonly document_match[];
  private ranges: Array<Range | undefined> = [];
  constructor(private readonly root: HTMLElement, private readonly reveal: (range: Range) => void) {}

  select(match: document_match | undefined, matches: readonly document_match[], reveal: boolean): boolean {
    this.clear();
    if (!match) { this.cached = undefined; this.ranges = []; return false; }
    if (this.cached !== matches) {
      this.cached = matches;
      this.ranges = this.ranges_for(matches);
    }
    const range = this.ranges[matches.indexOf(match)];
    if (!range) return false;
    const realm = this.root.ownerDocument.defaultView as (Window & typeof globalThis) | null;
    if (realm?.Highlight && realm.CSS?.highlights) {
      this.others = new realm.Highlight(...this.ranges.filter((item): item is Range => !!item));
      this.active = new realm.Highlight(range);
      this.active.priority = 1;
      realm.CSS.highlights.set('sidebar_document_find_all', this.others);
      realm.CSS.highlights.set('sidebar_document_find', this.active);
    }
    if (reveal) this.reveal(range);
    return true;
  }

  private ranges_for(matches: readonly document_match[]): Array<Range | undefined> {
    const nodes = text_nodes(this.root);
    const text = nodes.map(entry => entry.node.textContent ?? '').join('');
    if (!nodes.length) return [];
    const normalized_length = normalize_search_text(text).length;
    const point = (offset: number, start: boolean) => {
      let lower = 0;
      let upper = nodes.length - 1;
      while (lower < upper) {
        const middle = Math.floor((lower + upper) / 2);
        if (nodes[middle].end < offset || (start && nodes[middle].end === offset)) lower = middle + 1; else upper = middle;
      }
      return { node: nodes[lower].node, offset: offset - nodes[lower].start };
    };
    let source_end = 0;
    let normalized_end = 0;
    return matches.map(match => {
      if (!Number.isInteger(match.start) || !Number.isInteger(match.end)
        || match.start < normalized_end || match.end <= match.start || match.end > normalized_length) return undefined;
      const offsets = search_source_range(text.slice(source_end), match.start - normalized_end, match.end - normalized_end);
      const start = point(source_end + offsets.start, true);
      const end = point(source_end + offsets.end, false);
      if (end.offset > (end.node.textContent?.length ?? 0)) return undefined;
      source_end += offsets.end;
      normalized_end = match.end;
      const range = this.root.ownerDocument.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      return range;
    });
  }

  clear(): void {
    const registry = (this.root.ownerDocument.defaultView as (Window & typeof globalThis) | null)?.CSS?.highlights;
    if (registry && registry.get('sidebar_document_find') === this.active) registry.delete('sidebar_document_find');
    if (registry && registry.get('sidebar_document_find_all') === this.others) registry.delete('sidebar_document_find_all');
    this.active = undefined;
    this.others = undefined;
  }
}
