import { readFileSync, rmSync } from 'node:fs';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import type { GlobalSetupContext } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    dbUrl: string;
  }
}

// A real Postgres server, not a mock: the guarantees under test (unique keys, row locks,
// conditional updates) are database behaviour, so faking the database would fake the result.
export default async function setup({ provide }: GlobalSetupContext) {
  const databaseDir = '.pgdata';
  rmSync(databaseDir, { recursive: true, force: true });
  const port = 54329;
  const epg = new EmbeddedPostgres({ databaseDir, user: 'postgres', password: 'postgres', port, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase('policies_test');

  const url = `postgres://postgres:postgres@localhost:${port}/policies_test`;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query(readFileSync('db/schema.sql', 'utf8'));
  await client.end();

  provide('dbUrl', url);
  return async () => {
    await epg.stop();
  };
}
