/** Minimal SSE client for tests: connects, parses frames, hands out events. */

export interface SseEvent {
  id?: string;
  event?: string;
  data?: string;
}

export class SseClient {
  private controller = new AbortController();
  private events: SseEvent[] = [];
  private waiters: Array<(e: SseEvent) => void> = [];
  private connected: Promise<number>;

  constructor(url: string, headers: Record<string, string>) {
    let resolveConnected!: (status: number) => void;
    this.connected = new Promise((r) => (resolveConnected = r));

    void fetch(url, { headers, signal: this.controller.signal })
      .then(async (res) => {
        resolveConnected(res.status);
        if (!res.ok || !res.body) return;
        const decoder = new TextDecoder();
        let pending = '';
        for await (const chunk of res.body) {
          pending += decoder.decode(chunk, { stream: true });
          let sep;
          while ((sep = pending.indexOf('\n\n')) >= 0) {
            const frame = pending.slice(0, sep);
            pending = pending.slice(sep + 2);
            const event = this.parse(frame);
            if (event) {
              const waiter = this.waiters.shift();
              if (waiter) waiter(event);
              else this.events.push(event);
            }
          }
        }
      })
      .catch(() => {
        // aborted on close()
      });
  }

  private parse(frame: string): SseEvent | null {
    const event: SseEvent = {};
    for (const line of frame.split('\n')) {
      if (line.startsWith('id: ')) event.id = line.slice(4);
      else if (line.startsWith('event: ')) event.event = line.slice(7);
      else if (line.startsWith('data: ')) event.data = line.slice(6);
      // lines starting with ':' are comments (heartbeats) — ignored
    }
    return event.id || event.event || event.data ? event : null;
  }

  /** Resolves with the HTTP status once the response headers arrive. */
  status(): Promise<number> {
    return this.connected;
  }

  /** Next parsed event (buffered or future), or reject after timeout. */
  next(timeoutMs = 3000): Promise<SseEvent> {
    const buffered = this.events.shift();
    if (buffered) return Promise.resolve(buffered);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== wrapped);
        reject(new Error(`no SSE event within ${timeoutMs}ms`));
      }, timeoutMs);
      const wrapped = (e: SseEvent) => {
        clearTimeout(timer);
        resolve(e);
      };
      this.waiters.push(wrapped);
    });
  }

  close(): void {
    this.controller.abort();
  }
}
