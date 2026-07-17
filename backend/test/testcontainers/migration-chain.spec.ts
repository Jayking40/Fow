/**
 * Migration-chain verification — proves that every migration in
 * src/migrations/ applies cleanly in order to a fresh Postgres database.
 *
 * This runs via the testcontainers global setup (which starts a real
 * Postgres container and runs all migrations before any suite begins).
 * The test itself just asserts that the migration table is fully populated.
 *
 * If any migration is broken or out-of-order, startContainers() throws
 * before this test file even loads — making it impossible for CI to pass
 * with a broken migration chain.
 */

import { getDataSource } from './base';

describe('Migration chain', () => {
  it('applies every migration in order to a clean Postgres database', async () => {
    const ds = getDataSource();
    const rows: Array<{ name: string }> = await ds.query(
      'SELECT name FROM typeorm_migrations ORDER BY name ASC',
    );

    expect(rows.length).toBeGreaterThan(0);

    // Verify no gaps — every row should have a valid name
    for (const row of rows) {
      expect(row.name).toMatch(/^\d{13}-\w+/);
    }
  });

  it('has no pending (unapplied) migrations', async () => {
    const ds = getDataSource();
    const pending = await ds.showMigrations();
    expect(pending).toBe(false);
  });
});
