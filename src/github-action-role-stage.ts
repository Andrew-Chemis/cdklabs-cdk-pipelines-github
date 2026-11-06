import { Environment, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { GitHubCommonProps } from './github-common';
import { GitHubActionRole, GitHubActionRoleProps } from './oidc-provider';
import { GitHubStage } from './stage';
import { StackCapabilities } from './stage-options';

/**
 * Properties for the GitHubActionRoleStage construct.
 */
export interface GitHubActionRoleStageProps extends GitHubCommonProps, GitHubActionRoleProps {
  /**
   * The name of the CloudFormation stack that holds the role.
   *
   * The stack always has this name, so a stack that was deployed by hand and
   * the stack the workflow updates are the same stack.
   */
  readonly stackName: string;

  /**
   * The account and region of the role stack.
   *
   * A stack is identified by account, region and name. If the environment
   * differs from where the stack was deployed by hand, the workflow creates a
   * second stack instead of updating the first.
   */
  readonly env: Environment;

  /**
   * The construct id of the role stack, which is part of the stack's artifact id
   * and so of the ids of the jobs that deploy it.
   *
   * @default 'RoleStack'
   */
  readonly stackId?: string;

  /**
   * Reference the account's existing GitHub OIDC provider instead of creating
   * a new one. An account can hold only one provider with the url
   * `https://token.actions.githubusercontent.com`.
   *
   * Cannot be combined with `provider`.
   *
   * @default false
   */
  readonly existingProvider?: boolean;
}

/**
 * A stage with one stack that holds a GitHub Actions OIDC role, so that the
 * role can be deployed by hand once and then updated by the workflow itself.
 *
 * The stack's `stackName` and `env` are pinned, and the deploy acknowledges
 * `CAPABILITY_NAMED_IAM`, which CloudFormation requires for a role that has a
 * fixed `roleName`. A stage would otherwise name the stack
 * `<stage name>-<stack id>`, and the workflow would deploy a second stack next
 * to the one that was created by hand.
 *
 * Deploying the role that the workflow assumes is circular. A change that
 * breaks the role's trust policy also breaks the workflow's ability to fix it,
 * and the way out is to deploy the role by hand again. Put the stage in the
 * first wave, so that a later wave that needs new permissions gets them in the
 * same run.
 *
 * Override `createRole` to build the role with another construct.
 */
export class GitHubActionRoleStage extends GitHubStage {
  /**
   * The stack that holds the role.
   */
  public readonly roleStack: Stack;

  /**
   * The role that GitHub Actions assumes.
   */
  public readonly role: iam.IRole;

  constructor(scope: Construct, id: string, props: GitHubActionRoleStageProps) {
    if (props.existingProvider && props.provider) {
      throw new Error('Specify either existingProvider or provider, not both');
    }

    super(scope, id, {
      env: props.env,
      gitHubEnvironment: props.gitHubEnvironment,
      jobSettings: props.jobSettings,
      stackCapabilities: [
        StackCapabilities.NAMED_IAM,
        ...(props.stackCapabilities ?? []).filter((c) => c !== StackCapabilities.NAMED_IAM),
      ],
    });

    this.roleStack = new Stack(this, props.stackId ?? 'RoleStack', {
      stackName: props.stackName,
      env: props.env,
    });

    this.role = this.createRole(this.roleStack, 'github-action-role', {
      repos: props.repos,
      subjectClaims: props.subjectClaims,
      roleName: props.roleName,
      thumbprints: props.thumbprints,
      provider: props.existingProvider
        ? GitHubActionRole.existingGitHubActionsProvider(this.roleStack)
        : props.provider,
    });
  }

  /**
   * Create the role in the role stack.
   *
   * By default this is a `GitHubActionRole`. Override it to build the role with
   * a construct of your own, and return the role it creates. It runs from the
   * constructor, so an override must not rely on fields the subclass
   * initializes.
   *
   * @param scope the role stack
   * @param id the construct id to use for the role, `github-action-role`
   * @param props the role properties given to the stage
   */
  protected createRole(scope: Construct, id: string, props: GitHubActionRoleProps): iam.IRole {
    return new GitHubActionRole(scope, id, props).role;
  }
}
