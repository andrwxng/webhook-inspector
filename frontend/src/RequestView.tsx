import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type Endpoint,
  type RequestDetail,
  type RequestSummary,
} from './api.js';
import { ReplayPanel } from './ReplayPanel.js';

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * Captured payloads are hostile input. They are only ever rendered as React
 * text nodes (auto-escaped) — never dangerouslySetInnerHTML, never
 * interpreted as HTML/JSON/anything.
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
  return <pre className="payload">{detail.body}</pre>;
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

  if (!detail) return <p className="muted">Loading…</p>;

  return (
    <div className="detail">
      <h3>
        <span className={`method method-${detail.method}`}>
          {detail.method}
        </span>{' '}
        {detail.path}
        {detail.query && <span className="muted">?{detail.query}</span>}
      </h3>
      <p className="muted">
        {new Date(detail.receivedAt).toLocaleString()} · from {detail.ip} ·{' '}
        {formatSize(detail.bodySize)}
      </p>
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

export function RequestView({ endpoint }: { endpoint: Endpoint }) {
  const [requests, setRequests] = useState<RequestSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<LiveStatus>('connecting');

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
    source.addEventListener('request', (e) => {
      const incoming: RequestSummary = JSON.parse(e.data);
      setRequests((prev) =>
        prev.some((r) => r.id === incoming.id) ? prev : [incoming, ...prev],
      );
    });
    source.onopen = () => setStatus('live');
    source.onerror = () => setStatus('reconnecting');
    return () => source.close();
  }, [endpoint.id, refresh]);

  const url = `${window.location.origin}/in/${endpoint.slug}`;

  return (
    <section className="requests">
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
          {status === 'live' ? '● live' : `○ ${status}…`}
        </span>
      </div>

      <ForwardBar key={endpoint.id} endpoint={endpoint} />

      {requests.length === 0 ? (
        <p className="muted">
          Waiting for requests — they appear here the moment they arrive.
          Try:
          <br />
          <code>curl -X POST {url}/test -d &#39;hello&#39;</code>
        </p>
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
                <span className="muted">{formatTime(r.received_at)}</span>
              </li>
            ))}
          </ul>
          {selected ? (
            <DetailPane endpointId={endpoint.id} requestId={selected} />
          ) : (
            <p className="muted">Select a request to inspect it.</p>
          )}
        </div>
      )}
    </section>
  );
}
