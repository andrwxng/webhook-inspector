import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/setup/global.ts'],
    // Integration tests share one Postgres database; run files serially so
    // truncates in one file can't race inserts in another.
    fileParallelism: false,
  },
});
