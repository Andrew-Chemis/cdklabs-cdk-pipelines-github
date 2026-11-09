import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import * as path from 'path';
import { Stage } from 'aws-cdk-lib';
import { EnvironmentPlaceholders } from 'aws-cdk-lib/cx-api';
import { PipelineBase, PipelineBaseProps, ShellStep, StackAsset, StackDeployment, StackOutputReference, StageDeployment, Step, Wave, WaveOptions } from 'aws-cdk-lib/pipelines';
import { AGraphNode, PipelineGraph, Graph, isGraph } from 'aws-cdk-lib/pipelines/lib/helpers-internal';
import { Construct } from 'constructs';
import * as decamelize from 'decamelize';
import { AwsCredentials, AwsCredentialsProvider } from './aws-credentials';
import { DockerCredential } from './docker-credentials';
import { AddGitHubStageOptions, GitHubEnvironment } from './github-common';
import { posixPath } from './private/posix-utils';
import { GitHubStage } from './stage';
import { GitHubActionStep } from './steps/github-action-step';
import { GitHubWave } from './wave';
import * as github from './workflows-model';
import { YamlFile } from './yaml-file';

const CDKOUT_ARTIFACT = 'cdk.out';
const ASSET_HASH_NAME = 'asset-hash';

/**
 * Job level settings applied to all docker asset publishing jobs in the workflow.
 */
export interface DockerAssetJobSettings {
  /**
   * GitHub workflow steps to execute before building and publishing the image.
   *
   * @default []
   */
  readonly setupSteps?: github.JobStep[];

  /**
   * Additional permissions to grant to the docker image publishing job.
   *
   * @default - no additional permissions
   */
  readonly permissions?: github.JobPermissions;
}

/**
 * Job level settings applied to all jobs in the workflow.
 */
export interface JobSettings {
  /**
   * jobs.<job_id>.if.
   *
   * @see https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#jobsjob_idif
   */
  readonly if?: string;

  /**
   * jobs.<job_id>.timeout-minutes.
   *
   * The maximum number of minutes to let a job run before GitHub automatically
   * cancels it. Must be a whole number of at least 1.
   *
   * @see https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#jobsjob_idtimeout-minutes
   * @default - GitHub's default (360 minutes)
   */
  readonly timeoutMinutes?: number;
}

/**
 * Chooses the name GitHub shows for the job that deploys a stack.
 */
export interface IDeployJobNamer {
  /**
   * The `name` of the job that deploys `stack`.
   *
   * @param stage the stage the stack is deployed in
   * @param stack the stack that the job deploys
   */
  deployJobName(stage: StageDeployment, stack: StackDeployment): string;
}

/**
 * Props for `GitHubWorkflow`.
 */
export interface GitHubWorkflowProps extends PipelineBaseProps {
  /**
   * File path for the GitHub workflow.
   *
   * @default ".github/workflows/deploy.yml"
   */
  readonly workflowPath?: string;

  /**
   * Name of the workflow.
   *
   * @default "deploy"
   */
  readonly workflowName?: string;

  /**
   * GitHub workflow triggers.
   *
   * @default - By default, workflow is triggered on push to the `main` branch
   * and can also be triggered manually (`workflow_dispatch`).
   */
  readonly workflowTriggers?: github.WorkflowTriggers;

  /**
   * GitHub workflow concurrency
   *
   * @default - no concurrency settings
   */
  readonly concurrency?: github.ConcurrencyOptions;

  /**
   * Permissions of the workflow, rendered as its top-level `permissions`.
   *
   * Jobs that set their own permissions (all the jobs this library creates do)
   * are not affected by it, but it is the default for any job that does not,
   * such as a job added with a custom step. An empty object renders
   * `permissions: {}`, which grants nothing by default; it is not the same as
   * leaving the property unset, which renders no `permissions` key.
   *
   * @example const workflowPermissions = {};
   * @default - no top-level `permissions`
   */
  readonly workflowPermissions?: github.JobPermissions;

  /**
   * Whether the synthesize job may use the AWS credentials of the workflow.
   *
   * The job does not use them itself, but pre-build steps and the synth step
   * can. With OpenID Connect credentials the job is granted the `id-token`
   * permission so that they can. Set to `false` to leave `id-token` out of the
   * synthesize job's permissions entirely.
   *
   * @default true
   */
  readonly synthUsesAwsCredentials?: boolean;

  /**
   * Version of the [cdk-assets package](https://www.npmjs.com/package/cdk-assets) to use.
   * @default - automatic
   */
  readonly cdkAssetsVersion?: string;

  /**
   * Pass `--ignore-scripts` to the `npm install` of `cdk-assets` in the asset
   * publishing jobs, so that lifecycle scripts of `cdk-assets` and its
   * dependencies do not run on a runner that holds a checkout of the repository.
   *
   * @default false
   */
  readonly cdkAssetsInstallIgnoreScripts?: boolean;

