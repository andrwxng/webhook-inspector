import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type Endpoint,
  type RequestDetail,
  type RequestSummary,
} from './api.js';
import { ReplayPanel } from './ReplayPanel.js';

/** Re-renders on an interval so relative timestamps stay fresh. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function timeAgo(iso: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString();
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * Captured payloads are hostile input. They are only ever rendered as React
 * text nodes (auto-escaped) — never dangerouslySetInnerHTML, never
 * interpreted as HTML. Pretty-printing JSON is parse + re-stringify of the
 * text, still rendered as text.
 */
function BodyView({ detail }: { detail: RequestDetail }) {
  if (!detail.body) return <p className="muted">No body</p>;
  if (detail.bodyEncoding === 'base64') {
    return (
      <p className="muted">
        Binary body, {formatSize(detail.bodySize)} (not valid UTF-8; stored
        safely, shown as base64):
        <br />
        <code className="wrap">{detail.body.slice(0, 2000)}</code>
      </p>
    );
  }
  let display = detail.body;
  if (
    (detail.contentType ?? '').includes('json') ||
    /^\s*[[{]/.test(detail.body)
  ) {
    try {
      display = JSON.stringify(JSON.parse(detail.body), null, 2);
    } catch {
      // not actually JSON — show as-is
    }
  }
  return <pre className="payload">{display}</pre>;
}

function DetailPane({
  endpointId,
  requestId,
}: {
  endpointId: string;
  requestId: string;
}) {
  const [detail, setDetail] = useState<RequestDetail | null>(null);

  useEffect(() => {
    setDetail(null);
    api<RequestDetail>(
      `/api/endpoints/${endpointId}/requests/${requestId}`,
    ).then(setDetail, () => setDetail(null));
  }, [endpointId, requestId]);

  if (!detail) return <div className="select-hint">Loading…</div>;

  const queryParams = detail.query
    ? [...new URLSearchParams(detail.query).entries()]
    : [];

  return (
    <div className="detail">
      <h3>
        <span className={`method method-${detail.method}`}>
          {detail.method}
        </span>
        <span className="wrap">{detail.path}</span>
      </h3>
      <p className="muted">
        {new Date(detail.receivedAt).toLocaleString()} · from {detail.ip} ·{' '}
        {formatSize(detail.bodySize)}
        {detail.contentType && <> · {detail.contentType}</>}
      </p>

      {queryParams.length > 0 && (
        <>
          <h4>Query parameters</h4>
          <table>
            <tbody>
              {queryParams.map(([key, value], i) => (
                <tr key={i}>
                  <td className="header-name">{key}</td>
                  <td className="wrap">{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h4>Headers</h4>
      <table>
        <tbody>
          {Object.entries(detail.headers).map(([k, v]) => (
            <tr key={k}>
              <td className="header-name">{k}</td>
              <td className="wrap">{Array.isArray(v) ? v.join(', ') : v}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h4>Body</h4>
      <BodyView detail={detail} />

      <ReplayPanel key={detail.id} endpointId={endpointId} detail={detail} />
    </div>
  );
}

/** Configure auto-forwarding of incoming requests to a target URL. */
function ForwardBar({ endpoint }: { endpoint: Endpoint }) {
  const [value, setValue] = useState(endpoint.forward_url ?? '');
  const [state, setState] = useState<'idle' | 'saved' | 'error'>('idle');
  const [message, setMessage] = useState('');

  async function save(url: string | null) {
    try {
      await api(`/api/endpoints/${endpoint.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ forward_url: url }),
      });
      setValue(url ?? '');
      setState('saved');
      setTimeout(() => setState('idle'), 1500);
    } catch (err) {
      setState('error');
      setMessage(err instanceof ApiError ? err.message : 'save failed');
    }
  }

  return (
    <div className="forward-bar">
      <span className="muted">Auto-forward to</span>
      <input
        placeholder="https://target.example.com/hook (optional)"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        maxLength={2000}
      />
      <button onClick={() => void save(value || null)}>Save</button>
      {state === 'saved' && <span className="status-ok">✓ saved</span>}
      {state === 'error' && <span className="error">{message}</span>}
    </div>
  );
}

type LiveStatus = 'connecting' | 'live' | 'reconnecting';

export function RequestView({
  endpoint,
  onRequest,
}: {
  endpoint: Endpoint;
  /** Called once per newly arrived request, so the parent can keep counts fresh. */
  onRequest?: (endpointId: string) => void;
}) {
  const [requests, setRequests] = useState<RequestSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const now = useNow(15_000);

  const refresh = useCallback(() => {
    api<RequestSummary[]>(`/api/endpoints/${endpoint.id}/requests`).then(
      // Merge instead of replace: an SSE event may have landed first.
      (list) =>
        setRequests((prev) => {
          const known = new Set(list.map((r) => r.id));
          return [...prev.filter((r) => !known.has(r.id)), ...list];
        }),
      () => setRequests([]),
    );
  }, [endpoint.id]);

  useEffect(() => {
    setSelected(null);
    setRequests([]);
    setStatus('connecting');
    refresh();

    // Live updates. EventSource reconnects on its own and echoes our SSE
    // event ids back as Last-Event-ID, so the server replays what we missed.
    const source = new EventSource(`/api/endpoints/${endpoint.id}/stream`);
    // Dedupes SSE deliveries (e.g. replays after a reconnect) so the
    // parent's count callback fires at most once per request.
    const seen = new Set<string>();
    source.addEventListener('request', (e) => {
      const incoming: RequestSummary = JSON.parse(e.data);
      if (seen.has(incoming.id)) return;
      seen.add(incoming.id);
      setRequests((prev) =>
        prev.some((r) => r.id === incoming.id) ? prev : [incoming, ...prev],
      );
      onRequest?.(endpoint.id);
    });
    source.onopen = () => {
      setStatus('live');
      // Re-sync: anything that arrived while the stream was still
      // connecting isn't in the initial fetch and won't be replayed
      // (Last-Event-ID only covers reconnects, not the first connect).
      refresh();
    };
    source.onerror = () => setStatus('reconnecting');
    return () => source.close();
  }, [endpoint.id, refresh, onRequest]);

  const url = `${window.location.origin}/in/${endpoint.slug}`;

  return (
    <section className="requests">
      <div className="endpoint-header">
        <h2>{endpoint.name ?? endpoint.slug}</h2>
        <span className="muted">
          {requests.length} request{requests.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className="endpoint-url">
        <code>{url}</code>
        <button
          onClick={() => {
            navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
        <span className={`live-badge live-${status}`}>
          <span className="dot" />
          {status === 'live' ? 'live' : `${status}…`}
        </span>
      </div>

      <ForwardBar key={endpoint.id} endpoint={endpoint} />

      {requests.length === 0 ? (
        <div className="waiting-card">
          <p>
            Waiting for requests — they appear here the moment they arrive.
          </p>
          <code className="curl">
            curl -X POST {url}/test \{'\n'}
            {'  '}-H &#39;content-type: application/json&#39; \{'\n'}
            {'  '}-d &#39;{'{"hello": "world"}'}&#39;
          </code>
        </div>
      ) : (
        <div className="split">
          <ul className="request-list">
            {requests.map((r) => (
              <li
                key={r.id}
                className={selected === r.id ? 'active' : ''}
                onClick={() => setSelected(r.id)}
              >
                <span className={`method method-${r.method}`}>{r.method}</span>
                <span className="path">{r.path}</span>
                <span className="time">{timeAgo(r.received_at, now)}</span>
              </li>
            ))}
          </ul>
          {selected ? (
            <DetailPane endpointId={endpoint.id} requestId={selected} />
          ) : (
            <div className="select-hint">Select a request to inspect it</div>
          )}
        </div>
      )}
    </section>
  );
}
