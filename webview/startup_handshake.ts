type schedule_retry = (callback: () => void, delay_ms: number) => () => void;

/** A restored webview may load before its host is listening. Retry until state arrives. */
export class startup_handshake {
  private cancel_retry?: () => void;
  private delay_ms = 250;
  private finished = false;

  constructor(
    private readonly send_ready: () => void,
    private readonly schedule: schedule_retry = (callback, delay_ms) => {
      const timer = setTimeout(callback, delay_ms);
      return () => clearTimeout(timer);
    },
  ) {}

  request(): void {
    if (this.finished) return;
    this.cancel_retry?.();
    this.cancel_retry = undefined;
    this.send_ready();
    if (this.finished) return;
    this.cancel_retry = this.schedule(() => this.request(), this.delay_ms);
    this.delay_ms = Math.min(this.delay_ms * 2, 2000);
  }

  acknowledge(): void {
    this.finished = true;
    this.cancel_retry?.();
    this.cancel_retry = undefined;
  }

  dispose(): void {
    this.acknowledge();
  }
}
