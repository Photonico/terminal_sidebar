const svg_namespace = 'http://www.w3.org/2000/svg';
const maximum_svg_bytes = 4 * 1024 * 1024;

/** Validate without inserting untrusted SVG into the webview document. */
export function svg_image_blob(text: string): Blob {
  if (text.length > maximum_svg_bytes || new TextEncoder().encode(text).byteLength > maximum_svg_bytes) {
    throw new Error('SVG preview is limited to 4 MiB.');
  }
  // Ordinary SVG doctypes are allowed, but custom entity expansion is unnecessary for images.
  if (/<!ENTITY\s/i.test(text)) throw new Error('SVG entity declarations are not supported.');
  const xml = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root = xml.documentElement;
  if (root.localName !== 'svg' || root.namespaceURI !== svg_namespace || xml.querySelector('parsererror')) {
    throw new Error('SVG could not be parsed. Check the source file and reload.');
  }
  // An SVG image uses secure animated mode: no scripts, interaction or external resources.
  // Keep it in <img>, never in an inline SVG, object or unsandboxed document.
  // https://www.w3.org/TR/SVG/conform.html#secure-animated-mode
  return new Blob([text], { type: 'image/svg+xml;charset=utf-8' });
}

/** A cancellable image load owns its Blob URL until replaced or disposed. */
export class svg_preview {
  readonly image = document.createElement('img');
  readonly loaded: Promise<boolean>;
  private readonly url: string;
  private cancel?: () => void;
  private disposed = false;

  constructor(text: string, name: string) {
    this.url = URL.createObjectURL(svg_image_blob(text));
    this.image.className = 'document-svg';
    this.image.alt = name;
    this.image.draggable = false;
    this.image.hidden = true;
    this.loaded = new Promise(resolve => {
      const finish = (loaded: boolean) => {
        if (!this.cancel) return;
        this.cancel = undefined;
        clearTimeout(timer);
        this.image.onload = null;
        this.image.onerror = null;
        resolve(loaded);
      };
      this.cancel = () => finish(false);
      const timer = setTimeout(() => finish(false), 8000);
      this.image.onload = () => finish(true);
      this.image.onerror = () => finish(false);
      this.image.src = this.url;
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel?.();
    this.image.removeAttribute('src');
    this.image.remove();
    URL.revokeObjectURL(this.url);
  }
}
