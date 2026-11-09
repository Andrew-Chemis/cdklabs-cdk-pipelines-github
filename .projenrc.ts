import { CdklabsConstructLibrary } from 'cdklabs-projen-project-types';
import { DependencyType, github, javascript, JsonFile, JsonPatch } from 'projen';

const REPOSITORY_URL = 'https://github.com/Andrew-Chemis/cdklabs-cdk-pipelines-github.git';
const REGISTRY_URL = 'https://npm.pkg.github.com';

// SHAs resolved from the action repositories' tags. Pin by SHA and keep the
// version in the trailing comment of this table only (projen's YAML writer
// cannot emit comments).
const ACTIONS = {
  checkout: 'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803', // v6.1.0
  setupNode: 'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38', // v6.5.0
};

const project = new CdklabsConstructLibrary({
  projenrcTs: true,
  private: false,
  name: '@Andrew-Chemis/cdk-pipelines-github',
  description: 'GitHub Workflows support for CDK Pipelines',
  author: 'Amazon Web Services',
  authorAddress: 'aws-cdk-dev@amazon.com',
  cdkVersion: '2.80.0',
  constructsVersion: '10.0.46',
  defaultReleaseBranch: 'main',
  repositoryUrl: REPOSITORY_URL,
  packageManager: javascript.NodePackageManager.NPM,
  enablePRAutoMerge: true,
  bundledDeps: ['decamelize', 'yaml', 'fast-json-patch'],
  depsUpgradeOptions: {
    cooldown: 3,
  },
  jestOptions: {
    jestConfig: {
      testMatch: [
        '<rootDir>/test/**/*(*.)@(spec|test).ts?(x)',
        '<rootDir>/src/**/*(*.)@(spec|test).ts?(x)',
        '<rootDir>/scripts/fork-checks/**/*(*.)@(spec|test).ts?(x)',
      ],
    },
    updateSnapshot: javascript.UpdateSnapshot.NEVER,
  },

  // Publishing: GitHub Packages only. Releases come from semantic-release in
  // .github/workflows/release-gh-packages.yml, never from projen's release.
  cdklabsPublishingDefaults: false,
  release: false,
  buildWorkflow: false,
  autoApproveUpgrades: false,
  upgradeCdklabsProjenProjectTypes: false,
  npmRegistryUrl: REGISTRY_URL,
  npmAccess: javascript.NpmAccess.RESTRICTED,
  githubOptions: {
    pullRequestLint: false,
  },
  devDeps: [
    'semantic-release@^25.0.9',
    '@semantic-release/commit-analyzer@^13.0.1',
    '@semantic-release/release-notes-generator@^14.1.0',
    '@semantic-release/exec@^7.1.0',
    '@semantic-release/github@^12.0.0',
    'conventional-changelog-conventionalcommits@^9.3.1',
  ],
});

// integ-tests-alpha must be the same version
project.deps.removeDependency('@aws-cdk/integ-tests-alpha');
project.deps.addDependency(`@aws-cdk/integ-tests-alpha@${project.cdkVersion.substring(1)}-alpha.0`, DependencyType.TEST);

// JSII sets this to `false` so we need to be compatible
const tsConfigDev = project.tryFindObjectFile('tsconfig.dev.json');
tsConfigDev?.patch(JsonPatch.replace('/compilerOptions/esModuleInterop', false));

// The fork's own checks (scripts/fork-checks) are compiled and linted like tests
// and stay out of the published package.
project.tsconfigDev.addInclude('scripts/**/*.ts');
project.eslint?.addLintPattern('scripts');
project.addPackageIgnore('/scripts/');
project.addTask('fork-checks', {
  description: 'Acceptance checks for the fork (see scripts/fork-checks). Set FORK_CHECKS_ONLINE=1 for the checks that need GitHub or an upstream remote.',
  exec: 'jest --ci --coverage=false scripts/fork-checks',
});
project.addPackageIgnore('/UPSTREAM.md');
project.addPackageIgnore('/.releaserc.json');

