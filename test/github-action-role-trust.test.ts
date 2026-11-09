import { Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { GitHubActionRole } from '../src';

const SUB = 'token.actions.githubusercontent.com:sub';
const AUD = 'token.actions.githubusercontent.com:aud';

function trustCondition(props: ConstructorParameters<typeof GitHubActionRole>[2]): any {
  const stack = new Stack();
  new GitHubActionRole(stack, 'Role', props);
  // the provider's custom resource has a role of its own; pick the OIDC one
  const roles = Object.values<any>(Template.fromStack(stack).findResources('AWS::IAM::Role'))
    .filter((role) => JSON.stringify(role.Properties.AssumeRolePolicyDocument).includes('sts:AssumeRoleWithWebIdentity'));
  expect(roles).toHaveLength(1);
  const statements = roles[0].Properties.AssumeRolePolicyDocument.Statement;
  expect(statements).toHaveLength(1);
  return statements[0].Condition;
}

describe('audience', () => {
  test('the trust policy requires sts.amazonaws.com by default', () => {
    expect(trustCondition({ repos: ['owner/repo'] })).toEqual({
      StringLike: { [SUB]: ['repo:owner/repo:*'] },
      StringEquals: { [AUD]: 'sts.amazonaws.com' },
    });
  });

  test('a custom audience replaces the default', () => {
    const condition = trustCondition({ repos: ['owner/repo'], audience: 'my-audience' });
    expect(condition.StringEquals).toEqual({ [AUD]: 'my-audience' });
    expect(condition.StringLike).toEqual({ [SUB]: ['repo:owner/repo:*'] });
  });

  test('the audience condition is also set with subject claims and an existing provider', () => {
    const stack = new Stack();
    new GitHubActionRole(stack, 'Role', {
      subjectClaims: ['repo:owner/repo:ref:refs/heads/main'],
      provider: GitHubActionRole.existingGitHubActionsProvider(stack),
    });
    Template.fromStack(stack).hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [{
          Condition: {
            StringLike: { [SUB]: ['repo:owner/repo:ref:refs/heads/main'] },
            StringEquals: { [AUD]: 'sts.amazonaws.com' },
          },
        }],
      },
    });
  });

  test('an empty audience is rejected', () => {
    expect(() => trustCondition({ repos: ['owner/repo'], audience: '' })).toThrow(/audience must not be empty/);
  });

  test('the provider is still created with the same client id', () => {
    const stack = new Stack();
    new GitHubActionRole(stack, 'Role', { repos: ['owner/repo'] });
    Template.fromStack(stack).hasResourceProperties('Custom::AWSCDKOpenIdConnectProvider', {
      ClientIDList: ['sts.amazonaws.com'],
    });
  });
});

describe('wildcards in repos', () => {
  test.each([
    ['*'],
    ['owner/*'],
    ['*/repo'],
    ['owner/re*'],
  ])('%s is rejected', (repo) => {
    expect(() => trustCondition({ repos: ['owner/other', repo] })).toThrow(
      new RegExp(`does not permit wildcards in repos \\(${repo.replace(/\*/g, '\\*').replace('/', '\\/')}\\)`),
    );
  });

  test('every offending entry is named', () => {
    expect(() => trustCondition({ repos: ['a/*', 'b/repo', 'c/*'] })).toThrow(/\(a\/\*, c\/\*\)/);
  });

  test('named repositories are accepted', () => {
    expect(trustCondition({ repos: ['owner/one', 'owner/two'] }).StringLike[SUB]).toEqual([
      'repo:owner/one:*',
      'repo:owner/two:*',
    ]);
  });
});

describe('wildcards in subjectClaims', () => {
  test.each([
    ['*'],
    ['repo:*'],
    ['repo:*:ref:refs/heads/main'],
    ['repo:*/repo:*'],
  ])('%s is rejected', (claim) => {
    expect(() => trustCondition({ subjectClaims: ['repo:owner/repo:environment:prod', claim] })).toThrow(
      /does not permit subjectClaims that trust any repository/,
    );
  });

  test.each([
    ['repo:owner/repo:ref:refs/heads/*'],
    ['repo:owner/repo:*'],
    ['repo:owner/*'],
    ['repo:owner/repo:environment:prod'],
    ['sub?ect'],
  ])('%s is accepted', (claim) => {
    expect(trustCondition({ subjectClaims: [claim] }).StringLike[SUB]).toEqual([claim]);
  });

  test('a repos entry and a claim are checked independently', () => {
    expect(() => trustCondition({ repos: ['owner/repo'], subjectClaims: ['*'] })).toThrow(/subjectClaims/);
    expect(() => trustCondition({ repos: ['*'], subjectClaims: ['repo:owner/repo:*'] })).toThrow(/repos/);
  });
});