  /**
   * Replace the ref of the GitHub Actions the workflow uses, for example to pin
   * them to commit SHAs.
   *
   * Keys are the action as written before the `@` in a `uses:` (`owner/repo`,
   * or `owner/repo/path` for an action in a subdirectory) and values are the ref
   * to use after it, such as a commit SHA or a tag. The ref is applied to every
   * step-level and job-level `uses` in the rendered workflow, including steps
   * you supply yourself (`preBuildSteps`, `postBuildSteps`, `GitHubActionStep`).
   * Local (`./`) and `docker://` references are never changed, and an entry that
   * matches nothing is ignored.
   *
   * @example const actionRefs = { 'actions/checkout': '0123456789abcdef0123456789abcdef01234567' };
   * @default - actions are used with the refs this library and your steps specify
   */
  readonly actionRefs?: { [ownerRepo: string]: string };

  /**
   * Indicates if the repository already contains a synthesized `cdk.out` directory, in which
   * case we will simply checkout the repo in jobs that require `cdk.out`.
   *
   * @default false
   */
  readonly preSynthed?: boolean;

  /**
   * Configure provider for AWS credentials used for deployment.
   *
   * @default - Get AWS credentials from GitHub secrets `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`.
   */
  readonly awsCreds?: AwsCredentialsProvider;

  /**
   * Names of GitHub repository secrets that include AWS credentials for
   * deployment.
   *
   * @default - `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`.
   *
   * @deprecated Use `awsCreds.fromGitHubSecrets()` instead.
   */
  readonly awsCredentials?: AwsCredentialsSecrets;

  /**
   * A role that utilizes the GitHub OIDC Identity Provider in your AWS account.
   * If supplied, this will be used instead of `awsCredentials`.
   *
   * You can create your own role in the console with the necessary trust policy
   * to allow gitHub actions from your gitHub repository to assume the role, or
   * you can utilize the `GitHubActionRole` construct to create a role for you.
   *
   * @default - GitHub repository secrets are used instead of OpenId Connect role.
   *
   * @deprecated Use `awsCreds.fromOpenIdConnect()` instead.
   */
  readonly gitHubActionRoleArn?: string;

  /**
   * Build container options.
   *
   * @default - GitHub defaults
   */
  readonly buildContainer?: github.ContainerOptions;

  /**
   * GitHub workflow steps to execute before build.
   *
   * @default []
   */
  readonly preBuildSteps?: github.JobStep[];

  /**
   * GitHub workflow steps to execute after build.
   *
   * @default []
   */
  readonly postBuildSteps?: github.JobStep[];

  /**
   * The Docker Credentials to use to login. If you set this variable,
   * you will be logged in to docker when you upload Docker Assets.
   */
  readonly dockerCredentials?: DockerCredential[];

  /**
   * The type of runner to run the job on. The runner can be either a
   * GitHub-hosted runner or a self-hosted runner.
   *
   * @default Runner.UBUNTU_LATEST
   */
  readonly runner?: github.Runner;

  /**
   * Will assume the GitHubActionRole in this region when publishing assets.
   * This is NOT the region in which the assets are published.
   *
   * In most cases, you do not have to worry about this property, and can safely
   * ignore it.
   *
   * @default "us-west-2"
   */
  readonly publishAssetsAuthRegion?: string;

  /**
   * Environment variables set on the `Install` and `Build` steps of the
   * synthesize job, and on no other step.
   *
   * Use this for values that only the steps that install and build need, such as
   * a token for a private package registry. Unlike the `env` of the synth
   * `ShellStep`, which applies to every step in the job (including actions in
   * `preBuildSteps` and `postBuildSteps`), these variables are not visible to the
   * other steps.
   *
   * @example const synthStepEnv = { NODE_AUTH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' };
   * @default - no additional environment variables
   */
  readonly synthStepEnv?: { [key: string]: string };

  /**
   * Permissions added to the synthesize job, merged over the ones the library
   * sets (`contents: read` and `id-token`).
   *
   * @example const synthJobPermissions = { packages: JobPermission.READ };
   * @default - no additional permissions
   */
  readonly synthJobPermissions?: github.JobPermissions;

  /**
   * Job level settings that will be applied to all jobs in the workflow,
   * including synth and asset deploy jobs. The valid settings are 'if' and
   * 'timeoutMinutes'. You can use 'if' to run jobs only in specific repositories.
   *
   * @see https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#example-only-run-job-for-specific-repository
   */
  readonly jobSettings?: JobSettings;

  /**
   * Job level settings applied to all docker asset publishing jobs in the workflow.
   *
   * @default - no additional settings
   */
  readonly dockerAssetJobSettings?: DockerAssetJobSettings;

  /**
   * Chooses the display name of the job that deploys each stack, in every wave.
   * The job id is not affected.
   *
   * @default - `Deploy <stack artifact id>`
   */
  readonly deployJobNamer?: IDeployJobNamer;
}

/**
 * CDK Pipelines for GitHub workflows.
 */
export class GitHubWorkflow extends PipelineBase {
  public readonly workflowPath: string;
  public readonly workflowName: string;
  public readonly workflowFile: YamlFile;

