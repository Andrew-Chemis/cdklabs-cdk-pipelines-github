import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';
import { REPO_ROOT } from './lib';

const readJson = (file: string) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'));

describe('R2.1 the package is scoped and published to GitHub Packages only', () => {
  const pkg = readJson('package.json');

  test('the name is the scoped package', () => {
    expect(pkg.name).toBe('@Andrew-Chemis/cdk-pipelines-github');
  });

  test('the registry is npm.pkg.github.com', () => {
    expect(new URL(pkg.publishConfig.registry).host).toBe('npm.pkg.github.com');
  });

  test('the repository is the fork', () => {
    expect(pkg.repository.url).toBe('https://github.com/Andrew-Chemis/cdklabs-cdk-pipelines-github.git');
  });

  test('jsii has no Python, Java, .NET or Go target', () => {
    expect(Object.keys(pkg.jsii.targets ?? {})).toEqual([]);
  });

  test('no publish task exists for PyPI, Maven, NuGet, Go or npmjs', () => {
    const tasks = Object.keys(readJson('.projen/tasks.json').tasks);
    const forbidden = tasks.filter((t) => /^(package:(python|java|dotnet|go)|publish.*|release.*|bump|unbump)$/.test(t));
    expect(forbidden).toEqual([]);
  });

  test('the package-all task packages JavaScript only', () => {
    const steps = readJson('.projen/tasks.json').tasks['package-all'].steps.map((s: any) => s.spawn);
    expect(steps).toEqual(['package:js']);
  });
});

describe('R2.2 versions come from semantic-release on a 0.x line', () => {
  const releaserc = readJson('.releaserc.json');

  test('the tag format cannot collide with upstream v* tags', () => {
    expect(releaserc.tagFormat).toBe('ac-v${version}');
  });

  test('only distribution releases', () => {
    expect(releaserc.branches).toEqual(['distribution']);
  });

  test('no release rule can produce a major', () => {
    const analyzer = releaserc.plugins.find((p: any) => p[0] === '@semantic-release/commit-analyzer')[1];
    const releases = analyzer.releaseRules.map((r: any) => r.release);
    expect(releases).not.toContain('major');
    expect(analyzer.releaseRules.find((r: any) => r.breaking)).toEqual({ breaking: true, release: 'minor' });
  });

  test('every conventional commit type is a patch', () => {
    const analyzer = releaserc.plugins.find((p: any) => p[0] === '@semantic-release/commit-analyzer')[1];
    const types = Object.fromEntries(analyzer.releaseRules.filter((r: any) => r.type).map((r: any) => [r.type, r.release]));
    for (const type of ['feat', 'fix', 'perf', 'revert', 'docs', 'style', 'refactor', 'test', 'build', 'ci', 'chore']) {
      expect(types[type]).toBe('patch');
    }
  });

  test('semantic-release does not commit back or publish through npm itself', () => {
    const names = releaserc.plugins.map((p: any) => (Array.isArray(p) ? p[0] : p));
    expect(names).not.toContain('@semantic-release/git');
    expect(names).not.toContain('@semantic-release/npm');
  });

  test('the package version stays 0.0.0 in git', () => {
    expect(readJson('package.json').version).toBe('0.0.0');
  });
});

describe('R1.5 the release workflow is the only workflow on this branch', () => {
  const dir = path.join(REPO_ROOT, '.github', 'workflows');
  const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  const workflow = parse(fs.readFileSync(path.join(dir, 'release-gh-packages.yml'), 'utf8'));

  test('no other workflow file exists', () => {
    expect(files).toEqual(['release-gh-packages.yml']);
  });

  test('it triggers only on push to distribution', () => {
    expect(workflow.on).toEqual({ push: { branches: ['distribution'] } });
  });

  test('it requests contents and packages write and nothing else', () => {
    expect(workflow.jobs.release.permissions).toEqual({ contents: 'write', packages: 'write' });
  });

  test('every action is pinned to a full commit SHA', () => {
    const uses: string[] = workflow.jobs.release.steps.map((s: any) => s.uses).filter(Boolean);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) {
      expect(u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    }
  });

  test('the job publishes with GITHUB_TOKEN and no other secret', () => {
    const text = fs.readFileSync(path.join(dir, 'release-gh-packages.yml'), 'utf8');
    const secrets = [...text.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]);
    expect(new Set(secrets)).toEqual(new Set(['GITHUB_TOKEN']));
  });

  test('it checks for the baseline tag before building or releasing', () => {
    const names: string[] = workflow.jobs.release.steps.map((s: any) => s.name);
    expect(names.indexOf('Require the ac-v0.1.0 baseline tag')).toBeGreaterThan(-1);
    expect(names.indexOf('Require the ac-v0.1.0 baseline tag')).toBeLessThan(names.indexOf('Install dependencies'));
    expect(names.indexOf('Require the ac-v0.1.0 baseline tag')).toBeLessThan(names.indexOf('Release'));
  });
});
