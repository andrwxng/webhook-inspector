import http from 'node:http';

/** What the replay/forward target actually received — the ground truth. */
export interface SeenRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export interface TargetServer {
  port: number;
  url: string;
  seen: SeenRequest[];
  setResponse(status: number, body: string): void;
  waitForRequest(timeoutMs?: number): Promise<SeenRequest>;
  close(): Promise<void>;
}

/** Tiny HTTP server that records every request it receives. */
export async function startTarget(): Promise<TargetServer> {
  const seen: SeenRequest[] = [];
  const waiters: Array<(r: SeenRequest) => void> = [];
  let responseStatus = 200;
  let responseBody = 'target-ok';

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const record: SeenRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      const waiter = waiters.shift();
      if (waiter) waiter(record);
      else seen.push(record);
      res.statusCode = responseStatus;
      res.end(responseBody);
    });
  });

  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', resolve),
  );
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('no port');

  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    seen,
    setResponse(status, body) {
      responseStatus = status;
      responseBody = body;
    },
    waitForRequest(timeoutMs = 3000) {
      const buffered = seen.shift();
      if (buffered) return Promise.resolve(buffered);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`target saw no request within ${timeoutMs}ms`)),
          timeoutMs,
        );
        waiters.push((r) => {
          clearTimeout(timer);
          resolve(r);
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
