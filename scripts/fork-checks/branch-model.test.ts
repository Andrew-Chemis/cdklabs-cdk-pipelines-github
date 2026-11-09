import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  changedFiles,
  commitsOnlyOnOneSide,
  disallowedFeatChanges,
  git,
  isAncestor,
  projenManagedFiles,
  refExists,
} from './lib';

// Offline checks run everywhere. The checks that need the fork's GitHub settings
// or an `upstream` remote run when asked for:
//   FORK_CHECKS_ONLINE=1 npm run fork-checks
const online = process.env.FORK_CHECKS_ONLINE === '1' ? test : test.skip;

function scratchRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-checks-'));
  git(['init', '--quiet', '--initial-branch=main'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  return dir;
}

function commit(dir: string, file: string, content: string): string {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
  git(['add', '-A'], dir);
  git(['commit', '--quiet', '-m', `change ${file}`], dir);
  return git(['rev-parse', 'HEAD'], dir);
}

describe('R1.3, R10.1 a feat branch touches only upstreamable paths', () => {
  const managed = projenManagedFiles(JSON.stringify({ files: ['.gitattributes', 'tsconfig.dev.json'] }));

  test('src, test, API.md and projen files are allowed', () => {
    expect(disallowedFeatChanges([
      'src/pipeline.ts',
      'src/steps/github-action-step.ts',
      'test/github.test.ts',
      'test/__snapshots__/github.test.ts.snap',
      'API.md',
      'tsconfig.dev.json',
      '.projen/tasks.json',
      'package-lock.json',
    ], managed)).toEqual([]);
  });

  test('packaging, ledger and workflow changes are rejected', () => {
    expect(disallowedFeatChanges([
      'src/pipeline.ts',
      'UPSTREAM.md',
      '.releaserc.json',
      '.github/workflows/release-gh-packages.yml',
      'scripts/fork-checks/lib.ts',
      'README.md',
      '.projenrc.ts',
    ], managed)).toEqual([
      'UPSTREAM.md',
      '.releaserc.json',
      '.github/workflows/release-gh-packages.yml',
      'scripts/fork-checks/lib.ts',
      'README.md',
      '.projenrc.ts',
    ]);
  });

  test('changedFiles diffs against the merge base', () => {
    const dir = scratchRepo();
    commit(dir, 'src/a.ts', 'a');
    git(['checkout', '--quiet', '-b', 'feat/x'], dir);
    commit(dir, 'src/b.ts', 'b');
    commit(dir, 'UPSTREAM.md', 'ledger');
    git(['checkout', '--quiet', 'main'], dir);
    commit(dir, 'src/main-only.ts', 'm');
    expect(changedFiles('main', 'feat/x', dir)).toEqual(['UPSTREAM.md', 'src/b.ts']);
    expect(disallowedFeatChanges(changedFiles('main', 'feat/x', dir), managed)).toEqual(['UPSTREAM.md']);
  });

  test('every feat/* branch in this clone is clean', () => {
    if (!refExists('main')) {
      return;
    }
    const manifest = git(['show', 'main:.projen/files.json']);
    const mgd = projenManagedFiles(manifest);
    const branches = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/feat/*', 'refs/remotes/origin/feat/*'])
      .split('\n').filter(Boolean);
    for (const branch of branches) {
      expect({ branch, extra: disallowedFeatChanges(changedFiles('main', branch), mgd) }).toEqual({ branch, extra: [] });
    }
  });
});

describe('R1.4 upstream changes reach distribution by merge, never by rewriting history', () => {
  test('the previous head is an ancestor after a merge', () => {
    const dir = scratchRepo();
    const base = commit(dir, 'a', '1');
    git(['checkout', '--quiet', '-b', 'distribution'], dir);
    const before = commit(dir, 'dist', '1');
    git(['checkout', '--quiet', 'main'], dir);
    commit(dir, 'b', '2');
    git(['checkout', '--quiet', 'distribution'], dir);
    git(['merge', '--no-ff', '--quiet', '-m', "Merge branch 'main' into distribution", 'main'], dir);
    expect(isAncestor(before, 'HEAD', dir)).toBe(true);
    expect(isAncestor(base, 'HEAD', dir)).toBe(true);
  });

  test('the previous head is not an ancestor after a rebase', () => {
    const dir = scratchRepo();
    commit(dir, 'a', '1');
    git(['checkout', '--quiet', '-b', 'distribution'], dir);
    const before = commit(dir, 'dist', '1');
    git(['checkout', '--quiet', 'main'], dir);
    commit(dir, 'b', '2');
    git(['checkout', '--quiet', 'distribution'], dir);
    git(['rebase', '--quiet', 'main'], dir);
    expect(isAncestor(before, 'HEAD', dir)).toBe(false);
  });

  test('reports history that is not an ancestor, for the previous head of this clone', () => {
    const previous = process.env.FORK_CHECKS_PREVIOUS_DISTRIBUTION;
    if (!previous) {
      return;
    }
    expect(isAncestor(previous, 'HEAD')).toBe(true);
  });
});

describe('R1.1 fork main mirrors upstream main', () => {
  test('commitsOnlyOnOneSide is empty for equal refs and not for diverged refs', () => {
    const dir = scratchRepo();
    commit(dir, 'a', '1');
    git(['branch', 'copy'], dir);
    expect(commitsOnlyOnOneSide('main', 'copy', dir)).toEqual([]);
    commit(dir, 'b', '2');
    expect(commitsOnlyOnOneSide('main', 'copy', dir)).toHaveLength(1);
  });

  online('git rev-list upstream/main...origin/main is empty', () => {
    // Needs a remote named `upstream` that points at cdklabs/cdk-pipelines-github
    // (fetch only; nothing is ever pushed there) and a fresh `git fetch`.
    expect(commitsOnlyOnOneSide('upstream/main', 'origin/main')).toEqual([]);
  });
});

describe('R1.2, R1.5 fork settings', () => {
  online('distribution is the default branch', () => {
    const out = execFileSync('gh', ['api', 'repos/Andrew-Chemis/cdklabs-cdk-pipelines-github', '--jq', '.default_branch'], { encoding: 'utf8' }).trim();
    expect(out).toBe('distribution');
  });

  online('every workflow other than release-gh-packages is disabled', () => {
    const out = execFileSync('gh', [
      'api', 'repos/Andrew-Chemis/cdklabs-cdk-pipelines-github/actions/workflows', '--paginate',
      '--jq', '.workflows[] | [.path, .state] | @tsv',
    ], { encoding: 'utf8' }).trim();
    const enabled = out.split('\n').filter(Boolean)
      .map((l) => l.split('\t'))
      .filter(([p, state]) => state === 'active' && p !== '.github/workflows/release-gh-packages.yml')
      .map(([p]) => p);
    expect(enabled).toEqual([]);
  });
});
