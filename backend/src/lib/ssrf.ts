import { lookup as dnsLookup } from 'node:dns';
import net from 'node:net';

/**
 * SSRF guard for replay/forward targets. The server makes requests to
 * user-supplied URLs, so without this a user could aim it at
 * 169.254.169.254 (cloud metadata), localhost admin ports, or anything
 * on the internal network.
 *
 * Two checkpoints:
 *  1. assertSafeTargetUrl — cheap static checks (scheme, IP literals)
 *     before any connection.
 *  2. makeSafeLookup — DNS resolution *inside* the socket connect. This is
 *     the one that matters: validating "resolve then request" as two steps
 *     is a DNS-rebinding hole (resolve returns a public IP, the attacker's
 *     DNS flips the record, the request connects somewhere private).
 *     Here the vetted resolution IS the one the socket uses.
 */
export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

export function isPrivateIp(raw: string): boolean {
  let ip = raw.toLowerCase();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);

  // IPv4-mapped IPv6 (::ffff:10.0.0.1) — judge the embedded IPv4.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) ip = mapped[1]!;

  const version = net.isIP(ip);
  if (version === 4) {
    const parts = ip.split('.').map(Number);
    const a = parts[0]!;
    const b = parts[1]!;
    return (
      a === 0 || // "this network"
      a === 10 || // private
      a === 127 || // loopback
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local + cloud metadata
      (a === 172 && b >= 16 && b <= 31) || // private
      (a === 192 && (b === 0 || b === 168)) || // private + protocol-assignment
      (a === 198 && (b === 18 || b === 19)) || // benchmarking
      a >= 224 // multicast + reserved
    );
  }
  if (version === 6) {
    return (
      ip === '::' ||
      ip === '::1' || // loopback
      ip.startsWith('fc') ||
      ip.startsWith('fd') || // unique local (fc00::/7)
      /^fe[89ab]/.test(ip) // link-local (fe80::/10)
    );
  }
  return true; // not a parseable IP — refuse rather than guess
}

/** Static checks: parseable, http(s) only, IP-literal hosts vetted now. */
export function assertSafeTargetUrl(rawUrl: string, allowPrivate: boolean): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError('invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError(`protocol "${url.protocol}" not allowed`);
  }
  const bare = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(bare) !== 0 && !allowPrivate && isPrivateIp(bare)) {
    throw new SsrfBlockedError('target is a private address');
  }
  return url;
}

type LookupOptions = { all?: boolean };
type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | { address: string; family: number }[],
  family?: number,
) => void;

/**
 * A node `lookup` implementation for socket connects that rejects when ANY
 * resolved address is private (a multi-record answer mixing public and
 * private addresses is an attack, not a CDN).
 */
export function makeSafeLookup(allowPrivate: boolean) {
  return function safeLookup(
    hostname: string,
    options: LookupOptions,
    callback: LookupCallback,
  ): void {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return callback(err);
      if (!allowPrivate && addresses.some((a) => isPrivateIp(a.address))) {
        return callback(
          new SsrfBlockedError('target resolves to a private address'),
        );
      }
      const first = addresses[0];
      if (!first) return callback(new Error(`no address found for ${hostname}`));
      if (options.all) return callback(null, addresses);
      callback(null, first.address, first.family);
    });
  };
}

/** undici wraps connect errors; walk the cause chain to find our error. */
export function findSsrfError(err: unknown): SsrfBlockedError | null {
  let current: unknown = err;
  for (let depth = 0; current && depth < 10; depth++) {
    if (current instanceof SsrfBlockedError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}
