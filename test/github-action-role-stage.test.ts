import { readFileSync } from 'fs';
import { Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import { ShellStep } from 'aws-cdk-lib/pipelines';
import { Construct } from 'constructs';
import * as YAML from 'yaml';
import { TestApp, withTemporaryDirectory } from './testutil';
import {
  GitHubActionRole,
  GitHubActionRoleProps,
  GitHubActionRoleStage,
  GitHubActionRoleStageProps,
  GitHubWorkflow,
  StackCapabilities,
} from '../src';

const env = { account: '111111111111', region: 'us-east-1' };

let app: TestApp;
beforeEach(() => {
  app = new TestApp({ outdir: 'role-stage.out' });
});

afterEach(() => {
  app.cleanup();
});

function stage(props: Partial<GitHubActionRoleStageProps> = {}, id = 'Role'): GitHubActionRoleStage {
  return new GitHubActionRoleStage(app, id, {
    stackName: 'my-role-stack',
    env,
    roleName: 'my-role',
    repos: ['owner/repo'],
    ...props,
  });
}

/** Render a workflow with the stage in it and return the parsed jobs. */
function workflowJobs(roleStage: GitHubActionRoleStage): Record<string, any> {
  return withTemporaryDirectory((dir) => {
    const pipeline = new GitHubWorkflow(app, 'Pipeline', {
      workflowPath: `${dir}/.github/workflows/deploy.yml`,
      synth: new ShellStep('Build', { installCommands: ['yarn'], commands: ['yarn build'] }),
    });
    pipeline.addStage(roleStage);
    app.synth();
    return YAML.parse(readFileSync(pipeline.workflowPath, 'utf-8')).jobs;
  });
}

describe('the role stack', () => {
  test('is named by stackName and lives in env', () => {
    const s = stage();
    expect(s.roleStack.stackName).toEqual('my-role-stack');
    expect(s.roleStack.account).toEqual('111111111111');
    expect(s.roleStack.region).toEqual('us-east-1');
  });

  test('is the only stack in the stage', () => {
    const s = stage();
    expect(s.node.children.filter(Stack.isStack)).toEqual([s.roleStack]);
  });

  test('has the construct id RoleStack unless stackId is given', () => {
    expect(stage().roleStack.node.id).toEqual('RoleStack');
    expect(stage({ stackId: 'Custom' }, 'Other').roleStack.node.id).toEqual('Custom');
    expect(stage({ stackId: 'Custom' }, 'Other2').roleStack.artifactId).toMatch(/^Other2Custom/);
  });

  test('holds a GitHubActionRole with the given name and trust', () => {
    const s = stage();
    const template = Template.fromStack(s.roleStack);
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'my-role',
      AssumeRolePolicyDocument: {
        Statement: [{
          Condition: { StringLike: { 'token.actions.githubusercontent.com:sub': ['repo:owner/repo:*'] } },
        }],
      },
    });
    template.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 1);
  });

  test('exposes the role', () => {
    const s = stage();
    expect(s.role.node.scope?.node.id).toEqual('github-action-role');
    expect(Stack.of(s.role)).toBe(s.roleStack);
  });

  test('the role is created under the id github-action-role', () => {
    const s = stage();
    expect(s.roleStack.node.tryFindChild('github-action-role')).toBeDefined();
  });
});

describe('the provider', () => {
  test('is created by default', () => {
    Template.fromStack(stage().roleStack).resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 1);
  });

  test('existingProvider references the account provider', () => {
    const s = stage({ existingProvider: true });
    const template = Template.fromStack(s.roleStack);
    template.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 0);
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [{
          Principal: {
            Federated: {
              'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::', { Ref: 'AWS::AccountId' }, ':oidc-provider/token.actions.githubusercontent.com']],
            },
          },
        }],
      },
    });
  });

  test('existingProvider and provider together are rejected', () => {
    const other = new Stack(app, 'Other');
    expect(() => stage({
      existingProvider: true,
      provider: GitHubActionRole.existingGitHubActionsProvider(other),
    })).toThrow(/either existingProvider or provider/);
  });

  test('a provider can be passed', () => {
    const other = new Stack(app, 'Other', { env });
    const s = stage({ provider: GitHubActionRole.existingGitHubActionsProvider(other) });
    Template.fromStack(s.roleStack).resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 0);
  });
});

