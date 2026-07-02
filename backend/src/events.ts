import { EventEmitter } from 'node:events';
import type { Redis } from 'ioredis';

/** Summary of a captured request — the same shape the history list returns. */
export interface RequestSummary {
  id: string;
  method: string;
  path: string;
  query: string;
  content_type: string | null;
  body_size: number;
  ip: string | null;
  received_at: string;
}

export interface RequestEvent {
  /** Postgres timestamptz text (microsecond precision) — SSE event id / catch-up cursor. */
  cursor: string;
  request: RequestSummary;
}

/**
 * How ingest tells the viewer layer "a request landed".
 *
 * Two implementations: InProcessRequestBus (single instance, no Redis)
 * and RedisRequestBus (pub/sub — every instance sees every event, so a
 * webhook landing on instance A reaches dashboards connected to B).
 * Ingest and the SSE layer only know this interface.
 */
export interface RequestBus {
  publish(endpointId: string, event: RequestEvent): void;
  subscribe(
    endpointId: string,
    listener: (event: RequestEvent) => void,
  ): () => void;
  /**
   * Resolves when the subscription is actually live (e.g. Redis has
   * acked SUBSCRIBE). Networked buses have a gap between subscribe()
   * returning and delivery starting; callers that then take a snapshot
   * (SSE catch-up) must wait for it. In-process buses omit this.
   */
  ready?(endpointId: string): Promise<void>;
}

export class InProcessRequestBus implements RequestBus {
  private emitter = new EventEmitter();

  constructor() {
    // One listener per open dashboard, keyed by endpoint id — the default
    // 10-listener warning is meant for leak detection, not fan-out.
    this.emitter.setMaxListeners(0);
  }

  publish(endpointId: string, event: RequestEvent): void {
    this.emitter.emit(endpointId, event);
  }

  subscribe(
    endpointId: string,
    listener: (event: RequestEvent) => void,
  ): () => void {
    this.emitter.on(endpointId, listener);
    return () => this.emitter.off(endpointId, listener);
  }
}

const CHANNEL_PREFIX = 'reqbus:';

/**
 * The horizontal-scaling implementation: events go through Redis pub/sub,
 * so any number of backend instances share one live-event plane. Redis
 * pub/sub is fire-and-forget with no replay — deliberately fine, because
 * missed events were never the bus's job: Postgres catch-up (stream.ts)
 * already covers disconnects, and a lost live event is found on reload.
 *
 * Needs a dedicated subscriber connection: a Redis connection in
 * subscribe mode can't run other commands, so the rate limiter's client
 * handles publishes and `sub` does nothing but listen. ioredis
 * re-subscribes all channels automatically after a reconnect.
 */
export class RedisRequestBus implements RequestBus {
  private listeners = new Map<string, Set<(event: RequestEvent) => void>>();
  private pending = new Map<string, Promise<unknown>>();

  constructor(
    private pub: Redis,
    private sub: Redis,
    private onError: (err: unknown, context: string) => void = () => {},
  ) {
    this.sub.on('message', (channel: string, message: string) => {
      const set = this.listeners.get(channel.slice(CHANNEL_PREFIX.length));
      if (!set) return;
      try {
        const event = JSON.parse(message) as RequestEvent;
        for (const listener of set) listener(event);
      } catch (err) {
        this.onError(err, 'malformed bus message');
      }
    });
  }

  publish(endpointId: string, event: RequestEvent): void {
    // Fire-and-forget by design: if Redis is down the live event is lost,
    // but the row is already in Postgres — reload/catch-up finds it.
    this.pub
      .publish(CHANNEL_PREFIX + endpointId, JSON.stringify(event))
      .catch((err: unknown) => this.onError(err, 'publish failed'));
  }

  subscribe(
    endpointId: string,
    listener: (event: RequestEvent) => void,
  ): () => void {
    let set = this.listeners.get(endpointId);
    if (!set) {
      set = new Set();
      this.listeners.set(endpointId, set);
      this.pending.set(
        endpointId,
        this.sub
          .subscribe(CHANNEL_PREFIX + endpointId)
          .catch((err: unknown) => this.onError(err, 'subscribe failed')),
      );
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(endpointId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(endpointId);
        this.pending.delete(endpointId);
        this.sub
          .unsubscribe(CHANNEL_PREFIX + endpointId)
          .catch((err: unknown) => this.onError(err, 'unsubscribe failed'));
      }
    };
  }

  async ready(endpointId: string): Promise<void> {
    await this.pending.get(endpointId);
  }
}