// R1.5: the only workflow on this branch is the release workflow below.
// CdklabsConstructLibrary creates these unconditionally or forces their options.
for (const workflow of [
  'auto-approve',
  'auto-queue',
  'dependency-review',
  'pull-request-lint',
  'retry-automerge',
  'upgrade',
  'upgrade-dev-deps',
]) {
  project.tryRemoveFile(`.github/workflows/${workflow}.yml`);
}

new JsonFile(project, '.releaserc.json', {
  marker: false,
  obj: {
    branches: ['distribution'],
    tagFormat: 'ac-v${version}',
    plugins: [
      [
        '@semantic-release/commit-analyzer',
        {
          preset: 'conventionalcommits',
          // Pre-1.0 policy: every type is a patch and a stray breaking marker is
          // capped at a minor, so `^0.1.x` peer ranges stay valid.
          releaseRules: [
            { breaking: true, release: 'minor' },
            { type: 'feat', release: 'patch' },
            { type: 'fix', release: 'patch' },
            { type: 'perf', release: 'patch' },
            { type: 'revert', release: 'patch' },
            { type: 'docs', release: 'patch' },
            { type: 'style', release: 'patch' },
            { type: 'refactor', release: 'patch' },
            { type: 'test', release: 'patch' },
            { type: 'build', release: 'patch' },
            { type: 'ci', release: 'patch' },
            { type: 'chore', release: 'patch' },
          ],
        },
      ],
      [
        '@semantic-release/release-notes-generator',
        { preset: 'conventionalcommits' },
      ],
      [
        // jsii bakes the package version into lib/ and .jsii, so the version is
        // set before the library is compiled and packed, then the tarball is
        // published. The Build step has already packed a 0.0.0 tarball into
        // dist/js; it is removed first so publishCmd's glob matches exactly one
        // file (two make `npm publish` fail with EUSAGE).
        '@semantic-release/exec',
        {
          prepareCmd: 'rm -rf dist/js && npm version ${nextRelease.version} --no-git-tag-version --allow-same-version && node_modules/.bin/projen compile && node_modules/.bin/projen post-compile && node_modules/.bin/projen package:js',
          publishCmd: 'npm publish dist/js/*.tgz --registry ' + REGISTRY_URL,
        },
      ],
      [
        '@semantic-release/github',
        {
          // Least privilege: the workflow grants contents and packages only.
          successComment: false,
          failComment: false,
          failTitle: false,
          releasedLabels: false,
        },
      ],
    ],
  },
});

const release = new github.GithubWorkflow(project.github!, 'release-gh-packages', {
  limitConcurrency: true,
  concurrencyOptions: { cancelInProgress: false },
});
release.on({ push: { branches: ['distribution'] } });
release.addJob('release', {
  runsOn: ['ubuntu-latest'],
  permissions: {
    contents: github.workflows.JobPermission.WRITE,
    packages: github.workflows.JobPermission.WRITE,
  },
  env: { CI: 'true' },
  steps: [
    {
      name: 'Checkout',
      uses: ACTIONS.checkout,
      with: { 'fetch-depth': 0, 'persist-credentials': false },
    },
    {
      name: 'Setup Node.js',
      uses: ACTIONS.setupNode,
      with: {
        'node-version': '22.x',
        'registry-url': REGISTRY_URL,
        'scope': '@Andrew-Chemis',
      },
    },
    {
      // Without a baseline tag semantic-release publishes 1.0.0 whatever the
      // commits say. Fail before anything is built or published.
      name: 'Require the ac-v0.1.0 baseline tag',
      run: [
        'git rev-parse --verify --quiet refs/tags/ac-v0.1.0 >/dev/null || { echo "::error::tag ac-v0.1.0 is missing; semantic-release would publish 1.0.0"; exit 1; }',
        'git merge-base --is-ancestor ac-v0.1.0 HEAD || { echo "::error::ac-v0.1.0 is not an ancestor of HEAD"; exit 1; }',
      ].join('\n'),
    },
    { name: 'Install dependencies', run: 'npm ci' },
    { name: 'Build', run: 'node_modules/.bin/projen build' },
    {
      name: 'Release',
      run: 'node_modules/.bin/semantic-release',
      env: {
        GITHUB_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
        NODE_AUTH_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
      },
    },
  ],
});
project.synth();
