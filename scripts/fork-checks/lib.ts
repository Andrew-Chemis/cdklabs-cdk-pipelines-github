import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Run a command and return its trimmed stdout. Throws on a non-zero exit.
 */
export function run(command: string, args: string[], cwd: string = REPO_ROOT): string {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

/**
 * Run git and return trimmed stdout.
 */
export function git(args: string[], cwd: string = REPO_ROOT): string {
  return run('git', args, cwd);
}

/**
 * True when the ref resolves to a commit.
 */
export function refExists(ref: string, cwd: string = REPO_ROOT): boolean {
  try {
    git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * R1.4: a sync merge must not rewrite history, so the previous head of
 * `distribution` has to be an ancestor of the new head.
 */
export function isAncestor(previous: string, next: string, cwd: string = REPO_ROOT): boolean {
  try {
    git(['merge-base', '--is-ancestor', previous, next], cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * R1.1: no commit is on one side only of `left...right`.
 */
export function commitsOnlyOnOneSide(left: string, right: string, cwd: string = REPO_ROOT): string[] {
  const out = git(['rev-list', `${left}...${right}`], cwd);
  return out === '' ? [] : out.split('\n');
}

/**
 * Files a `feat/*` branch may change (R1.3, R10.1): `src/`, `test/`, `API.md`
 * and files that projen regenerates.
 */
export function isAllowedOnFeatBranch(file: string, projenManaged: ReadonlySet<string>): boolean {
  return file.startsWith('src/')
    || file.startsWith('test/')
    || file === 'API.md'
    || projenManaged.has(file);
}

/**
 * Paths that projen regenerates, as listed in `.projen/files.json`, plus the
 * projen manifests and the lock file that `projen` rewrites with them.
 */
export function projenManagedFiles(manifestJson: string): Set<string> {
  const manifest = JSON.parse(manifestJson) as { files?: string[] };
  return new Set([
    ...(manifest.files ?? []),
    '.projen/files.json',
    '.projen/tasks.json',
    '.projen/deps.json',
    'package-lock.json',
  ]);
}

/**
 * The files a branch changes relative to the merge base with `base`.
 */
export function changedFiles(base: string, branch: string, cwd: string = REPO_ROOT): string[] {
  const out = git(['diff', '--name-only', `${base}...${branch}`], cwd);
  return out === '' ? [] : out.split('\n');
}

/**
 * Files a `feat/*` branch changed that it should not have.
 */
export function disallowedFeatChanges(files: string[], projenManaged: ReadonlySet<string>): string[] {
  return files.filter((f) => !isAllowedOnFeatBranch(f, projenManaged));
}

export interface LedgerRow {
  readonly feature: string;
  readonly branch: string;
  readonly forkVersion: string;
  readonly upstreamIssue: string;
  readonly upstreamPr: string;
  readonly state: string;
}

export const LEDGER_STATES = ['not-filed', 'fork-only', 'pr-open', 'merged-upstream'];

const LEDGER_HEADER = ['feature', 'branch', 'fork version', 'upstream issue', 'upstream pr', 'state'];

/**
 * Parse the ledger table in `UPSTREAM.md` (R3.1). The table is the first
 * markdown table whose header is the six ledger columns.
 */
export function parseLedger(markdown: string): LedgerRow[] {
  const lines = markdown.split('\n').map((l) => l.trim());
  const start = lines.findIndex((l) => {
    const cells = splitRow(l);
    return cells.length === LEDGER_HEADER.length
      && cells.every((c, i) => c.toLowerCase() === LEDGER_HEADER[i]);
  });
  if (start === -1) {
    throw new Error('UPSTREAM.md has no ledger table with the columns: Feature | Branch | Fork version | Upstream issue | Upstream PR | State');
  }

  const rows: LedgerRow[] = [];
  // skip the header and the delimiter row
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) {
      break;
    }
    const cells = splitRow(line);
    if (cells.length !== LEDGER_HEADER.length) {
      throw new Error(`ledger row has ${cells.length} cells, expected ${LEDGER_HEADER.length}: ${line}`);
    }
    rows.push({
      feature: cells[0],
      branch: cells[1].replace(/`/g, ''),
      forkVersion: cells[2],
      upstreamIssue: cells[3],
      upstreamPr: cells[4],
      state: cells[5].replace(/`/g, ''),
    });
  }
  return rows;
}

function splitRow(line: string): string[] {
  if (!line.startsWith('|') || !line.endsWith('|')) {
    return [];
  }
  return line.slice(1, -1).split('|').map((c) => c.trim());
}

/**
 * `feat/*` branches that a list of merge commit subjects merged. Handles GitHub's
 * "Merge pull request #N from owner/feat/x" and git's "Merge branch 'feat/x'".
 */
export function featBranchesFromMergeSubjects(subjects: string[]): string[] {
  const found = new Set<string>();
  for (const subject of subjects) {
    const github = /^Merge pull request #\d+ from [^/\s]+\/(feat\/\S+)/.exec(subject);
    const local = /^Merge (?:remote-tracking )?branch '(?:[^/']+\/)?(feat\/[^']+)'/.exec(subject);
    const name = github?.[1] ?? local?.[1];
    if (name) {
      found.add(name);
    }
  }
  return [...found].sort();
}

/**
 * R3.2: the `feat/*` branches merged into `ref`, from `git log --merges`.
 */
export function mergedFeatBranches(ref: string, cwd: string = REPO_ROOT): string[] {
  const out = git(['log', '--merges', '--format=%s', ref], cwd);
  return featBranchesFromMergeSubjects(out === '' ? [] : out.split('\n'));
}

/**
 * Branches merged without a row in the ledger.
 */
export function missingLedgerRows(merged: string[], rows: LedgerRow[]): string[] {
  const listed = new Set(rows.map((r) => r.branch));
  return merged.filter((b) => !listed.has(b));
}

/**
 * Normalize what jsii bakes into the compiled JavaScript so builds of different
 * versions, and of the scoped and unscoped package, compare equal: the semver in
 * every `version: "x.y.z"` and the package name in every `fqn: "<package>.Type"`.
 */
export function normalizeVersionStrings(source: string): string {
  return source
    .replace(/(version: ")\d+\.\d+\.\d+[^"]*(")/g, '$1<version>$2')
    .replace(/(fqn: ")(?:@[^/"]+\/)?cdk-pipelines-github\./g, '$1<package>.');
}

/**
 * Relative paths of the files under `dir`, sorted.
 */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        out.push(path.relative(dir, full));
      }
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * R2.3: compare a compiled `lib/` directory with another, ignoring the embedded
 * version strings and tsbuildinfo. Returns the paths that differ.
 */
export function compareLibDirs(left: string, right: string): string[] {
  const skip = (f: string) => f.endsWith('.tsbuildinfo');
  const leftFiles = listFiles(left).filter((f) => !skip(f));
  const rightFiles = listFiles(right).filter((f) => !skip(f));
  const differing: string[] = [];
  for (const f of new Set([...leftFiles, ...rightFiles])) {
    if (!leftFiles.includes(f) || !rightFiles.includes(f)) {
      differing.push(f);
      continue;
    }
    const a = normalizeVersionStrings(fs.readFileSync(path.join(left, f), 'utf8'));
    const b = normalizeVersionStrings(fs.readFileSync(path.join(right, f), 'utf8'));
    if (a !== b) {
      differing.push(f);
    }
  }
  return differing.sort();
}