describe('in a workflow', () => {
  test('the deploy job acknowledges CAPABILITY_NAMED_IAM and uses the pinned stack name', () => {
    const jobs = workflowJobs(stage());
    const deploy = Object.values<any>(jobs).filter((job) => job.name.startsWith('Deploy '));
    expect(deploy).toHaveLength(1);
    const params = deploy[0].steps.find((s: any) => s.id === 'Deploy').with;
    expect(params.name).toEqual('my-role-stack');
    expect(params.capabilities).toEqual('CAPABILITY_NAMED_IAM');
  });

  test('the deploy job is named after the stage and the stack id', () => {
    const jobs = workflowJobs(stage({}, 'Roles'));
    expect(Object.values<any>(jobs).map((job) => job.name)).toContainEqual(expect.stringMatching(/^Deploy RolesRoleStack/));
  });

  test('other capabilities are added to CAPABILITY_NAMED_IAM, once', () => {
    const jobs = workflowJobs(stage({ stackCapabilities: [StackCapabilities.IAM, StackCapabilities.NAMED_IAM] }));
    const deploy = Object.values<any>(jobs).find((job) => job.name.startsWith('Deploy '));
    expect(deploy.steps.find((s: any) => s.id === 'Deploy').with.capabilities).toEqual('CAPABILITY_NAMED_IAM,CAPABILITY_IAM');
  });
});

describe('createRole', () => {
  class CustomRoleStage extends GitHubActionRoleStage {
    public readonly seen: Array<{ scope: Construct; id: string; props: GitHubActionRoleProps }> = [];

    protected createRole(scope: Construct, id: string, props: GitHubActionRoleProps): iam.IRole {
      // Runs from the base constructor, before this class's own fields exist.
      (this as any).seenEarly = [...((this as any).seenEarly ?? []), { scope, id, props }];
      return new iam.Role(scope, id, {
        roleName: props.roleName,
        assumedBy: new iam.AccountRootPrincipal(),
      });
    }
  }

  test('a subclass chooses the construct that builds the role', () => {
    const s = new CustomRoleStage(app, 'Custom', {
      stackName: 'custom-stack',
      env,
      roleName: 'custom-role',
      repos: ['owner/repo'],
    });
    const template = Template.fromStack(s.roleStack);
    template.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 0);
    template.hasResourceProperties('AWS::IAM::Role', { RoleName: 'custom-role' });
    expect(s.role.node.id).toEqual('github-action-role');
  });

  test('receives the role stack, the id and the role props of the stage', () => {
    const s = new CustomRoleStage(app, 'Custom', {
      stackName: 'custom-stack',
      env,
      roleName: 'custom-role',
      subjectClaims: ['repo:owner/repo:ref:refs/heads/main'],
    });
    const [call] = (s as any).seenEarly;
    expect(call.scope).toBe(s.roleStack);
    expect(call.id).toEqual('github-action-role');
    expect(call.props).toMatchObject({ roleName: 'custom-role', subjectClaims: ['repo:owner/repo:ref:refs/heads/main'] });
  });

  test('the stack name and capabilities do not depend on the override', () => {
    const jobs = workflowJobs(new CustomRoleStage(app, 'Custom', { stackName: 'custom-stack', env, roleName: 'r' }));
    const deploy = Object.values<any>(jobs).find((job) => job.name.startsWith('Deploy '));
    const params = deploy.steps.find((s: any) => s.id === 'Deploy').with;
    expect(params).toMatchObject({ name: 'custom-stack', capabilities: 'CAPABILITY_NAMED_IAM' });
  });
});
