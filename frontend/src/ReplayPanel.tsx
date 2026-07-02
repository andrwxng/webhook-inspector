import { useState } from 'react';
import {
  api,
  ApiError,
  type ReplayResult,
  type RequestDetail,
} from './api.js';

function parseHeaderLines(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return headers;
}

/**
 * Replay and edit-and-resend. Plain replay sends the capture as-is; the
 * edit toggle exposes method/headers/body, and whatever the user changes
 * overrides the captured value — same engine either way.
 */
export function ReplayPanel({
  endpointId,
  detail,
}: {
  endpointId: string;
  detail: RequestDetail;
}) {
  const isBinary = detail.bodyEncoding === 'base64';
  const [targetUrl, setTargetUrl] = useState('');
  const [editing, setEditing] = useState(false);
  const [method, setMethod] = useState(detail.method);
  const [headersText, setHeadersText] = useState(() =>
    Object.entries(detail.headers)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
      .join('\n'),
  );
  const [bodyText, setBodyText] = useState(
    detail.bodyEncoding === 'utf8' ? (detail.body ?? '') : '',
  );
  const [keepBinaryBody, setKeepBinaryBody] = useState(true);
  const [result, setResult] = useState<ReplayResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const payload: Record<string, unknown> = { targetUrl };
      if (editing) {
        payload['method'] = method;
        payload['headers'] = parseHeaderLines(headersText);
        if (!(isBinary && keepBinaryBody)) {
          payload['body'] =
            bodyText === '' ? null : { encoding: 'utf8', data: bodyText };
        }
      }
      setResult(
        await api<ReplayResult>(
          `/api/endpoints/${endpointId}/requests/${detail.id}/replay`,
          { method: 'POST', body: JSON.stringify(payload) },
        ),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'replay failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="replay-panel">
      <h4>Replay</h4>
      <div className="replay-controls">
        <input
          className="replay-url"
          placeholder="https://target.example.com/hook"
          value={targetUrl}
          onChange={(e) => setTargetUrl(e.target.value)}
        />
        <button
          className="primary"
          onClick={() => void send()}
          disabled={busy || !targetUrl}
        >
          {busy ? 'Sending…' : editing ? 'Send edited' : 'Replay'}
        </button>
        <label className="inline-check">
          <input
            type="checkbox"
            checked={editing}
            onChange={(e) => setEditing(e.target.checked)}
          />
          edit before sending
        </label>
      </div>

      {editing && (
        <div className="replay-editor">
          <label>
            Method
            <input
              className="replay-method"
              value={method}
              onChange={(e) => setMethod(e.target.value.toUpperCase())}
              maxLength={16}
            />
          </label>
          <label>
            Headers (one per line, replaces the captured set)
            <textarea
              rows={6}
              value={headersText}
              onChange={(e) => setHeadersText(e.target.value)}
              spellCheck={false}
            />
          </label>
          {isBinary && (
            <label className="inline-check">
              <input
                type="checkbox"
                checked={keepBinaryBody}
                onChange={(e) => setKeepBinaryBody(e.target.checked)}
              />
              keep original binary body ({detail.bodySize} bytes)
            </label>
          )}
          {!(isBinary && keepBinaryBody) && (
            <label>
              Body (empty = no body)
              <textarea
                rows={6}
                value={bodyText}
                onChange={(e) => setBodyText(e.target.value)}
                spellCheck={false}
              />
            </label>
          )}
        </div>
      )}

      {error && <p className="error">{error}</p>}
      {result && (
        <div className="replay-result">
          <p>
            <span
              className={
                result.status < 400 ? 'status-ok' : 'status-bad'
              }
            >
              {result.status}
            </span>{' '}
            in {result.durationMs}ms
            {result.truncated && (
              <span className="muted"> · response preview truncated</span>
            )}
          </p>
          {result.body &&
            (result.body.encoding === 'utf8' ? (
              <pre className="payload">{result.body.data}</pre>
            ) : (
              <p className="muted">binary response (shown as base64)</p>
            ))}
        </div>
      )}
    </div>
  );
}
