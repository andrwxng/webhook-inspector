export interface User {
  id: string;
  email: string;
}

export interface Endpoint {
  id: string;
  slug: string;
  name: string | null;
  created_at: string;
  request_count: number;
  last_request_at: string | null;
}

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

export interface RequestDetail {
  id: string;
  method: string;
  path: string;
  query: string;
  headers: Record<string, string | string[]>;
  body: string | null;
  bodyEncoding: 'utf8' | 'base64' | null;
  bodySize: number;
  contentType: string | null;
  ip: string | null;
  receivedAt: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    ...init,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const data = await res.json();
      if (data.error) message = data.error;
    } catch {
      // non-JSON error body; keep statusText
    }
    throw new ApiError(res.status, message);
  }
  return res.json() as Promise<T>;
}