  private readonly workflowTriggers: github.WorkflowTriggers;
  private readonly concurrency?: github.ConcurrencyOptions;
  private readonly workflowPermissions?: github.JobPermissions;
  private readonly synthUsesAwsCredentials: boolean;
  private readonly preSynthed: boolean;
  private readonly awsCredentials: AwsCredentialsProvider;
  private readonly dockerCredentials: DockerCredential[];
  private readonly cdkAssetsVersion?: string;
  private readonly cdkAssetsInstallIgnoreScripts: boolean;
  private readonly actionRefs?: { [ownerRepo: string]: string };
  private readonly buildContainer?: github.ContainerOptions;
  private readonly preBuildSteps: github.JobStep[];
  private readonly postBuildSteps: github.JobStep[];
  private readonly jobOutputs: Record<string, github.JobStepOutput[]> = {};
  private readonly assetHashMap: Record<string, string> = {};
  private readonly runner: github.Runner;
  private readonly publishAssetsAuthRegion: string;
  private readonly stackProperties: Record<
    string,
    {
      environment: AddGitHubStageOptions['gitHubEnvironment'];
      capabilities: AddGitHubStageOptions['stackCapabilities'];
      settings: AddGitHubStageOptions['jobSettings'];
    }
  > = {};
  private readonly jobSettings?: JobSettings;
  private readonly deployJobNamer?: IDeployJobNamer;
  private readonly stageOfStack: Record<string, StageDeployment> = {};
  private readonly synthStepEnv?: { [key: string]: string };
  private readonly synthJobPermissions?: github.JobPermissions;
  private dockerAssetJobSettings?: DockerAssetJobSettings;
  // in order to keep track of if this pipeline has been built so we can
  // catch later calls to addWave() or addStage()
  private builtGH = false;

  constructor(scope: Construct, id: string, props: GitHubWorkflowProps) {
    super(scope, id, props);

    this.cdkAssetsVersion = props.cdkAssetsVersion;
    this.cdkAssetsInstallIgnoreScripts = props.cdkAssetsInstallIgnoreScripts ?? false;
    this.actionRefs = props.actionRefs ? validateActionRefs(props.actionRefs) : undefined;
    this.preSynthed = props.preSynthed ?? false;
    this.buildContainer = props.buildContainer;
    this.preBuildSteps = props.preBuildSteps ?? [];
    this.postBuildSteps = props.postBuildSteps ?? [];
    validateJobSettings(props.jobSettings);
    this.jobSettings = props.jobSettings;
    this.deployJobNamer = props.deployJobNamer;
    this.synthStepEnv = props.synthStepEnv;
    this.synthJobPermissions = props.synthJobPermissions;
    this.dockerAssetJobSettings = props.dockerAssetJobSettings;

    this.awsCredentials = this.getAwsCredentials(props);

    this.dockerCredentials = props.dockerCredentials ?? [];

    this.workflowPath = props.workflowPath ? posixPath(props.workflowPath) : '.github/workflows/deploy.yml';
    if (!this.workflowPath.endsWith('.yml') &&!this.workflowPath.endsWith('.yaml')) {
      throw new Error('workflow file is expected to be a yaml file');
    }
    if (!this.workflowPath.includes('.github/workflows/')) {
      throw new Error('workflow files must be stored in the \'.github/workflows\' directory of your repository');
    }

    this.workflowFile = new YamlFile(this.workflowPath);
    this.workflowName = props.workflowName ?? 'deploy';
    this.workflowTriggers = props.workflowTriggers ?? {
      push: { branches: ['main'] },
      workflowDispatch: {},
    };

    if (props.concurrency) {
      this.concurrency = {
        group: props.concurrency.group,
        cancelInProgress: props.concurrency.cancelInProgress ?? false,
      };
    }

    this.workflowPermissions = props.workflowPermissions;
    this.synthUsesAwsCredentials = props.synthUsesAwsCredentials ?? true;

    this.runner = props.runner ?? github.Runner.UBUNTU_LATEST;
    this.publishAssetsAuthRegion = props.publishAssetsAuthRegion ?? 'us-west-2';
  }

  /**
   * Parse AWS credential configuration from deprecated properties For backwards compatibility.
   */
  private getAwsCredentials(props: GitHubWorkflowProps) {
    if (props.gitHubActionRoleArn) {
      if (props.awsCreds) {
        throw new Error('Please provide only one method of authentication (remove githubActionRoleArn)');
      }
      return AwsCredentials.fromOpenIdConnect({
        gitHubActionRoleArn: props.gitHubActionRoleArn,
      });
    }

    if (props.awsCredentials) {
      if (props.awsCreds) {
        throw new Error('Please provide only one method of authentication (remove awsCredentials)');
      }
      return AwsCredentials.fromGitHubSecrets({
        accessKeyId: 'AWS_ACCESS_KEY_ID',
        secretAccessKey: 'AWS_SECRET_ACCESS_KEY',
        ...props.awsCredentials,
      });
    }

    return props.awsCreds ?? AwsCredentials.fromGitHubSecrets();
  }

