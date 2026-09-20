import { is_format_input, is_format_result, is_source_format,
  type document_format_request, type document_format_result, type source_format } from './document_format_protocol';

export type { document_format_result, source_format } from './document_format_protocol';
type format_worker = Pick<Worker, 'postMessage' | 'terminate' | 'onmessage' | 'onerror'>;
let worker_source: Promise<Blob> | undefined;

async function create_worker(): Promise<format_worker> {
  const assets = document.querySelector<HTMLMetaElement>('meta[name="pdf-assets"]')?.content;
  if (!assets) throw new Error('Formatter assets are unavailable');
  worker_source ??= (async () => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 5_000);
    try {
      const response = await fetch(new URL('../document_format_worker.js', `${assets}/`), { signal: abort.signal });
      if (!response.ok) throw new Error('Formatter assets could not be loaded');
      return new Blob([await response.arrayBuffer()], { type: 'text/javascript' });
    } finally { clearTimeout(timer); }
  })().catch(error => { worker_source = undefined; throw error; });
  const wrapper = URL.createObjectURL(await worker_source);
  try { return new Worker(wrapper); }
  finally { URL.revokeObjectURL(wrapper); }
}

/** One cancellable formatting job per document; a stale save never overwrites a newer one. */
export class source_formatter {
  private cancel_request?: () => void;
  private disposed = false;

  constructor(private readonly worker_factory: () => format_worker | Promise<format_worker> = create_worker) {}

  format(text: string, format: source_format): Promise<document_format_result> {
    this.cancel_request?.();
    if (this.disposed) return Promise.resolve({ text, cancelled: true });
    if (!is_source_format(format) || !is_format_input(text)) {
      return Promise.resolve({ text, error: 'Source preview is limited to 4 MiB.' });
    }
    return new Promise(resolve => {
      let settled = false;
      let worker: format_worker | undefined;
      const finish = (result: document_format_result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (worker) {
          worker.onmessage = null;
          worker.onerror = null;
          worker.terminate();
        }
        if (this.cancel_request === cancel) this.cancel_request = undefined;
        resolve(result);
      };
      const cancel = () => finish({ text, cancelled: true });
      const timer = setTimeout(() => finish({ text,
        error: 'Formatting took too long. Showing the original source.',
      }), 5_000);
      this.cancel_request = cancel;
      void (async () => {
        try {
          const created = await this.worker_factory();
          if (settled) { created.terminate(); return; }
          worker = created;
          worker.onmessage = event => finish(is_format_result(event.data)
            ? event.data : { text, error: 'Formatter returned an invalid result. Showing the original source.' });
          worker.onerror = () => finish({ text, error: 'Formatting failed. Showing the original source.' });
          const request: document_format_request = { text, format };
          worker.postMessage(request);
        } catch {
          finish({ text, error: 'Formatter could not be loaded. Showing the original source.' });
        }
      })();
    });
  }

  dispose(): void {
    this.disposed = true;
    this.cancel_request?.();
  }
}
