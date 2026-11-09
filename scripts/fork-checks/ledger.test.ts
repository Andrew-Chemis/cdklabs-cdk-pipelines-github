import * as fs from 'fs';
import * as path from 'path';
import {
  LEDGER_STATES,
  REPO_ROOT,
  featBranchesFromMergeSubjects,
  mergedFeatBranches,
  missingLedgerRows,
  parseLedger,
} from './lib';

const LEDGER = `# Upstream ledger

| Feature | Branch | Fork version | Upstream issue | Upstream PR | State |
| --- | --- | --- | --- | --- | --- |
| One | \`feat/one\` | 0.1.2 | - | - | \`not-filed\` |
| Two | \`feat/two\` | unreleased | cdklabs#9 | cdklabs#10 | pr-open |

Prose after the table.
`;

describe('R3.1 the ledger table', () => {
  test('parses one row per feature', () => {
    const rows = parseLedger(LEDGER);
    expect(rows.map((r) => r.branch)).toEqual(['feat/one', 'feat/two']);
    expect(rows[1]).toMatchObject({ forkVersion: 'unreleased', upstreamIssue: 'cdklabs#9', state: 'pr-open' });
  });

  test('rejects a document with no ledger table', () => {
    expect(() => parseLedger('# nothing here')).toThrow(/no ledger table/);
  });

  test('rejects a row with the wrong number of cells', () => {
    expect(() => parseLedger(LEDGER.replace('| 0.1.2 |', '|'))).toThrow(/cells/);
  });

  test('UPSTREAM.md has a valid ledger', () => {
    const rows = parseLedger(fs.readFileSync(path.join(REPO_ROOT, 'UPSTREAM.md'), 'utf8'));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.branch).toMatch(/^feat\/[a-z0-9-]+$/);
      expect(LEDGER_STATES).toContain(row.state);
    }
    expect(new Set(rows.map((r) => r.branch)).size).toBe(rows.length);
  });
});

describe('R3.2 a merged feat branch must have a ledger row', () => {
  test('reads the branch from a GitHub merge commit and from a local merge', () => {
    expect(featBranchesFromMergeSubjects([
      'Merge pull request #5 from Andrew-Chemis/feat/use-role-external-id',
      "Merge branch 'feat/action-refs' into distribution",
      "Merge remote-tracking branch 'origin/feat/job-timeout'",
      "Merge branch 'main' into distribution",
      'Merge pull request #6 from Andrew-Chemis/claude/project-thread-nh9rlp',
    ])).toEqual(['feat/action-refs', 'feat/job-timeout', 'feat/use-role-external-id']);
  });

  test('reports a merged branch with no row', () => {
    const rows = parseLedger(LEDGER);
    expect(missingLedgerRows(['feat/one', 'feat/three'], rows)).toEqual(['feat/three']);
    expect(missingLedgerRows(['feat/one', 'feat/two'], rows)).toEqual([]);
  });

  test('every feat branch merged into HEAD has a row in UPSTREAM.md', () => {
    const rows = parseLedger(fs.readFileSync(path.join(REPO_ROOT, 'UPSTREAM.md'), 'utf8'));
    expect(missingLedgerRows(mergedFeatBranches('HEAD'), rows)).toEqual([]);
  });
});