  /**
   * Deploy a single Stage by itself with options for further GitHub configuration.
   *
   * Add a Stage to the pipeline, to be deployed in sequence with other Stages added to the pipeline.
   * All Stacks in the stage will be deployed in an order automatically determined by their relative dependencies.
   */
  public addStageWithGitHubOptions(stage: Stage, options?: AddGitHubStageOptions): StageDeployment {
    const stageDeployment = this.addStage(stage, options);

    // keep track of GitHub specific options
    const stacks = stageDeployment.stacks;
    this.addStackProps(stacks, 'environment', options?.gitHubEnvironment);
    this.addStackProps(stacks, 'capabilities', options?.stackCapabilities);
    this.addStackProps(stacks, 'settings', options?.jobSettings);

    return stageDeployment;
  }

  /**
   * Add a Wave to the pipeline, for deploying multiple Stages in parallel
   *
   * Use the return object of this method to deploy multiple stages in parallel.
   *
   * Example:
   *
   * ```ts
   * declare const pipeline: GitHubWorkflow; // assign pipeline a value
   *
   * const wave = pipeline.addWave('MyWave');
   * wave.addStage(new MyStage(this, 'Stage1'));
   * wave.addStage(new MyStage(this, 'Stage2'));
   * ```
   */
  public addWave(id: string, options?: WaveOptions): Wave {
    return this.addGitHubWave(id, options);
  }

  public addGitHubWave(id: string, options?: WaveOptions): GitHubWave {
    if (this.builtGH) {
      throw new Error(
        "addWave: can't add Waves anymore after buildPipeline() has been called",
      );
    }

    const wave = new GitHubWave(id, this, options);
    this.waves.push(wave);
    return wave;
  }

  /**
   * Support adding stages with GitHub options to waves - should ONLY be called internally.
   *
   * Use `pipeline.addWave()` and it'll call this when `wave.addStage()` is called.
   *
   * `pipeline.addStage()` will also call this, since it calls `pipeline.addWave().addStage()`.
   *
   *  @internal
   */
  public _addStageFromWave(
    stage: Stage,
    stageDeployment: StageDeployment,
    options?: AddGitHubStageOptions,
  ) {
    if (!(stage instanceof GitHubStage) && options === undefined) {
      return;
    }

    const ghStage = stage instanceof GitHubStage ? stage : undefined;

    // keep track of GitHub specific options
    const stacks = stageDeployment.stacks;
    this.addStackProps(
      stacks,
      'environment',
      ghStage?.props?.gitHubEnvironment ?? options?.gitHubEnvironment,
    );
    this.addStackProps(
      stacks,
      'capabilities',
      ghStage?.props?.stackCapabilities ?? options?.stackCapabilities,
    );
    this.addStackProps(
      stacks,
      'settings',
      ghStage?.props?.jobSettings ?? options?.jobSettings,
    );
  }

  private addStackProps(stacks: StackDeployment[], key: string, value: any) {
    if (value === undefined) { return; }
    if (key === 'settings') { validateJobSettings(value); }
    for (const stack of stacks) {
      this.stackProperties[stack.stackArtifactId] = {
        ...this.stackProperties[stack.stackArtifactId],
        [key]: value,
      };
    }
  }

  protected doBuildPipeline() {
    this.builtGH = true;
    const app = Stage.of(this);
    if (!app) {
      throw new Error('The GitHub Workflow must be defined in the scope of an App');
    }
    const cdkoutDir = app.outdir;

    const jobs = new Array<Job>();

    for (const wave of this.waves) {
      for (const stage of wave.stages) {
        for (const stack of stage.stacks) {
          this.stageOfStack[stack.stackArtifactId] = stage;
        }
      }
    }

    const structure = new PipelineGraph(this, {
      selfMutation: false,
      publishTemplate: true,
      prepareStep: false, // we create and execute the changeset in a single job
    });

    for (const stageNode of flatten(structure.graph.sortedChildren())) {
      if (!isGraph(stageNode)) {
        throw new Error(`Top-level children must be graphs, got '${stageNode}'`);
      }

      const tranches = stageNode.sortedLeaves();

      for (const tranche of tranches) {
        for (const node of tranche) {
          const job = this.jobForNode(node, {
            assemblyDir: cdkoutDir,
            structure,
          });

          if (job) {
            jobs.push(job);
          }
        }
      }
    }

    // convert jobs to a map and make sure there are no duplicates
    const jobmap: Record<string, github.Job> = {};
    for (const job of jobs) {
      if (job.id in jobmap) {
        throw new Error(`duplicate job id ${job.id}`);
      }
      jobmap[job.id] = snakeCaseKeys(job.definition);
    }

    // Update jobs with late-bound output requests
    this.insertJobOutputs(jobmap);

    if (this.actionRefs) {
      applyActionRefs(jobmap, this.actionRefs);
    }

    const workflow = {
      name: this.workflowName,
      on: snakeCaseKeys(this.workflowTriggers, '_'),
      ...(this.concurrency ? {
        concurrency: {
          'group': this.concurrency.group,
          'cancel-in-progress': this.concurrency.cancelInProgress,
        },
      } : {}),
      ...(this.workflowPermissions ? { permissions: snakeCaseKeys(this.workflowPermissions) } : {}),
      jobs: jobmap,
    };

    // write as a yaml file
    this.workflowFile.update(workflow);

    // create directory if it does not exist
    mkdirSync(path.dirname(this.workflowPath), { recursive: true });

    // GITHUB_WORKFLOW is set when GitHub Actions is running the workflow.
    // see: https://docs.github.com/en/actions/learn-github-actions/environment-variables#default-environment-variables
    const contextValue = this.node.tryGetContext('cdk-pipelines-github:diffProtection');
    const diffProtection = contextValue === 'false' ? false : contextValue ?? true;
    if (diffProtection && process.env.GITHUB_WORKFLOW === this.workflowName) {
      // check if workflow file has changed
      if (!existsSync(this.workflowPath) || this.workflowFile.toYaml() !== readFileSync(this.workflowPath, 'utf8')) {
        throw new Error(`Please commit the updated workflow file ${path.relative(__dirname, this.workflowPath)} when you change your pipeline definition.`);
      }
    }

    this.workflowFile.writeFile();
  }

