import pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { ADMIN_DATABASE_URL, TEST_DATABASE_URL } from './test-db.js';

/**
 * Runs once before the test suite: creates the throwaway test database
 * (so tests never touch dev data) and applies migrations.
 */
export default async function setup(): Promise<void> {
  const admin = new pg.Pool({ connectionString: ADMIN_DATABASE_URL, max: 1 });
  try {
    const { rows } = await admin.query(
      "SELECT 1 FROM pg_database WHERE datname = 'webhook_inspector_test'",
    );
    if (rows.length === 0) {
      await admin.query('CREATE DATABASE webhook_inspector_test');
    }
  } catch (err) {
    throw new Error(
      `Could not reach Postgres at ${ADMIN_DATABASE_URL} — is "docker compose up -d" running?\n${String(err)}`,
    );
  } finally {
    await admin.end();
  }

  const test = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  try {
    await migrate(test);
  } finally {
    await test.end();
  }
}
