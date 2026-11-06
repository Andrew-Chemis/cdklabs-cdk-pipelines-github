import { readFileSync } from 'fs';
import { join } from 'path';
import { Stack, Stage } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { ShellStep } from 'aws-cdk-lib/pipelines';
import * as YAML from 'yaml';
import { TestApp, withTemporaryDirectory } from './testutil';
import { GitHubStage, GitHubWorkflow, GitHubWorkflowProps, JobSettings } from '../src';

const fixtures = join(__dirname, 'fixtures');

let app: TestApp;
beforeEach(() => {
  app = new TestApp({ outdir: 'job-timeout.out' });
});

afterEach(() => {
  app.cleanup();
});

type Setup = (pipeline: GitHubWorkflow, stage: Stage) => void;

function newStage(scope: Stage | TestApp, id: string, withAsset = true): Stage {
  const stage = new Stage(scope, id, { env: { account: '111111111111', region: 'us-east-1' } });
  const stack = new Stack(stage, 'MyStack');
  if (withAsset) {
    new lambda.Function(stack, 'Function', {
      code: lambda.Code.fromAsset(fixtures),
      handler: 'index.handler',
      runtime: lambda.Runtime.NODEJS_14_X,
    });
  }
  return stage;
}

function render(props: Partial<GitHubWorkflowProps> = {}, setup?: Setup): any {
  return withTemporaryDirectory((dir) => {
    const pipeline = new GitHubWorkflow(app, 'Pipeline', {
      workflowPath: `${dir}/.github/workflows/deploy.yml`,
      synth: new ShellStep('Build', { installCommands: ['yarn'], commands: ['yarn build'] }),
      ...props,
    });
    const stage = newStage(app, 'MyStage');
    if (setup) {
      setup(pipeline, stage);
    } else {
      pipeline.addStage(stage);
    }
    app.synth();
    return YAML.parse(readFileSync(pipeline.workflowPath, 'utf-8'));
  });
}

const timeouts = (workflow: any): Record<string, number | undefined> =>
  Object.fromEntries(Object.values<any>(workflow.jobs).map((job) => [job.name, job['timeout-minutes']]));

describe('JobSettings.timeoutMinutes', () => {
  test('is not rendered by default', () => {
    const workflow = render();
    expect(JSON.stringify(workflow)).not.toContain('timeout-minutes');
  });

  test('at the workflow level it reaches every job', () => {
    const workflow = render({ jobSettings: { timeoutMinutes: 30 } });
    const values = Object.values(timeouts(workflow));
    expect(values.length).toBeGreaterThanOrEqual(3);
    expect(new Set(values)).toEqual(new Set([30]));
  });

  test('can be combined with `if`', () => {
    const workflow = render({ jobSettings: { if: "github.repository == 'owner/repo'", timeoutMinutes: 20 } });
    for (const job of Object.values<any>(workflow.jobs)) {
      expect(job.if).toBe("github.repository == 'owner/repo'");
      expect(job['timeout-minutes']).toBe(20);
    }
  });

  test('stage settings reach deploy jobs only and win over the workflow level', () => {
    const workflow = render({ jobSettings: { timeoutMinutes: 30 } }, (pipeline, stage) => {
      pipeline.addStageWithGitHubOptions(stage, { jobSettings: { timeoutMinutes: 10 } });
    });
    const byName = timeouts(workflow);
    const deploy = Object.entries(byName).filter(([name]) => name.startsWith('Deploy'));
    const others = Object.entries(byName).filter(([name]) => !name.startsWith('Deploy'));
    expect(deploy.length).toBeGreaterThan(0);
    expect(deploy.map(([, t]) => t)).toEqual(deploy.map(() => 10));
    expect(others.map(([, t]) => t)).toEqual(others.map(() => 30));
  });

  test('stage settings alone leave the other jobs without a timeout', () => {
    const workflow = render({}, (pipeline, stage) => {
      pipeline.addStageWithGitHubOptions(stage, { jobSettings: { timeoutMinutes: 10 } });
    });
    for (const [name, minutes] of Object.entries(timeouts(workflow))) {
      expect(minutes).toBe(name.startsWith('Deploy') ? 10 : undefined);
    }
  });

  test('a GitHubStage carries its own timeout', () => {
    const workflow = withTemporaryDirectory((dir) => {
      const pipeline = new GitHubWorkflow(app, 'Pipeline', {
        workflowPath: `${dir}/.github/workflows/deploy.yml`,
        synth: new ShellStep('Build', { commands: ['yarn build'] }),
      });
      const stage = new GitHubStage(app, 'MyStage', {
        env: { account: '111111111111', region: 'us-east-1' },
        jobSettings: { timeoutMinutes: 15 },
      });
      new Stack(stage, 'MyStack');
      pipeline.addStage(stage);
      app.synth();
      return YAML.parse(readFileSync(pipeline.workflowPath, 'utf-8'));
    });
    const deploy = Object.values<any>(workflow.jobs).filter((job) => job.name.startsWith('Deploy'));
    expect(deploy.length).toBeGreaterThan(0);
    for (const job of deploy) {
      expect(job['timeout-minutes']).toBe(15);
    }
  });

  test.each([0, -5, 1.5, Number.NaN])('rejects %p at the workflow level', (minutes) => {
    expect(() => render({ jobSettings: { timeoutMinutes: minutes } as JobSettings })).toThrow(/timeoutMinutes must be a whole number of at least 1/);
  });

  test('rejects an invalid value in stage settings', () => {
    expect(() => render({}, (pipeline, stage) => {
      pipeline.addStageWithGitHubOptions(stage, { jobSettings: { timeoutMinutes: 0 } });
    })).toThrow(/timeoutMinutes must be a whole number of at least 1/);
  });
});
