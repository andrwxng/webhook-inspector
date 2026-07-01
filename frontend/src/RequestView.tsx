import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type Endpoint,
  type RequestDetail,
  type RequestSummary,
} from './api.js';

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
    </div>
  );
}

export function RequestView({ endpoint }: { endpoint: Endpoint }) {
  const [requests, setRequests] = useState<RequestSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(() => {
    api<RequestSummary[]>(`/api/endpoints/${endpoint.id}/requests`).then(
      setRequests,
      () => setRequests([]),
    );
  }, [endpoint.id]);

  useEffect(() => {
    setSelected(null);
    refresh();
  }, [refresh]);

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
        <button onClick={refresh}>Refresh</button>
      </div>

      {requests.length === 0 ? (
        <p className="muted">
          No requests yet. Send anything to the URL above, e.g.:
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
