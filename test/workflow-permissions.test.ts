import { readFileSync } from 'fs';
import { Stack, Stage } from 'aws-cdk-lib';
import { ShellStep } from 'aws-cdk-lib/pipelines';
import * as YAML from 'yaml';
import { TestApp, withTemporaryDirectory } from './testutil';
import { AwsCredentials, GitHubWorkflow, GitHubWorkflowProps, JobPermission } from '../src';

function render(props: Partial<GitHubWorkflowProps> = {}, withStage = false): { text: string; workflow: any } {
  const app = new TestApp({ outdir: 'workflow-permissions.out' });
  try {
    return withTemporaryDirectory((dir) => {
      const pipeline = new GitHubWorkflow(app, 'Pipeline', {
        workflowPath: `${dir}/.github/workflows/deploy.yml`,
        synth: new ShellStep('Build', { installCommands: ['yarn install'], commands: ['yarn build'] }),
        ...props,
      });
      if (withStage) {
        const stage = new Stage(app, 'Dev', { env: { account: '111111111111', region: 'us-east-1' } });
        new Stack(stage, 'Web');
        pipeline.addStage(stage);
      }
      app.synth();
      const text = readFileSync(pipeline.workflowPath, 'utf-8');
      return { text, workflow: YAML.parse(text) };
    });
  } finally {
    app.cleanup();
  }
}

const synthJob = (workflow: any) => Object.values<any>(workflow.jobs).find((job) => job.name === 'Synthesize');
const oidc = AwsCredentials.fromOpenIdConnect({ gitHubActionRoleArn: 'arn:aws:iam::111111111111:role/gh' });

describe('workflowPermissions', () => {
  test('no top-level permissions by default', () => {
    const { text, workflow } = render();
    expect(workflow).not.toHaveProperty('permissions');
    expect(text).not.toMatch(/^permissions:/m);
  });

  test('an empty object renders permissions: {}', () => {
    const { text, workflow } = render({ workflowPermissions: {} });
    expect(workflow.permissions).toEqual({});
    expect(text).toMatch(/^permissions: \{\}$/m);
  });

  test('permissions render with kebab-case scope names', () => {
    const { workflow } = render({
      workflowPermissions: { contents: JobPermission.READ, idToken: JobPermission.NONE, pullRequests: JobPermission.WRITE },
    });
    expect(workflow.permissions).toEqual({ 'contents': 'read', 'id-token': 'none', 'pull-requests': 'write' });
  });

  test('permissions come before the jobs', () => {
    const { workflow } = render({ workflowPermissions: {} });
    expect(Object.keys(workflow)).toEqual(['name', 'on', 'permissions', 'jobs']);
  });

  test('jobs keep their own permissions', () => {
    const { workflow } = render({ workflowPermissions: {}, awsCreds: oidc });
    expect(synthJob(workflow).permissions).toEqual({ 'contents': 'read', 'id-token': 'write' });
  });

  test('concurrency stays before permissions', () => {
    const { workflow } = render({ workflowPermissions: {}, concurrency: { group: 'deploy' } });
    expect(Object.keys(workflow)).toEqual(['name', 'on', 'concurrency', 'permissions', 'jobs']);
  });
});

describe('synthUsesAwsCredentials', () => {
  test('the synthesize job has id-token none with secrets credentials by default', () => {
    expect(synthJob(render().workflow).permissions).toEqual({ 'contents': 'read', 'id-token': 'none' });
  });

  test('the synthesize job has id-token write with OIDC credentials by default', () => {
    expect(synthJob(render({ awsCreds: oidc }).workflow).permissions).toEqual({ 'contents': 'read', 'id-token': 'write' });
  });

  test('true is the same as the default', () => {
    expect(synthJob(render({ awsCreds: oidc, synthUsesAwsCredentials: true }).workflow).permissions)
      .toEqual({ 'contents': 'read', 'id-token': 'write' });
  });

  test('false leaves id-token out of the synthesize job with OIDC credentials', () => {
    const permissions = synthJob(render({ awsCreds: oidc, synthUsesAwsCredentials: false }).workflow).permissions;
    expect(permissions).toEqual({ contents: 'read' });
    expect(permissions).not.toHaveProperty('id-token');
  });

  test('false leaves id-token out of the synthesize job with secrets credentials', () => {
    expect(synthJob(render({ synthUsesAwsCredentials: false }).workflow).permissions).toEqual({ contents: 'read' });
  });

  test('false does not change the permissions of the other jobs', () => {
    const defaults = render({ awsCreds: oidc }, true).workflow;
    const without = render({ awsCreds: oidc, synthUsesAwsCredentials: false }, true).workflow;
    const others = (workflow: any) => Object.entries<any>(workflow.jobs)
      .filter(([, job]) => job.name !== 'Synthesize');
    expect(others(defaults).length).toBeGreaterThan(1);
    expect(others(without)).toEqual(others(defaults));
  });
});
