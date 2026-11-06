import { readFileSync } from 'fs';
import { join } from 'path';
import { Stack, Stage } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { ShellStep } from 'aws-cdk-lib/pipelines';
import * as YAML from 'yaml';
import { TestApp, withTemporaryDirectory } from './testutil';
import { GitHubWorkflow, GitHubWorkflowProps } from '../src';

const fixtures = join(__dirname, 'fixtures');

let app: TestApp;
beforeEach(() => {
  app = new TestApp({ outdir: 'cdk-assets-install.out' });
});

afterEach(() => {
  app.cleanup();
});

function render(props: Partial<GitHubWorkflowProps> = {}): any {
  return withTemporaryDirectory((dir) => {
    const pipeline = new GitHubWorkflow(app, 'Pipeline', {
      workflowPath: `${dir}/.github/workflows/deploy.yml`,
      synth: new ShellStep('Build', { installCommands: ['yarn'], commands: ['yarn build'] }),
      ...props,
    });
    const stage = new Stage(app, 'MyStage', { env: { account: '111111111111', region: 'us-east-1' } });
    const stack = new Stack(stage, 'MyStack');
    new lambda.Function(stack, 'Function', {
      code: lambda.Code.fromAsset(fixtures),
      handler: 'index.handler',
      runtime: lambda.Runtime.NODEJS_14_X,
    });
    pipeline.addStage(stage);
    app.synth();
    return YAML.parse(readFileSync(pipeline.workflowPath, 'utf-8'));
  });
}

function installRuns(workflow: any): string[] {
  return Object.values<any>(workflow.jobs)
    .filter((job) => job.name.startsWith('Publish Assets'))
    .flatMap((job) => job.steps)
    .filter((step: any) => step.name === 'Install')
    .map((step: any) => step.run);
}

describe('cdkAssetsInstallIgnoreScripts', () => {
  test('defaults to installing cdk-assets without --ignore-scripts', () => {
    const runs = installRuns(render());
    expect(runs.length).toBeGreaterThan(0);
    expect(new Set(runs)).toEqual(new Set(['npm install --no-save cdk-assets']));
  });

  test('false behaves like the default', () => {
    expect(new Set(installRuns(render({ cdkAssetsInstallIgnoreScripts: false })))).toEqual(new Set(['npm install --no-save cdk-assets']));
  });

  test('true adds --ignore-scripts to every asset publishing job', () => {
    const runs = installRuns(render({ cdkAssetsInstallIgnoreScripts: true }));
    expect(runs.length).toBeGreaterThan(0);
    expect(new Set(runs)).toEqual(new Set(['npm install --no-save --ignore-scripts cdk-assets']));
  });

  test('works together with cdkAssetsVersion', () => {
    const runs = installRuns(render({ cdkAssetsInstallIgnoreScripts: true, cdkAssetsVersion: '4.8.0' }));
    expect(new Set(runs)).toEqual(new Set(['npm install --no-save --ignore-scripts cdk-assets@4.8.0']));
  });

  test('does not touch the install step of the synth job', () => {
    const workflow = render({ cdkAssetsInstallIgnoreScripts: true });
    const synth = Object.values<any>(workflow.jobs).find((job) => job.name === 'Synthesize');
    expect(synth.steps.find((s: any) => s.name === 'Install').run).toBe('yarn');
  });
});
