/**
 * Migrations are ordered, append-only, and embedded as strings so they ship
 * inside dist/ with no file copying. Never edit an applied migration —
 * add a new one.
 */
export const migrations: ReadonlyArray<{ name: string; sql: string }> = [
  {
    name: '001_init',
    sql: `
      CREATE TABLE users (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email         text NOT NULL UNIQUE,
        password_hash text NOT NULL,
        created_at    timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE sessions (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash text NOT NULL UNIQUE,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE endpoints (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        slug       text NOT NULL UNIQUE,
        name       text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX endpoints_user_idx ON endpoints (user_id);

      CREATE TABLE requests (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        endpoint_id  uuid NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
        method       text NOT NULL,
        path         text NOT NULL,
        query        text NOT NULL DEFAULT '',
        headers      jsonb NOT NULL DEFAULT '{}',
        body         bytea,
        body_size    integer NOT NULL DEFAULT 0,
        content_type text,
        ip           text,
        received_at  timestamptz NOT NULL DEFAULT now()
      );

      -- The history query: "latest requests for this endpoint", newest first.
      CREATE INDEX requests_endpoint_received_idx
        ON requests (endpoint_id, received_at DESC);
    `,
  },
];