  private insertJobOutputs(jobmap: Record<string, github.Job>) {
    for (const [jobId, jobOutputs] of Object.entries(this.jobOutputs)) {
      jobmap[jobId] = {
        ...jobmap[jobId],
        outputs: {
          ...jobmap[jobId].outputs,
          ...this.renderJobOutputs(jobOutputs),
        },
      };
    }
  }

  private renderJobOutputs(outputs: github.JobStepOutput[]) {
    const renderedOutputs: Record<string, string> = {};
    for (const output of outputs) {
      renderedOutputs[output.outputName] = `\${{ steps.${output.stepId}.outputs.${output.outputName} }}`;
    }
    return renderedOutputs;
  }

  /**
   * Make an action from the given node and/or step
   */
  private jobForNode(node: AGraphNode, options: Context): Job | undefined {
    switch (node.data?.type) {
      // Nothing for these, they are groupings (shouldn't even have popped up here)
      case 'group':
      case 'stack-group':
      case undefined:
        throw new Error(`jobForNode: did not expect to get group nodes: ${node.data?.type}`);

      case 'self-update':
        throw new Error('GitHub Workflows does not support self mutation');

      case 'publish-assets':
        return this.jobForAssetPublish(node, node.data.assets, options);

      case 'prepare':
        throw new Error('"prepare" is not supported by GitHub Workflows');

      case 'execute':
        return this.jobForDeploy(node, node.data.stack, node.data.captureOutputs);

      case 'step':
        if (node.data.isBuildStep) {
          return this.jobForBuildStep(node, node.data.step);
        } else if (node.data.step instanceof ShellStep) {
          return this.jobForScriptStep(node, node.data.step);
        } else if (node.data.step instanceof GitHubActionStep) {
          return this.jobForGitHubActionStep(node, node.data.step);
        } else {
          throw new Error(`unsupported step type: ${node.data.step.constructor.name}`);
        }

      default:
        // The 'as any' is temporary, until the change upstream rolls out
        throw new Error(`GitHubWorfklow does not support graph nodes of type '${(node.data as any)?.type}'. You are probably using a feature this CDK Pipelines implementation does not support.`);
    }
  }

  private jobForAssetPublish(node: AGraphNode, assets: StackAsset[], options: Context): Job {
    if (assets.length === 0) {
      throw new Error('Asset Publish step must have at least 1 asset');
    }

    const installSuffix = this.cdkAssetsVersion ? `@${this.cdkAssetsVersion}` : '';
    const installFlags = this.cdkAssetsInstallIgnoreScripts ? ' --ignore-scripts' : '';
    const cdkoutDir = options.assemblyDir;
    const jobId = node.uniqueId;
    const { assetId, assetManifestPath } = assets[0];
    const preBuildSteps: github.JobStep[] = [];
    let permissions: github.JobPermissions = {
      contents: github.JobPermission.READ,
      idToken: this.awsCredentials.jobPermission(),
    };

    // check if asset is docker asset and if we have docker credentials
    const dockerLoginSteps: github.JobStep[] = [];
    if (node.uniqueId.includes('DockerAsset')) {
      if (this.dockerCredentials.length > 0) {
        for (const creds of this.dockerCredentials) {
          dockerLoginSteps.push(...this.stepsToConfigureDocker(creds));
        }
      }
      if (this.dockerAssetJobSettings?.setupSteps) {
        preBuildSteps.push(...this.dockerAssetJobSettings.setupSteps);
      }

      permissions = {
        ...permissions,
        ...this.dockerAssetJobSettings?.permissions,
      };
    }

    // create one file and make one step
    const relativeToAssembly = (p: string) => posixPath(path.join(cdkoutDir, path.relative(path.resolve(cdkoutDir), p)));
    const fileContents: string[] = ['set -ex'].concat(assets.map((asset) => {
      return `npx cdk-assets --path "${relativeToAssembly(asset.assetManifestPath)}" --verbose publish "${asset.assetSelector}"`;
    }));

    // we need the jobId to reference the outputs later
    this.assetHashMap[assetId] = jobId;
    fileContents.push(`echo '${ASSET_HASH_NAME}=${assetId}' >> $GITHUB_OUTPUT`);

    const publishStepFile = posixPath(path.join(path.dirname(relativeToAssembly(assetManifestPath)), `publish-${jobId}-step.sh`));
    mkdirSync(path.dirname(publishStepFile), { recursive: true });
    writeFileSync(publishStepFile, fileContents.join('\n'), { encoding: 'utf-8' });

    const publishStep: github.JobStep = {
      id: 'Publish',
      name: `Publish ${jobId}`,
      run: `/bin/bash ./cdk.out/${posixPath(path.relative(cdkoutDir, publishStepFile))}`,
    };

    return {
      id: jobId,
      definition: {
        name: `Publish Assets ${jobId}`,
        ...this.renderJobSettingParameters(),
        needs: this.renderDependencies(node),
        permissions,
        runsOn: this.runner.runsOn,
        outputs: {
          [ASSET_HASH_NAME]: `\${{ steps.Publish.outputs.${ASSET_HASH_NAME} }}`,
        },
        steps: [
          ...this.stepsToDownloadAssembly(cdkoutDir),
          {
            name: 'Install',
            run: `npm install --no-save${installFlags} cdk-assets${installSuffix}`,
          },
          ...this.stepsToConfigureAws(this.publishAssetsAuthRegion),
          ...dockerLoginSteps,
          ...preBuildSteps,
          publishStep,
        ],
      },
    };
  }

