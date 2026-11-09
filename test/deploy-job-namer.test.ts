import { readFileSync } from 'fs';
import { Stack, Stage } from 'aws-cdk-lib';
import { ShellStep, StackDeployment, StageDeployment } from 'aws-cdk-lib/pipelines';
import * as YAML from 'yaml';
import { TestApp, withTemporaryDirectory } from './testutil';
import { GitHubWorkflow, IDeployJobNamer } from '../src';

let app: TestApp;
beforeEach(() => {
  app = new TestApp({ outdir: 'deploy-job-namer.out' });
});

afterEach(() => {
  app.cleanup();
});

function stage(id: string, region: string, stacks: string[]): Stage {
  const s = new Stage(app, id, { env: { account: '111111111111', region } });
  for (const name of stacks) {
    new Stack(s, name);
  }
  return s;
}

function render(namer: IDeployJobNamer | undefined, build: (pipeline: GitHubWorkflow) => void): Record<string, any> {
  return withTemporaryDirectory((dir) => {
    const pipeline = new GitHubWorkflow(app, 'Pipeline', {
      workflowPath: `${dir}/.github/workflows/deploy.yml`,
      synth: new ShellStep('Build', { commands: ['yarn build'] }),
      deployJobNamer: namer,
    });
    build(pipeline);
    app.synth();
    return YAML.parse(readFileSync(pipeline.workflowPath, 'utf-8')).jobs;
  });
}

const deployJobs = (jobs: Record<string, any>) => Object.entries(jobs).filter(([, job]) => job.steps.some((s: any) => s.id === 'Deploy'));

describe('deployJobNamer', () => {
  test('without a namer the job is named after the stack artifact', () => {
    const jobs = render(undefined, (p) => p.addStage(stage('Dev', 'us-east-1', ['Web'])));
    expect(deployJobs(jobs).map(([, job]) => job.name)).toEqual(['Deploy DevWeb4E4BD607']);
  });

  test('names the deploy job of every stack and leaves the job ids alone', () => {
    const withoutNamer = render(undefined, (p) => p.addStage(stage('Dev', 'us-east-1', ['Web', 'Db'])));
    app.cleanup();
    app = new TestApp({ outdir: 'deploy-job-namer.out' });
    const jobs = render({ deployJobName: (st, stack) => `${st.stageName} ${stack.region} ${stack.stackName}` }, (p) => {
      p.addStage(stage('Dev', 'us-east-1', ['Web', 'Db']));
    });
    expect(deployJobs(jobs).map(([, job]) => job.name).sort()).toEqual(['Dev us-east-1 Dev-Db', 'Dev us-east-1 Dev-Web']);
    expect(deployJobs(jobs).map(([id]) => id).sort()).toEqual(deployJobs(withoutNamer).map(([id]) => id).sort());
  });

  test('applies in every wave, including stages added to a wave together', () => {
    const calls: Array<[string, string]> = [];
    const jobs = render({
      deployJobName: (st: StageDeployment, stack: StackDeployment) => {
        calls.push([st.stageName, stack.stackArtifactId]);
        return `deploy ${st.stageName}/${stack.stackName}`;
      },
    }, (p) => {
      p.addStage(stage('First', 'us-east-1', ['A']));
      const wave = p.addWave('Second');
      wave.addStage(stage('Two', 'us-west-2', ['B']));
      wave.addStage(stage('Three', 'eu-west-1', ['C']));
    });
    expect(deployJobs(jobs).map(([, job]) => job.name).sort()).toEqual(['deploy First/First-A', 'deploy Three/Three-C', 'deploy Two/Two-B']);
    expect(calls.map(([st]) => st).sort()).toEqual(['First', 'Three', 'Two']);
  });

  test('does not rename the synth, publish or step jobs', () => {
    const jobs = render({ deployJobName: () => 'renamed' }, (p) => p.addStage(stage('Dev', 'us-east-1', ['Web'])));
    const others = Object.values(jobs).filter((job) => !job.steps.some((s: any) => s.id === 'Deploy')).map((job) => job.name);
    expect(others).toContain('Synthesize');
    expect(others).not.toContain('renamed');
  });

  test.each(['', '   '])('rejects the empty name %p', (name) => {
    expect(() => render({ deployJobName: () => name }, (p) => p.addStage(stage('Dev', 'us-east-1', ['Web'])))).toThrow(/deployJobNamer returned an empty name/);
  });
});
