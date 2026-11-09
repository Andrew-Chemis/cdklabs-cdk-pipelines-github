import { readFileSync } from 'fs';
import { Stack, Stage } from 'aws-cdk-lib';
import { ShellStep } from 'aws-cdk-lib/pipelines';
import * as YAML from 'yaml';
import { TestApp, withTemporaryDirectory } from './testutil';
import { AwsCredentials, AwsCredentialsProvider, GitHubWorkflow } from '../src';

const ROLE_ARN = 'arn:aws:iam::111111111111:role/cdk-hnb659fds-cfn-exec-role-111111111111-us-east-1';
const OIDC_ROLE = 'arn:aws:iam::111111111111:role/my-github-actions-role';

let app: TestApp;
beforeEach(() => {
  app = new TestApp({ outdir: 'role-external-id.out' });
});

afterEach(() => {
  app.cleanup();
});

function externalIds(provider: AwsCredentialsProvider): Array<string | undefined> {
  return provider.credentialSteps('us-east-1', ROLE_ARN).map((step) => step.with?.['role-external-id']);
}

describe('useRoleExternalId on AwsCredentials.fromOpenIdConnect', () => {
  test('defaults to sending the external ID when assuming the deploy role', () => {
    expect(externalIds(AwsCredentials.fromOpenIdConnect({ gitHubActionRoleArn: OIDC_ROLE }))).toEqual([undefined, 'Pipeline']);
  });

  test('true behaves like the default', () => {
    expect(externalIds(AwsCredentials.fromOpenIdConnect({ gitHubActionRoleArn: OIDC_ROLE, useRoleExternalId: true }))).toEqual([undefined, 'Pipeline']);
  });

  test('false leaves role-external-id out', () => {
    const steps = AwsCredentials.fromOpenIdConnect({ gitHubActionRoleArn: OIDC_ROLE, useRoleExternalId: false }).credentialSteps('us-east-1', ROLE_ARN);
    expect(steps).toHaveLength(2);
    for (const step of steps) {
      expect(step.with).not.toHaveProperty('role-external-id');
    }
    expect(steps[1].with).toHaveProperty('role-to-assume');
  });
});

describe('useRoleExternalId on AwsCredentials.fromGitHubSecrets', () => {
  test('defaults to sending the external ID when a role is assumed', () => {
    expect(externalIds(AwsCredentials.fromGitHubSecrets())).toEqual(['Pipeline']);
  });

  test('false leaves role-external-id out but still assumes the role', () => {
    const [step] = AwsCredentials.fromGitHubSecrets({ useRoleExternalId: false }).credentialSteps('us-east-1', ROLE_ARN);
    expect(step.with).not.toHaveProperty('role-external-id');
    expect(step.with?.['role-to-assume']).toBe(ROLE_ARN);
    expect(step.with?.['aws-access-key-id']).toBe('${{ secrets.AWS_ACCESS_KEY_ID }}');
  });

  test('secret names can still be set alongside the option', () => {
    const [step] = AwsCredentials.fromGitHubSecrets({ accessKeyId: 'KEY', secretAccessKey: 'SECRET', useRoleExternalId: false })
      .credentialSteps('us-east-1', ROLE_ARN);
    expect(step.with?.['aws-access-key-id']).toBe('${{ secrets.KEY }}');
    expect(step.with).not.toHaveProperty('role-external-id');
  });

  test('without a role to assume there is no external ID either way', () => {
    const [step] = AwsCredentials.fromGitHubSecrets().credentialSteps('us-east-1');
    expect(step.with).not.toHaveProperty('role-external-id');
  });
});

describe('useRoleExternalId in a rendered workflow', () => {
  function render(awsCreds: AwsCredentialsProvider): any {
    return withTemporaryDirectory((dir) => {
      const github = new GitHubWorkflow(app, 'Pipeline', {
        workflowPath: `${dir}/.github/workflows/deploy.yml`,
        synth: new ShellStep('Build', { installCommands: ['yarn'], commands: ['yarn build'] }),
        awsCreds,
      });
      const stage = new Stage(app, 'MyStack', { env: { account: '111111111111', region: 'us-east-1' } });
      new Stack(stage, 'MyStack');
      github.addStage(stage);
      app.synth();
      return YAML.parse(readFileSync(github.workflowPath, 'utf-8'));
    });
  }

  function withExternalId(workflow: any): number {
    return Object.values<any>(workflow.jobs)
      .flatMap((job) => job.steps)
      .filter((step: any) => step.with && 'role-external-id' in step.with).length;
  }

  test('by default every assumed deploy role carries the external ID', () => {
    const workflow = render(AwsCredentials.fromOpenIdConnect({ gitHubActionRoleArn: OIDC_ROLE }));
    expect(withExternalId(workflow)).toBeGreaterThan(0);
  });

  test('false removes it from every job', () => {
    const workflow = render(AwsCredentials.fromOpenIdConnect({ gitHubActionRoleArn: OIDC_ROLE, useRoleExternalId: false }));
    expect(withExternalId(workflow)).toBe(0);
    const deploy = Object.values<any>(workflow.jobs).find((job) => job.name.startsWith('Deploy'));
    expect(deploy.steps.map((s: any) => s.name)).toContain('Assume CDK Deploy Role');
  });
});