  private jobForDeploy(node: AGraphNode, stack: StackDeployment, _captureOutputs: boolean): Job {
    const region = stack.region;
    const account = stack.account;
    if (!region || !account) {
      throw new Error('"account" and "region" are required');
    }

    if (!stack.templateUrl) {
      throw new Error(`unable to determine template URL for stack ${stack.stackArtifactId}`);
    }

    const resolve = (s: string): string => {
      const partition = process.env.CDK_AWS_PARTITION ?? 'aws';
      return EnvironmentPlaceholders.replace(s, {
        accountId: account,
        region: region,
        partition: partition,
      });
    };

    const replaceAssetHash = (template: string) => {
      const hash = path.parse(template.split('/').pop() ?? '').name;
      if (this.assetHashMap[hash] === undefined) {
        throw new Error(`Template asset hash ${hash} not found.`);
      }
      const updated_template = template.replace(hash, `\${{ needs.${this.assetHashMap[hash]}.outputs.${ASSET_HASH_NAME} }}`);
      return process.env.CDK_AWS_PARTITION == 'aws-cn'
        ? updated_template.replace('.amazonaws.com', '.amazonaws.com.cn')
        : updated_template;
    };

    const params: Record<string, any> = {
      'name': stack.stackName,
      'template': replaceAssetHash(resolve(stack.templateUrl)),
      'fail-on-empty-changeset': false,
    };

    const capabilities = this.stackProperties[stack.stackArtifactId]?.capabilities;
    if (capabilities) {
      params.capabilities = Array(capabilities).join(',');
    }

    if (stack.executionRoleArn) {
      params['role-arn'] = resolve(stack.executionRoleArn);
    }
    const assumeRoleArn = stack.assumeRoleArn ? resolve(stack.assumeRoleArn) : undefined;

    return {
      id: node.uniqueId,
      definition: {
        name: this.deployJobNameOf(stack),
        ...this.renderJobSettingParameters(),
        ...this.stackProperties[stack.stackArtifactId]?.settings,
        permissions: {
          contents: github.JobPermission.READ,
          idToken: this.awsCredentials.jobPermission(),
        },
        ...this.renderGitHubEnvironment(this.stackProperties[stack.stackArtifactId]?.environment),
        needs: this.renderDependencies(node),
        runsOn: this.runner.runsOn,
        steps: [
          ...this.stepsToConfigureAws(region, assumeRoleArn),
          {
            id: 'Deploy',
            uses: 'aws-actions/aws-cloudformation-github-deploy@v2',
            with: params,
          },
        ],
      },
    };
  }

  private deployJobNameOf(stack: StackDeployment): string {
    if (!this.deployJobNamer) {
      return `Deploy ${stack.stackArtifactId}`;
    }
    const name = this.deployJobNamer.deployJobName(this.stageOfStack[stack.stackArtifactId], stack);
    if (typeof name !== 'string' || name.trim() === '') {
      throw new Error(`deployJobNamer returned an empty name for stack '${stack.stackArtifactId}'`);
    }
    return name;
  }

