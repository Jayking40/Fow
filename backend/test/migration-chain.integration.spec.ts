
import {
  createDataSource,
  getDataSource,
  startContainers,
  stopContainers,
} from './helpers/integration-test.helper';
import * as fs from 'fs';
import * as path from 'path';

describe('Migration Chain (Integration)', () => {
  beforeAll(async () => {
    await startContainers();
  });

  afterAll(async () => {
    await stopContainers();
  });

  it('should run all migrations successfully', async () => {
    const dataSource = await createDataSource(false);
    await expect(dataSource.runMigrations()).resolves.not.toThrow();
  });

  it('should be idempotent (second run is a no-op)', async () => {
    const dataSource = getDataSource();
    const migrationsBefore = await dataSource.query(
      'SELECT * FROM migrations ORDER BY id ASC',
    );
    await expect(dataSource.runMigrations()).resolves.not.toThrow();
    const migrationsAfter = await dataSource.query(
      'SELECT * FROM migrations ORDER BY id ASC',
    );
    expect(migrationsAfter.length).toEqual(migrationsBefore.length);
  });

  it('should create a schema snapshot', async () => {
    const dataSource = getDataSource();

    // Get all tables
    const tables = await dataSource.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);

    // Get columns for each table
    const schemaSnapshot: Record<string, any> = {};
    for (const table of tables) {
      const tableName = table.table_name;
      const columns = await dataSource.query(`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position;
      `, [tableName]);

      // Get indexes for each table
      const indexes = await dataSource.query(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = $1
        ORDER BY indexname;
      `, [tableName]);

      schemaSnapshot[tableName] = {
        columns,
        indexes,
      };
    }

    // Write snapshot (optional, for review in PRs)
    const snapshotPath = path.join(
      __dirname,
      '../__snapshots__',
      'schema-snapshot.json',
    );
    const snapshotDir = path.dirname(snapshotPath);
    if (!fs.existsSync(snapshotDir)) {
      fs.mkdirSync(snapshotDir, { recursive: true });
    }
    fs.writeFileSync(snapshotPath, JSON.stringify(schemaSnapshot, null, 2));

    expect(Object.keys(schemaSnapshot).length).toBeGreaterThan(0);
  });
});
