import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Stack, Stage } from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { AssetType, ShellStep } from 'aws-cdk-lib/pipelines';
import * as YAML from 'yaml';
import { TestApp, withTemporaryDirectory } from './testutil';
import { GitHubWorkflow, GitHubWorkflowProps } from '../src';

const dockerDir = join(__dirname, 'demo-image');

interface StackSpec {
  readonly id: string;
  /** One Lambda function per entry, each with its own code (so its own asset). */
  readonly lambdas?: string[];
  readonly docker?: boolean;
}

interface StageSpec {
  readonly id: string;
  readonly stacks: StackSpec[];
}

interface Rendered {
  readonly text: string;
  readonly jobs: Record<string, any>;
  /** The contents of the publish scripts in cdk.out, by file name. */
  readonly scripts: Record<string, string>;
}

function publishScripts(dir: string, found: Record<string, string> = {}): Record<string, string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      publishScripts(full, found);
    } else if (/^publish-.*-step\.sh$/.test(entry)) {
      found[entry] = readFileSync(full, 'utf-8');
    }
  }
  return found;
}

function render(stages: StageSpec[], props: Partial<GitHubWorkflowProps> = {}): Rendered {
  const assets = mkdtempSync(join(tmpdir(), 'publish-assets-code-'));
  const app = new TestApp({ outdir: 'publish-assets.out' });
  try {
    return withTemporaryDirectory((dir) => {
      const pipeline = new GitHubWorkflow(app, 'Pipeline', {
        workflowPath: `${dir}/.github/workflows/deploy.yml`,
        synth: new ShellStep('Build', { installCommands: ['yarn'], commands: ['yarn build'] }),
        ...props,
      });
      for (const spec of stages) {
        const stage = new Stage(app, spec.id, { env: { account: '111111111111', region: 'us-east-1' } });
        for (const stackSpec of spec.stacks) {
          const stack = new Stack(stage, stackSpec.id);
          (stackSpec.lambdas ?? []).forEach((code, i) => {
            const codeDir = join(assets, `${spec.id}-${stackSpec.id}-${i}`);
            mkdirSync(codeDir, { recursive: true });
            writeFileSync(join(codeDir, 'index.js'), `exports.handler = async () => '${code}';`);
            new lambda.Function(stack, `Function${i}`, {
              code: lambda.Code.fromAsset(codeDir),
              handler: 'index.handler',
              runtime: lambda.Runtime.NODEJS_18_X,
            });
          });
          if (stackSpec.docker) {
            new codebuild.Project(stack, 'Project', {
              buildSpec: codebuild.BuildSpec.fromObject({ version: '0.2', phases: { build: { commands: ['ls'] } } }),
              grantReportGroupPermissions: false,
              environment: { buildImage: codebuild.LinuxBuildImage.fromAsset(stack, 'Image', { directory: dockerDir }) },
            });
          }
        }
        pipeline.addStage(stage);
      }
      app.synth();
      const text = readFileSync(pipeline.workflowPath, 'utf-8');
      return { text, jobs: YAML.parse(text).jobs, scripts: publishScripts(app.outdir) };
    });
  } finally {
    app.cleanup();
    rmSync(assets, { recursive: true });
  }
}

const jobsNamed = (jobs: Record<string, any>, prefix: string) =>
  Object.entries<any>(jobs).filter(([, job]) => job.name.startsWith(prefix));
const publishJobs = (jobs: Record<string, any>) => jobsNamed(jobs, 'Publish Assets');
const deployJobs = (jobs: Record<string, any>) => jobsNamed(jobs, 'Deploy ');
const templateOf = (job: any): string => job.steps.find((s: any) => s.id === 'Deploy').with.template;
const OUTPUT_REFERENCE = /\$\{\{ needs\.([^.]+)\.outputs\.([^ ]+) \}\}/;

const twoStacks: StageSpec[] = [
  { id: 'Dev', stacks: [{ id: 'Api', lambdas: ['a1', 'a2'] }, { id: 'Web', lambdas: ['w1'] }] },
  { id: 'Prod', stacks: [{ id: 'Api', lambdas: ['p1'] }] },
];

