import { readFileSync } from 'fs';
import { join } from 'path';
import { Stack, Stage } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { ShellStep } from 'aws-cdk-lib/pipelines';
import * as YAML from 'yaml';
import { TestApp, withTemporaryDirectory } from './testutil';
import { AwsCredentials, GitHubActionStep, GitHubWorkflow, GitHubWorkflowProps, JobStep } from '../src';

const fixtures = join(__dirname, 'fixtures');
const SHA = (c: string) => c.repeat(40);

let app: TestApp;
beforeEach(() => {
  app = new TestApp({ outdir: 'action-refs.out' });
});

afterEach(() => {
  app.cleanup();
});

function render(props: Partial<GitHubWorkflowProps> = {}, withStep?: JobStep[]): any {
  return withTemporaryDirectory((dir) => {
    const pipeline = new GitHubWorkflow(app, 'Pipeline', {
      workflowPath: `${dir}/.github/workflows/deploy.yml`,
      synth: new ShellStep('Build', { installCommands: ['yarn'], commands: ['yarn build'] }),
      awsCreds: AwsCredentials.fromOpenIdConnect({ gitHubActionRoleArn: 'arn:aws:iam::111111111111:role/gh' }),
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
    if (withStep) {
      pipeline.addWave('Extra', { post: [new GitHubActionStep('Notify', { jobSteps: withStep })] });
    }
    app.synth();
    return YAML.parse(readFileSync(pipeline.workflowPath, 'utf-8'));
  });
}

const usesOf = (workflow: any): string[] =>
  Object.values<any>(workflow.jobs).flatMap((job) => (job.steps ?? []).map((s: any) => s.uses).filter(Boolean));

describe('actionRefs', () => {
  test('the default keeps the refs the library emits', () => {
    const uses = usesOf(render());
    expect(uses).toContain('actions/checkout@v6');
    expect(uses).toContain('actions/download-artifact@v8');
    expect(uses).toContain('aws-actions/configure-aws-credentials@v6');
    expect(uses).toContain('aws-actions/aws-cloudformation-github-deploy@v2');
  });

  test('an empty map changes nothing', () => {
    const uses = usesOf(render({ actionRefs: {} }));
    expect(uses).toContain('actions/checkout@v6');
    expect(uses).toContain('aws-actions/aws-cloudformation-github-deploy@v2');
  });

  test('replaces the ref in every step that uses a listed action', () => {
    const workflow = render({
      actionRefs: {
        'actions/checkout': SHA('a'),
        'actions/download-artifact': SHA('b'),
        'actions/upload-artifact': SHA('c'),
        'aws-actions/configure-aws-credentials': SHA('d'),
        'aws-actions/aws-cloudformation-github-deploy': SHA('e'),
      },
    });
    const uses = usesOf(workflow);
    expect(uses.length).toBeGreaterThan(5);
    expect(uses).toContain(`actions/checkout@${SHA('a')}`);
    expect(uses).toContain(`actions/download-artifact@${SHA('b')}`);
    expect(uses).toContain(`actions/upload-artifact@${SHA('c')}`);
    expect(uses).toContain(`aws-actions/configure-aws-credentials@${SHA('d')}`);
    expect(uses).toContain(`aws-actions/aws-cloudformation-github-deploy@${SHA('e')}`);
    // nothing keeps a mutable tag for a listed action
    expect(uses.filter((u) => /@v\d+$/.test(u))).toEqual([]);
  });

  test('actions that are not listed keep their ref', () => {
    const uses = usesOf(render({ actionRefs: { 'actions/checkout': SHA('a') } }));
    expect(uses).toContain('actions/download-artifact@v8');
    expect(uses).not.toContain('actions/checkout@v6');
  });

  test('applies to steps the caller supplies, including a pre-release ref and a subdirectory action', () => {
    const workflow = render({
      preBuildSteps: [{ uses: 'actions/setup-node@v4', with: { 'node-version': 20 } }],
      actionRefs: { 'actions/setup-node': SHA('f'), 'github/codeql-action/analyze': SHA('9') },
    }, [
      { uses: 'github/codeql-action/analyze@v3' },
      { uses: 'actions/setup-node@main' },
    ]);
    const uses = usesOf(workflow);
    expect(uses).toContain(`actions/setup-node@${SHA('f')}`);
    expect(uses).toContain(`github/codeql-action/analyze@${SHA('9')}`);
    expect(uses).not.toContain('actions/setup-node@v4');
    expect(uses).not.toContain('actions/setup-node@main');
  });

  test('a name that only shares a prefix with a listed action is not matched', () => {
    const workflow = render({
      preBuildSteps: [{ uses: 'actions/checkout-extra@v1' }],
      actionRefs: { 'actions/checkout': SHA('a') },
    });
    expect(usesOf(workflow)).toContain('actions/checkout-extra@v1');
  });

  test('local and docker references are never changed', () => {
    const workflow = render({
      preBuildSteps: [{ uses: './.github/actions/local@v1' }, { uses: 'docker://alpine@sha256:' + 'a'.repeat(64) }],
      actionRefs: { 'actions/checkout': SHA('a') },
    });
    const uses = usesOf(workflow);
    expect(uses).toContain('./.github/actions/local@v1');
    expect(uses).toContain('docker://alpine@sha256:' + 'a'.repeat(64));
  });

  test('a job-level uses is rewritten as well', () => {
    const preBuildSteps: JobStep[] = [];
    const workflow = withTemporaryDirectory((dir) => {
      const pipeline = new GitHubWorkflow(app, 'Pipeline', {
        workflowPath: `${dir}/.github/workflows/deploy.yml`,
        synth: new ShellStep('Build', { commands: ['yarn build'] }),
        preBuildSteps,
        actionRefs: { 'owner/repo/.github/workflows/call.yml': SHA('1') },
      });
      // the library never renders a job-level `uses`, so add one the way a caller
      // post-processing the model would, before the refs are applied
      const original = (pipeline as any).jobForBuildStep.bind(pipeline);
      (pipeline as any).jobForBuildStep = (...args: any[]) => {
        const job = original(...args);
        return { ...job, definition: { ...job.definition, uses: 'owner/repo/.github/workflows/call.yml@v1' } };
      };
      app.synth();
      return YAML.parse(readFileSync(pipeline.workflowPath, 'utf-8'));
    });
    expect(Object.values<any>(workflow.jobs).map((j) => j.uses).filter(Boolean)).toEqual([`owner/repo/.github/workflows/call.yml@${SHA('1')}`]);
  });

  test.each([
    ['not-an-action', SHA('a')],
    ['owner/repo@v1', SHA('a')],
    ['actions/checkout', ''],
    ['actions/checkout', 'v1@x'],
    ['actions/checkout', 'two words'],
  ])('rejects %p => %p', (action, ref) => {
    expect(() => render({ actionRefs: { [action]: ref } })).toThrow(/actionRefs/);
  });
});
