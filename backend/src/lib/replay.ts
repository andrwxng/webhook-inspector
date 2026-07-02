import { Agent, request, type Dispatcher } from 'undici';
import { assertSafeTargetUrl, makeSafeLookup } from './ssrf.js';

/**
 * Headers that must NOT be replayed. Hop-by-hop headers describe the
 * original connection, not the request; `host` names OUR server (the
 * target needs its own, derived from the URL); `content-length` is
 * recomputed from the actual body being sent (it may have been edited).
 * Everything else — including signature headers like x-hub-signature —
 * is preserved byte-for-byte: that's what "faithful" means.
 */
const DO_NOT_REPLAY = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'http2-settings',
]);

export interface ReplayTarget {
  url: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer | null;
}

export interface ReplayResult {
  status: number;
  durationMs: number;
  headers: Record<string, string | string[]>;
  body: { encoding: 'utf8' | 'base64'; data: string } | null;
  truncated: boolean;
}

export interface ReplayerOptions {
  timeoutMs: number;
  maxResponseBytes: number;
  allowPrivate: boolean;
}

export class Replayer {
  private agent: Agent;

  constructor(private opts: ReplayerOptions) {
    this.agent = new Agent({
      // The SSRF check runs inside the connect's DNS resolution — see ssrf.ts.
      connect: {
        lookup: makeSafeLookup(opts.allowPrivate) as never,
        timeout: opts.timeoutMs,
      },
      headersTimeout: opts.timeoutMs,
      bodyTimeout: opts.timeoutMs,
      // Redirects are NOT followed: a 3xx is reported to the user as-is.
      // Following one server-side would let a public target bounce the
      // request to an internal address.
    });
  }

  async send(target: ReplayTarget): Promise<ReplayResult> {
    const url = assertSafeTargetUrl(target.url, this.opts.allowPrivate);

    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(target.headers)) {
      if (value === undefined) continue;
      if (DO_NOT_REPLAY.has(name.toLowerCase())) continue;
      headers[name] = value;
    }

    const started = performance.now();
    const res = await request(url, {
      dispatcher: this.agent,
      method: target.method as Dispatcher.HttpMethod,
      headers,
      body: target.body,
    });

    // Read at most maxResponseBytes of the response as a preview; the
    // target controls this body, so it gets the same distrust as ingest.
    let received = Buffer.alloc(0);
    let truncated = false;
    for await (const chunk of res.body) {
      received = Buffer.concat([received, chunk as Buffer]);
      if (received.length > this.opts.maxResponseBytes) {
        received = received.subarray(0, this.opts.maxResponseBytes);
        truncated = true;
        break; // breaking the iterator destroys the stream
      }
    }
    const durationMs = Math.round(performance.now() - started);

    let body: ReplayResult['body'] = null;
    if (received.length > 0) {
      try {
        body = {
          encoding: 'utf8',
          data: new TextDecoder('utf-8', { fatal: true }).decode(received),
        };
      } catch {
        body = { encoding: 'base64', data: received.toString('base64') };
      }
    }

    return {
      status: res.statusCode,
      durationMs,
      headers: res.headers as Record<string, string | string[]>,
      body,
      truncated,
    };
  }

  async close(): Promise<void> {
    await this.agent.close();
  }
}
