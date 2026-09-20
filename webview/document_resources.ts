/** Images can only read descendants of the selected document's resource root. */
export function local_document_resource(value: string, base_url: string): string | undefined {
  if (!value || /[\x00-\x20\x7f\\]/.test(value) || /^[a-z][a-z\d+.-]*:/i.test(value)
    || value.startsWith('/')) return undefined;
  try {
    const base = new URL(base_url);
    const image = new URL(value, base);
    if (!base.pathname.endsWith('/') || image.origin !== base.origin || image.protocol !== base.protocol
      || image.host !== base.host || !image.pathname.startsWith(base.pathname) || image.search) return undefined;
    // Encoded path separators must not bypass the subtree check at the resource server.
    const decoded = decodeURIComponent(image.pathname);
    if (/[\x00-\x1f\x7f\\]/.test(decoded) || decoded.split('/').some(part => part === '..')) return undefined;
    return image.toString();
  } catch { return undefined; }
}