describe('by default', () => {
  test('is the same as publishAssetsInParallel: true', () => {
    expect(render(twoStacks).text).toEqual(render(twoStacks, { publishAssetsInParallel: true }).text);
  });

  test('every asset has a job of its own with a single asset-hash output', () => {
    const { jobs } = render(twoStacks);
    // 3 templates and 4 Lambda assets: every one is its own job
    const publish = publishJobs(jobs);
    expect(publish).toHaveLength(7);
    for (const [id, job] of publish) {
      expect(id).toMatch(/^Assets-FileAsset\d+$/);
      expect(Object.keys(job.outputs)).toEqual(['asset-hash']);
      expect(job.outputs['asset-hash']).toEqual('${{ steps.Publish.outputs.asset-hash }}');
    }
  });

  test('each publish script writes the hash of its asset to asset-hash', () => {
    const { scripts } = render(twoStacks);
    expect(Object.keys(scripts)).toHaveLength(7);
    for (const script of Object.values(scripts)) {
      expect(script.match(/^echo 'asset-hash=[0-9a-f]+' >> \$GITHUB_OUTPUT$/gm)).toHaveLength(1);
    }
  });

  test('every deploy job reads asset-hash from the job that publishes its template', () => {
    const { jobs } = render(twoStacks);
    const deploys = deployJobs(jobs);
    expect(deploys).toHaveLength(3);
    for (const [, job] of deploys) {
      const match = OUTPUT_REFERENCE.exec(templateOf(job));
      expect(match).not.toBeNull();
      expect(match![2]).toEqual('asset-hash');
      expect(jobs[match![1]].outputs).toHaveProperty('asset-hash');
    }
  });
});

describe('with publishAssetsInParallel: false', () => {
  const combined = () => render(twoStacks, { publishAssetsInParallel: false });

  test('file assets are published by one job', () => {
    const { jobs } = combined();
    expect(publishJobs(jobs).map(([id]) => id)).toEqual(['Assets-FileAsset']);
  });

  test('the job has one output for each stack template, named after the stack manifest', () => {
    const { jobs } = combined();
    const outputs = Object.keys(jobs['Assets-FileAsset'].outputs);
    expect(outputs).toHaveLength(3);
    for (const name of outputs) {
      expect(name).toMatch(/^asset-hash-[A-Za-z0-9_-]+$/);
    }
    expect(outputs.some((n) => n.includes('web'))).toBe(true);
    expect(outputs.filter((n) => n.includes('api'))).toHaveLength(2);
  });

  test('each output is the output of the Publish step', () => {
    const { jobs } = combined();
    for (const [name, value] of Object.entries<string>(jobs['Assets-FileAsset'].outputs)) {
      expect(value).toEqual(`\${{ steps.Publish.outputs.${name} }}`);
    }
  });

  test('the publish script writes every output, each with its own hash', () => {
    const { jobs, scripts } = combined();
    expect(Object.keys(scripts)).toEqual(['publish-Assets-FileAsset-step.sh']);
    const script = scripts['publish-Assets-FileAsset-step.sh'];
    const written = [...script.matchAll(/^echo '([^=']+)=([0-9a-f]+)' >> \$GITHUB_OUTPUT$/gm)];
    expect(written.map((m) => m[1]).sort()).toEqual(Object.keys(jobs['Assets-FileAsset'].outputs).sort());
    expect(new Set(written.map((m) => m[2])).size).toEqual(written.length);
  });

  test('every deploy job reads the output of its own stack template', () => {
    const { jobs } = combined();
    const deploys = deployJobs(jobs);
    expect(deploys).toHaveLength(3);
    const referenced = deploys.map(([, job]) => {
      const match = OUTPUT_REFERENCE.exec(templateOf(job));
      expect(match).not.toBeNull();
      expect(match![1]).toEqual('Assets-FileAsset');
      expect(jobs['Assets-FileAsset'].outputs).toHaveProperty(match![2]);
      return match![2];
    });
    expect(new Set(referenced).size).toEqual(3);
  });

  test('deploy jobs depend on the combined job', () => {
    const { jobs } = combined();
    for (const [, job] of deployJobs(jobs)) {
      expect(job.needs).toContain('Assets-FileAsset');
    }
  });

  test('stacks in one stage and stacks in several stages all resolve', () => {
    expect(() => render(
      [
        { id: 'One', stacks: [{ id: 'A', lambdas: ['x'] }, { id: 'B' }, { id: 'C', lambdas: ['y'] }] },
        { id: 'Two', stacks: [{ id: 'A' }] },
        { id: 'Three', stacks: [{ id: 'D', lambdas: ['z'] }] },
      ],
      { publishAssetsInParallel: false },
    )).not.toThrow();
  });

  test('stacks with the same template share one output', () => {
    const { jobs } = render(
      [
        { id: 'Dev', stacks: [{ id: 'Api', lambdas: ['a1'] }] },
        { id: 'Prod', stacks: [{ id: 'Api', lambdas: ['a1'] }] },
      ],
      { publishAssetsInParallel: false },
    );
    expect(Object.keys(jobs['Assets-FileAsset'].outputs)).toHaveLength(1);
    const references = deployJobs(jobs).map(([, job]) => OUTPUT_REFERENCE.exec(templateOf(job))![2]);
    expect(references).toHaveLength(2);
    expect(references[0]).toEqual(references[1]);
  });

  test('docker assets are published by one job without outputs', () => {
    const { jobs } = render(
      [{ id: 'Dev', stacks: [{ id: 'Build1', docker: true }, { id: 'Build2', docker: true, lambdas: ['q'] }] }],
      { publishAssetsInParallel: false },
    );
    const publish = publishJobs(jobs).map(([id]) => id).sort();
    expect(publish).toEqual(['Assets-DockerAsset', 'Assets-FileAsset']);
    expect(jobs['Assets-DockerAsset']).not.toHaveProperty('outputs');
    for (const [, job] of deployJobs(jobs)) {
      expect(OUTPUT_REFERENCE.exec(templateOf(job))![1]).toEqual('Assets-FileAsset');
    }
  });

  test('the workflow does not change when an asset is added', () => {
    const before = render(twoStacks, { publishAssetsInParallel: false });
    const after = render(
      [
        { id: 'Dev', stacks: [{ id: 'Api', lambdas: ['a1', 'a2', 'a3'] }, { id: 'Web', lambdas: ['w1', 'w2'] }] },
        { id: 'Prod', stacks: [{ id: 'Api', lambdas: ['p1', 'p2'] }] },
      ],
      { publishAssetsInParallel: false },
    );
    expect(after.text).toEqual(before.text);
  });

  test('the workflow does change when an asset is added by default', () => {
    const before = render(twoStacks);
    const after = render([{ id: 'Dev', stacks: [{ id: 'Api', lambdas: ['a1', 'a2', 'a3'] }, twoStacks[0].stacks[1]] }, twoStacks[1]]);
    expect(after.text).not.toEqual(before.text);
  });
});