  private jobForBuildStep(node: AGraphNode, step: Step): Job {
    if (!(step instanceof ShellStep)) {
      throw new Error('synthStep must be a ScriptStep');
    }

    if (step.inputs.length > 0) {
      throw new Error('synthStep cannot have inputs');
    }

    if (step.outputs.length > 1) {
      throw new Error('synthStep must have a single output');
    }

    if (!step.primaryOutput) {
      throw new Error('synthStep requires a primaryOutput which contains cdk.out');
    }

    const cdkOut = step.outputs[0];

    const stepEnv = this.synthStepEnv ? { env: { ...this.synthStepEnv } } : {};

    const installSteps = step.installCommands.length > 0 ? [{
      name: 'Install',
      run: step.installCommands.join('\n'),
      ...stepEnv,
    }] : [];

    return {
      id: node.uniqueId,
      definition: {
        name: 'Synthesize',
        ...this.renderJobSettingParameters(),
        permissions: {
          contents: github.JobPermission.READ,
          // The Synthesize job does not use the GitHub Action Role on its own, but it's possible
          // that it is being used in the preBuildSteps.
          idToken: this.awsCredentials.jobPermission(),
          ...this.synthJobPermissions,
          ...(this.synthUsesAwsCredentials ? { idToken: this.awsCredentials.jobPermission() } : {}),
        },
        runsOn: this.runner.runsOn,
        needs: this.renderDependencies(node),
        env: step.env,
        container: this.buildContainer,
        steps: [
          ...this.stepsToCheckout(),
          ...this.preBuildSteps,
          ...installSteps,
          {
            name: 'Build',
            run: step.commands.join('\n'),
            ...stepEnv,
          },
          ...this.postBuildSteps,
          ...this.stepsToUploadAssembly(cdkOut.directory),
        ],
      },
    };
  }

  /**
   * Searches for the stack that produced the output via the current
   * job's dependencies.
   *
   * This function should always find a stack, since it is guaranteed
   * that a CfnOutput comes from a referenced stack.
   */
  private findStackOfOutput(ref: StackOutputReference, node: AGraphNode) {
    for (const dep of node.allDeps) {
      if (dep.data?.type === 'execute' && ref.isProducedBy(dep.data.stack)) {
        return dep.uniqueId;
      }
    }
    // Should never happen
    throw new Error(`The output ${ref.outputName} is not referenced by any of the dependent stacks!`);
  }

  private addJobOutput(jobId: string, output: github.JobStepOutput) {
    if (this.jobOutputs[jobId] === undefined) {
      this.jobOutputs[jobId] = [output];
    } else {
      this.jobOutputs[jobId].push(output);
    }
  }

  private jobForScriptStep(node: AGraphNode, step: ShellStep): Job {
    const envVariables: Record<string, string> = {};
    for (const [envName, ref] of Object.entries(step.envFromCfnOutputs)) {
      const jobId = this.findStackOfOutput(ref, node);
      this.addJobOutput(jobId, {
        outputName: ref.outputName,
        stepId: 'Deploy',
      });
      envVariables[envName] = `\${{ needs.${jobId}.outputs.${ref.outputName} }}`;
    }

    const downloadInputs = new Array<github.JobStep>();
    const uploadOutputs = new Array<github.JobStep>();

    for (const input of step.inputs) {
      downloadInputs.push({
        uses: 'actions/download-artifact@v8',
        with: {
          name: input.fileSet.id,
          path: input.directory,
        },
      });
    }

    for (const output of step.outputs) {
      uploadOutputs.push({
        uses: 'actions/upload-artifact@v7',
        with: {
          name: output.fileSet.id,
          path: output.directory,
        },
      });
    }

    const installSteps = step.installCommands.length > 0 ? [{
      name: 'Install',
      run: step.installCommands.join('\n'),
    }] : [];

    return {
      id: node.uniqueId,
      definition: {
        name: step.id,
        ...this.renderJobSettingParameters(),
        permissions: {
          contents: github.JobPermission.READ,
        },
        runsOn: this.runner.runsOn,
        needs: this.renderDependencies(node),
        env: {
          ...step.env,
          ...envVariables,
        },
        steps: [
          ...downloadInputs,
          ...installSteps,
          { run: step.commands.join('\n') },
          ...uploadOutputs,
        ],
      },
    };
  }

  private jobForGitHubActionStep(node: AGraphNode, step: GitHubActionStep): Job {
    return {
      id: node.uniqueId,
      definition: {
        name: step.id,
        ...this.renderJobSettingParameters(),
        permissions: step.permissions ?? {
          contents: github.JobPermission.WRITE,
        },
        runsOn: this.runner.runsOn,
        needs: this.renderDependencies(node),
        env: step.env,
        environment: step.githubEnvironment,
        steps: step.jobSteps,
      },
    };
  }

  private stepsToConfigureAws(region: string, assumeRoleArn?: string): github.JobStep[] {
    return this.awsCredentials.credentialSteps(region, assumeRoleArn);
  }

  private stepsToConfigureDocker(dockerCredential: DockerCredential): github.JobStep[] {
    let params: Record<string, any>;

    if (dockerCredential.name === 'docker') {
      params = {
        username: dockerCredential.username,
        password: dockerCredential.password,
      };
    } else if (dockerCredential.name === 'ecr') {
      params = {
        registry: dockerCredential.registry,
      };
    } else {
      params = {
        registry: dockerCredential.registry,
        username: dockerCredential.username,
        password: dockerCredential.password,
      };
    }
    if (dockerCredential.name === 'ghcr') {
      this.dockerAssetJobSettings = {
        ...this.dockerAssetJobSettings,
        permissions: {
          ...this.dockerAssetJobSettings?.permissions,
          packages: github.JobPermission.READ,
        },
      };
    }

    return [
      {
        uses: 'docker/login-action@v4',
        with: params,
      },
    ];
  }

