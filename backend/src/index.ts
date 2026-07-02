import { buildApp } from './app.js';
import { migrate } from './db/migrate.js';
import { cleanupOnce } from './lib/retention.js';

const app = await buildApp();

async function runCleanup(): Promise<void> {
  try {
    const result = await cleanupOnce(app.db, app.config);
    if (
      !result.skipped &&
      result.oldRequests + result.excessRequests + result.expiredSessions > 0
    ) {
      app.log.info(result, 'retention cleanup');
    }
  } catch (err) {
    app.log.error(err, 'retention cleanup failed');
  }
}

try {
  const applied = await migrate(app.db);
  if (applied.length > 0) {
    app.log.info({ applied }, 'migrations applied');
  }

  await runCleanup();
  // unref: the timer must not keep a shutting-down process alive.
  setInterval(runCleanup, app.config.cleanupIntervalSec * 1000).unref();

  await app.listen({ port: app.config.port, host: app.config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