describe('output names', () => {
  const asset = (manifest: string, assetId: string, extra: Record<string, unknown> = {}) => ({
    assetManifestPath: manifest,
    assetId,
    assetSelector: `${assetId}:selector`,
    assetType: AssetType.FILE,
    isTemplate: true,
    ...extra,
  });

  function names(assets: any[]): Array<{ assetId: string; outputName: string }> {
    return withTemporaryDirectory((dir) => {
      const app = new TestApp({ outdir: 'publish-assets-names.out' });
      try {
        const pipeline = new GitHubWorkflow(app, 'Pipeline', {
          workflowPath: `${dir}/.github/workflows/deploy.yml`,
          synth: new ShellStep('Build', { commands: [] }),
        });
        return (pipeline as any).templateHashOutputs(assets);
      } finally {
        app.cleanup();
      }
    });
  }

  test('come from the basename of the stack manifest without .assets.json', () => {
    expect(names([asset('/out/assembly-Dev/DevWebF00.assets.json', 'h1')]))
      .toEqual([{ assetId: 'h1', outputName: 'asset-hash-devwebf00' }]);
  });

  test('are lower case', () => {
    expect(names([asset('/out/DevWeb4E4BD607.assets.json', 'h1')])[0].outputName).toEqual('asset-hash-devweb4e4bd607');
  });

  test('replace characters that are not valid in an output name', () => {
    expect(names([asset('/out/we ird.name!.assets.json', 'h1')])[0].outputName).toEqual('asset-hash-we_ird_name_');
  });

  test('get a numeric suffix when they collide', () => {
    expect(names([
      asset('/out/a/Web.assets.json', 'h1'),
      asset('/out/b/Web.assets.json', 'h2'),
      asset('/out/c/Web.assets.json', 'h3'),
    ]).map((o) => o.outputName)).toEqual(['asset-hash-web', 'asset-hash-web-2', 'asset-hash-web-3']);
  });

  test('a suffixed name that is taken by another stack is not reused', () => {
    expect(names([
      asset('/out/a/Web.assets.json', 'h1'),
      asset('/out/b/Web-2.assets.json', 'h2'),
      asset('/out/c/Web.assets.json', 'h3'),
    ]).map((o) => o.outputName)).toEqual(['asset-hash-web', 'asset-hash-web-2', 'asset-hash-web-3']);
  });

  test('never contain the hash', () => {
    const [output] = names([asset('/out/Stack.assets.json', 'abcdef0123456789')]);
    expect(output.outputName).not.toContain('abcdef');
  });

  test('are only made for templates, once for each hash', () => {
    expect(names([
      asset('/out/Stack.assets.json', 'h1'),
      asset('/out/Stack.assets.json', 'h1', { assetSelector: 'h1:other-destination' }),
      asset('/out/Stack.assets.json', 'code', { isTemplate: false }),
    ])).toEqual([{ assetId: 'h1', outputName: 'asset-hash-stack' }]);
  });
});
