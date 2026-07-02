import type { Redis } from 'ioredis';

/**
 * Fixed-window rate limiter. One atomic Lua round-trip per check:
 * INCR the window counter, start its TTL on first hit, report the TTL
 * so rejections can carry an honest Retry-After.
 *
 * Fixed window over sliding window on purpose: O(1) memory per key, one
 * command, and the worst case (a burst straddling a window boundary can
 * briefly hit 2x the limit) is acceptable for load shedding — we're
 * protecting Postgres from writes, not billing anyone.
 */
const CHECK_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
return {count, ttl}
`;

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSec: number;
}

export class RateLimiter {
  constructor(
    private redis: Redis,
    private limit: number,
    private windowSec: number,
  ) {}

  /** Throws if Redis is unreachable — the caller decides to fail open. */
  async check(key: string): Promise<RateLimitResult> {
    const [count, ttl] = (await this.redis.eval(
      CHECK_SCRIPT,
      1,
      `rl:${key}`,
      this.windowSec,
    )) as [number, number];

    if (count <= this.limit) {
      return { allowed: true, retryAfterSec: 0 };
    }
    return { allowed: false, retryAfterSec: Math.max(ttl, 1) };
  }
}
