import type { Pool } from 'pg';

const CLEANUP_LOCK_ID = 723_002; // distinct from the migration lock

export interface RetentionOptions {
  retentionMaxPerEndpoint: number;
  retentionMaxAgeDays: number;
}

export interface CleanupResult {
  /** True when another instance held the lock and this run did nothing. */
  skipped: boolean;
  oldRequests: number;
  excessRequests: number;
  expiredSessions: number;
}

/**
 * One retention sweep. Policy: drop requests older than maxAgeDays, then
 * keep only the newest maxPerEndpoint per endpoint, then drop expired
 * sessions. pg_try_advisory_lock means overlapping runs (slow sweep, or
 * multiple instances later) skip instead of stacking up.
 */
export async function cleanupOnce(
  pool: Pool,
  opts: RetentionOptions,
): Promise<CleanupResult> {
  const client = await pool.connect();
  try {
    const lock = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [CLEANUP_LOCK_ID],
    );
    if (!lock.rows[0]!.locked) {
      return { skipped: true, oldRequests: 0, excessRequests: 0, expiredSessions: 0 };
    }

    try {
      const old = await client.query(
        `DELETE FROM requests
          WHERE received_at < now() - make_interval(days => $1)`,
        [opts.retentionMaxAgeDays],
      );

      // Rank each endpoint's requests newest-first; delete beyond the cap.
      // The (endpoint_id, received_at DESC) index serves the partition sort.
      const excess = await client.query(
        `DELETE FROM requests
          WHERE id IN (
            SELECT id FROM (
              SELECT id, row_number() OVER (
                PARTITION BY endpoint_id
                ORDER BY received_at DESC, id DESC
              ) AS rn
              FROM requests
            ) ranked
            WHERE rn > $1
          )`,
        [opts.retentionMaxPerEndpoint],
      );

      const sessions = await client.query(
        'DELETE FROM sessions WHERE expires_at < now()',
      );

      return {
        skipped: false,
        oldRequests: old.rowCount ?? 0,
        excessRequests: excess.rowCount ?? 0,
        expiredSessions: sessions.rowCount ?? 0,
      };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [CLEANUP_LOCK_ID]);
    }
  } finally {
    client.release();
  }
}
