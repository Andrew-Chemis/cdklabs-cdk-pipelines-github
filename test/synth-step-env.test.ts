import { readFileSync } from 'fs';
import { ShellStep } from 'aws-cdk-lib/pipelines';
import * as YAML from 'yaml';
import { TestApp, withTemporaryDirectory } from './testutil';
import { AwsCredentials, GitHubWorkflow, GitHubWorkflowProps, JobPermission } from '../src';

let app: TestApp;
beforeEach(() => {
  app = new TestApp({ outdir: 'synth-step-env.out' });
});

afterEach(() => {
  app.cleanup();
});

function synthJob(props: Partial<GitHubWorkflowProps> = {}, installCommands = ['yarn install']): any {
  return withTemporaryDirectory((dir) => {
    const pipeline = new GitHubWorkflow(app, 'Pipeline', {
      workflowPath: `${dir}/.github/workflows/deploy.yml`,
      synth: new ShellStep('Build', { installCommands, commands: ['yarn build'], env: { SHELL_STEP_VAR: 'shell' } }),
      ...props,
    });
    app.synth();
    const jobs = YAML.parse(readFileSync(pipeline.workflowPath, 'utf-8')).jobs;
    return Object.values<any>(jobs).find((job) => job.name === 'Synthesize');
  });
}

const stepsWithEnv = (job: any) => job.steps.filter((s: any) => s.env).map((s: any) => s.name);

describe('synthStepEnv', () => {
  test('is not rendered by default', () => {
    const job = synthJob();
    expect(stepsWithEnv(job)).toEqual([]);
    expect(job.env).toEqual({ SHELL_STEP_VAR: 'shell' });
  });

  test('is set on the Install and Build steps only', () => {
    const job = synthJob({
      preBuildSteps: [{ name: 'Setup', uses: 'actions/setup-node@v4' }],
      postBuildSteps: [{ name: 'After', run: 'echo done' }],
      synthStepEnv: { NODE_AUTH_TOKEN: '${{ secrets.GITHUB_TOKEN }}', OTHER: 'x' },
    });
    expect(stepsWithEnv(job)).toEqual(['Install', 'Build']);
    for (const step of job.steps.filter((s: any) => s.env)) {
      expect(step.env).toEqual({ NODE_AUTH_TOKEN: '${{ secrets.GITHUB_TOKEN }}', OTHER: 'x' });
    }
  });

  test('is not copied to the job-level env', () => {
    const job = synthJob({ synthStepEnv: { NODE_AUTH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' } });
    expect(job.env).toEqual({ SHELL_STEP_VAR: 'shell' });
  });

  test('keeps the variable names as written', () => {
    const job = synthJob({ synthStepEnv: { myCamelCase: 'v' } });
    expect(job.steps.find((s: any) => s.name === 'Build').env).toEqual({ myCamelCase: 'v' });
  });

  test('without install commands only the Build step gets the variables', () => {
    const job = synthJob({ synthStepEnv: { A: 'b' } }, []);
    expect(stepsWithEnv(job)).toEqual(['Build']);
  });

  test('a step keeps its keys in the order name, run, env', () => {
    const job = synthJob({ synthStepEnv: { A: 'b' } });
    expect(Object.keys(job.steps.find((s: any) => s.name === 'Install'))).toEqual(['name', 'run', 'env']);
  });
});

describe('synthJobPermissions', () => {
  test('the default permissions are unchanged', () => {
    expect(synthJob().permissions).toEqual({ 'contents': 'read', 'id-token': 'none' });
  });

  test('are merged into the synth job permissions', () => {
    const job = synthJob({ synthJobPermissions: { packages: JobPermission.READ } });
    expect(job.permissions).toEqual({ 'contents': 'read', 'id-token': 'none', 'packages': 'read' });
  });

  test('keep id-token when credentials come from OIDC', () => {
    const job = synthJob({
      awsCreds: AwsCredentials.fromOpenIdConnect({ gitHubActionRoleArn: 'arn:aws:iam::111111111111:role/gh' }),
      synthJobPermissions: { packages: JobPermission.READ },
    });
    expect(Object.entries(job.permissions)).toEqual([['contents', 'read'], ['id-token', 'write'], ['packages', 'read']]);
  });

  test('can raise a permission the library sets', () => {
    expect(synthJob({ synthJobPermissions: { contents: JobPermission.WRITE } }).permissions).toEqual({ 'contents': 'write', 'id-token': 'none' });
  });
});
