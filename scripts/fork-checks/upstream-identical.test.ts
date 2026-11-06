import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { REPO_ROOT, compareLibDirs, git, normalizeVersionStrings, refExists } from './lib';

describe('R2.3 the first release has the same src as upstream v0.4.139', () => {
  test('version and package name baked in by jsii are ignored', () => {
    const a = 'Foo[_a] = { fqn: "cdk-pipelines-github.Foo", version: "0.4.139" };';
    const b = 'Foo[_a] = { fqn: "@Andrew-Chemis/cdk-pipelines-github.Foo", version: "0.1.1" };';
    expect(normalizeVersionStrings(a)).toBe('Foo[_a] = { fqn: "<package>.Foo", version: "<version>" };');
    expect(normalizeVersionStrings(a)).toBe(normalizeVersionStrings(b));
  });

  test('a changed fqn type name is still a difference', () => {
    const a = 'Foo[_a] = { fqn: "cdk-pipelines-github.Foo", version: "0.1.1" };';
    const b = 'Foo[_a] = { fqn: "cdk-pipelines-github.Bar", version: "0.1.1" };';
    expect(normalizeVersionStrings(a)).not.toBe(normalizeVersionStrings(b));
  });

  test('compareLibDirs reports files whose content differs beyond the version', () => {
    const left = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-left-'));
    const right = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-right-'));
    fs.writeFileSync(path.join(left, 'a.js'), 'x = { version: "0.1.1" };');
    fs.writeFileSync(path.join(right, 'a.js'), 'x = { version: "0.4.139" };');
    fs.writeFileSync(path.join(left, 'b.js'), 'one');
    fs.writeFileSync(path.join(right, 'b.js'), 'two');
    fs.writeFileSync(path.join(left, 'only-left.js'), 'x');
    expect(compareLibDirs(left, right)).toEqual(['b.js', 'only-left.js']);
  });

  // `lib/` must be compiled from the commit that is checked, and the check
  // downloads the published upstream tarball:
  //   git checkout ac-v0.1.1 && npm ci && node_modules/.bin/projen compile
  //   FORK_CHECKS_UPSTREAM_VERSION=0.4.139 npm run fork-checks
  // It has to hold for the first release only; later releases carry features.
  const upstreamVersion = process.env.FORK_CHECKS_UPSTREAM_VERSION;
  const compare = upstreamVersion ? test : test.skip;

  compare('compiled lib/ equals the published upstream package, apart from versions', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'upstream-'));
    const tarball = execFileSync('npm', ['pack', `cdk-pipelines-github@${upstreamVersion}`, '--silent'], { cwd: tmp, encoding: 'utf8' }).trim().split('\n').pop()!;
    execFileSync('tar', ['-xzf', tarball, '-C', tmp], { cwd: tmp });
    expect(compareLibDirs(path.join(REPO_ROOT, 'lib'), path.join(tmp, 'package', 'lib'))).toEqual([]);
  });

  // Where the upstream tags are fetched locally, the plain git form of the check works too.
  const gitForm = refExists(`v${upstreamVersion}`) && refExists('ac-v0.1.1') ? test : test.skip;
  gitForm('git diff v<upstream> ac-v0.1.1 -- src is empty', () => {
    expect(git(['diff', `v${upstreamVersion}`, 'ac-v0.1.1', '--', 'src'])).toBe('');
  });
});
