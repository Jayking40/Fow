import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Lightweight drift guard for issue #93: the backend must carry exactly one
 * fee-policy implementation. A second `FeePolicy*` module/service/entity — or a
 * `fee_policies` migration living outside `src/migrations/` — reintroduces the
 * "two copies, only one is live" hazard this consolidation removed.
 *
 * This is the documented convention from the issue, enforced in the normal unit
 * suite so a re-split fails fast in review rather than silently no-op'ing in
 * production.
 */
const SRC_ROOT = join(__dirname, '..');

const IGNORED_DIRS = new Set(['node_modules', 'dist', 'coverage']);

function collectTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!IGNORED_DIRS.has(entry)) collectTsFiles(full, acc);
    } else if (entry.endsWith('.ts')) {
      acc.push(full.replace(/\\/g, '/'));
    }
  }
  return acc;
}

describe('fee-policy module consolidation (issue #93)', () => {
  const files = collectTsFiles(SRC_ROOT);

  it('has no orphaned fee-policy-validation directory', () => {
    expect(existsSync(join(SRC_ROOT, 'fee-policy-validation'))).toBe(false);
  });

  it('declares exactly one FeePolicyModule', () => {
    const modules = files.filter((f) => f.endsWith('/fee-policy.module.ts'));
    expect(modules).toEqual([`${SRC_ROOT}/fee-policy/fee-policy.module.ts`]);
  });

  it('declares exactly one FeePolicyService implementation', () => {
    const services = files.filter((f) => f.endsWith('/fee-policy.service.ts'));
    expect(services).toEqual([`${SRC_ROOT}/fee-policy/fee-policy.service.ts`]);
  });

  it('declares exactly one FeePolicyEntity', () => {
    const entities = files.filter((f) => f.endsWith('/fee-policy.entity.ts'));
    expect(entities).toEqual([
      `${SRC_ROOT}/fee-policy/entities/fee-policy.entity.ts`,
    ]);
  });

  it('keeps the single fee_policies migration under src/migrations/', () => {
    const feeMigrations = files.filter((f) => /CreateFeePolicies/i.test(f));
    expect(feeMigrations).toEqual([
      `${SRC_ROOT}/migrations/1800000000000-CreateFeePoliciesTable.ts`,
    ]);
  });
});
