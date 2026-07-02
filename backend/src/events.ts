import { EventEmitter } from 'node:events';

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
 * This interface is the Phase 5 seam: today it's an in-process
 * EventEmitter, later a Redis pub/sub implementation drops in so multiple
 * backend instances share live events. Nothing else changes.
 */
export interface RequestBus {
  publish(endpointId: string, event: RequestEvent): void;
  subscribe(
    endpointId: string,
    listener: (event: RequestEvent) => void,
  ): () => void;
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
