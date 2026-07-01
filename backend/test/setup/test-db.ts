/** Shared test-database URLs. Overridable for CI. */
export const ADMIN_DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgres://webhook:webhook@localhost:5432/webhook_inspector';

export const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  ADMIN_DATABASE_URL.replace(/\/[^/]+$/, '/webhook_inspector_test');