  private stepsToDownloadAssembly(targetDir: string): github.JobStep[] {
    if (this.preSynthed) {
      return this.stepsToCheckout();
    }

    return [{
      name: `Download ${CDKOUT_ARTIFACT}`,
      uses: 'actions/download-artifact@v8',
      with: {
        name: CDKOUT_ARTIFACT,
        path: targetDir,
      },
    }];
  }

  private stepsToCheckout(): github.JobStep[] {
    return [
      {
        name: 'Checkout',
        uses: 'actions/checkout@v6',
      },
    ];
  }

  private stepsToUploadAssembly(dir: string): github.JobStep[] {
    if (this.preSynthed) {
      return [];
    }

    return [{
      name: `Upload ${CDKOUT_ARTIFACT}`,
      uses: 'actions/upload-artifact@v7',
      with: {
        name: CDKOUT_ARTIFACT,
        path: dir,
        ['include-hidden-files']: true,
      },
    }];
  }

  private renderDependencies(node: AGraphNode) {
    const deps = new Array<AGraphNode>();

    for (const d of node.allDeps) {
      if (d instanceof Graph) {
        deps.push(...d.allLeaves().nodes);
      } else {
        deps.push(d);
      }
    }

    return deps.map(x => x.uniqueId);
  }

  private renderJobSettingParameters() {
    return this.jobSettings;
  }

  private renderGitHubEnvironment(environment?: GitHubEnvironment) {
    if (!environment) {
      return {};
    }
    if (environment.url === undefined) {
      return { environment: environment.name };
    }
    return { environment };
  }
}

function validateJobSettings(settings?: JobSettings) {
  const minutes = settings?.timeoutMinutes;
  if (minutes !== undefined && (!Number.isInteger(minutes) || minutes < 1)) {
    throw new Error(`jobSettings.timeoutMinutes must be a whole number of at least 1, got ${minutes}`);
  }
}

function validateActionRefs(refs: { [ownerRepo: string]: string }): { [ownerRepo: string]: string } {
  for (const [action, ref] of Object.entries(refs)) {
    if (!/^[\w.-]+\/[\w.-]+(\/[^@\s]+)?$/.test(action)) {
      throw new Error(`actionRefs: '${action}' is not an action name like 'owner/repo' or 'owner/repo/path'`);
    }
    if (typeof ref !== 'string' || ref === '' || /[@\s]/.test(ref)) {
      throw new Error(`actionRefs: the ref for '${action}' must be a non-empty string without '@' or whitespace, got '${ref}'`);
    }
  }
  return { ...refs };
}

/**
 * Rewrite the ref of every `uses` of a job or of one of its steps.
 */
function applyActionRefs(jobs: Record<string, github.Job>, refs: { [ownerRepo: string]: string }) {
  const rewrite = (uses: string): string => {
    const at = uses.lastIndexOf('@');
    if (at === -1 || uses.startsWith('./') || uses.startsWith('docker://')) {
      return uses;
    }
    const action = uses.slice(0, at);
    return Object.prototype.hasOwnProperty.call(refs, action) ? `${action}@${refs[action]}` : uses;
  };

  for (const job of Object.values(jobs)) {
    // a job that calls a reusable workflow has `uses` and no steps
    const callsWorkflow = job as { uses?: string };
    if (callsWorkflow.uses !== undefined) {
      callsWorkflow.uses = rewrite(callsWorkflow.uses);
    }
    for (const step of job.steps ?? []) {
      if (step.uses !== undefined) {
        (step as { uses?: string }).uses = rewrite(step.uses);
      }
    }
  }
}

interface Context {
  /**
   * The pipeline graph.
   */
  readonly structure: PipelineGraph;

  /**
   * Name of cloud assembly directory.
   */
  readonly assemblyDir: string;
}

interface Job {
  readonly id: string;
  readonly definition: github.Job;
}

function snakeCaseKeys<T = unknown>(obj: T, sep = '-'): T {
  if (typeof obj !== 'object' || obj == null) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(o => snakeCaseKeys(o, sep)) as any;
  }

  const result: Record<string, unknown> = {};
  for (let [k, v] of Object.entries(obj)) {
    // we don't want to snake case environment variables
    if (k !== 'env' && typeof v === 'object' && v != null) {
      v = snakeCaseKeys(v);
    }
    result[decamelize(k, { separator: sep })] = v;
  }
  return result as any;
}

/**
 * Names of secrets for AWS credentials.
 */
export interface AwsCredentialsSecrets {
  /**
   * @default "AWS_ACCESS_KEY_ID"
   */
  readonly accessKeyId?: string;

  /**
   * @default "AWS_SECRET_ACCESS_KEY"
   */
  readonly secretAccessKey?: string;

  /**
   * @default - no session token is used
   */
  readonly sessionToken?: string;
}

export function* flatten<A>(xs: Iterable<A[]>): IterableIterator<A> {
  for (const x of xs) {
    for (const y of x) {
      yield y;
    }
  }
}
