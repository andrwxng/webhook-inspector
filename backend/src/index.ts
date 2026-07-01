import { buildApp } from './app.js';
import { migrate } from './db/migrate.js';

const app = await buildApp();

try {
  const applied = await migrate(app.db);
  if (applied.length > 0) {
    app.log.info({ applied }, 'migrations applied');
  }
  await app.listen({ port: app.config.port, host: app.config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
