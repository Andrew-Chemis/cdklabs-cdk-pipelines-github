# Upstream ledger

Where this fork differs from [cdklabs/cdk-pipelines-github](https://github.com/cdklabs/cdk-pipelines-github),
so that it is clear what to upstream and what to drop once upstream ships it.

`main` mirrors upstream and carries no fork-only commit. Each feature lives on
its own `feat/<topic>` branch cut from `main`, and reaches `distribution`
through a pull request that is merged with a merge commit (never squashed or
rebased), because `scripts/fork-checks` finds merged features with
`git log --merges`.

| Feature | Branch | Fork version | Upstream issue | Upstream PR | State |
| --- | --- | --- | --- | --- | --- |
| `useRoleExternalId` on `AwsCredentials.fromOpenIdConnect` and `fromGitHubSecrets` | `feat/use-role-external-id` | unreleased | cdklabs/cdk-pipelines-github#1414 | - | `not-filed` |
| `actionRefs` on `GitHubWorkflowProps` | `feat/action-refs` | unreleased | - | - | `not-filed` |
| `cdkAssetsInstallIgnoreScripts` on `GitHubWorkflowProps` | `feat/cdk-assets-install-ignore-scripts` | unreleased | - | - | `not-filed` |
| `timeoutMinutes` on `JobSettings` | `feat/job-timeout-minutes` | unreleased | - | - | `not-filed` |
| `deployJobNamer` on `GitHubWorkflowProps` | `feat/deploy-job-namer` | unreleased | - | - | `not-filed` |
| `synthStepEnv` and `synthJobPermissions` on `GitHubWorkflowProps` | `feat/synth-step-env` | unreleased | - | - | `not-filed` |
| `workflowPermissions` and `synthUsesAwsCredentials` on `GitHubWorkflowProps` | `feat/workflow-permissions` | unreleased | - | - | `not-filed` |
| `publishAssetsInParallel` on `GitHubWorkflowProps` | `feat/publish-assets-in-parallel` | unreleased | cdklabs/cdk-pipelines-github#220 | - | `not-filed` |
| `GitHubActionRole` `audience` and wildcard rejection | `feat/role-trust-hardening` | unreleased | - | - | `not-filed` |
| `GitHubActionRoleStage` | `feat/github-action-role-stage` | unreleased | - | - | `not-filed` |

## States

- `not-filed`: nobody has opened an upstream PR. Filing an upstream issue or PR
  is public, so it needs the maintainer's go-ahead for that item.
- `fork-only`: decided not to upstream; the fork keeps it.
- `pr-open`: an upstream PR is open; put its number in the Upstream PR column.
- `merged-upstream`: upstream released it. The next sync merge takes upstream's
  version and the row stays as a record.

## Maintaining the ledger

- Add the row in the same pull request as the merge, or earlier. The check in
  `scripts/fork-checks/ledger.test.ts` fails a `distribution` build when a
  merged `feat/*` branch has no row.
- Fill in "Fork version" with the first `ac-v` release that contains the
  feature once it is published.
- A `feat/*` branch diff may touch only `src/`, `test/`, `API.md` and files that
  projen regenerates, so that it reads as a standalone upstream pull request.
  Packaging, this ledger and the README section live on `distribution` only.
