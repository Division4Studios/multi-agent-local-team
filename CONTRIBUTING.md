# Contributing to MALT

Thanks for your interest in MALT! This project exists to raise the quality bar on pull requests, so we hold our own pull requests to that bar. This guide explains how.

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Table of contents

- [Before you start](#before-you-start)
- [Development setup](#development-setup)
- [The quality gate](#the-quality-gate)
- [Branches and merging](#branches-and-merging)
- [Pull request guidelines](#pull-request-guidelines)
- [AI-assisted contributions](#ai-assisted-contributions)
- [Dependency policy](#dependency-policy)
- [Commit messages](#commit-messages)
- [Reporting security issues](#reporting-security-issues)

## Before you start

- **Questions:** ask in [Discussions → Q&A](https://github.com/Division4Studios/multi-agent-local-team/discussions/categories/q-a), not in issues.
- **Bugs:** search [existing issues](https://github.com/Division4Studios/multi-agent-local-team/issues) first, then open a [bug report](https://github.com/Division4Studios/multi-agent-local-team/issues/new?template=bug_report.yml).
- **A wrong verdict** (MALT flagged good code, or missed a real problem): open a [wrong review result](https://github.com/Division4Studios/multi-agent-local-team/issues/new?template=review_quality.yml) report with a small snippet that reproduces it.
- **Features and larger changes:** open a [feature request](https://github.com/Division4Studios/multi-agent-local-team/issues/new?template=feature_request.yml) and get agreement on the approach **before** writing code. Unsolicited large PRs are likely to be closed.
- **New dependencies or toolchain changes:** open a [dependency request](https://github.com/Division4Studios/multi-agent-local-team/issues/new?template=dependency_request.yml) and wait for approval. See [Dependency policy](#dependency-policy).
- **Small fixes** (typos, docs, obvious bugs) can go straight to a PR.

## Development setup

Requirements: **Node.js 24+** (see `.nvmrc`), **VS Code 1.144+**, and a running **Docker Linux engine** for isolated TypeScript 7 compilation. See the [toolchain guide](docs/toolchain.md).

```sh
git clone https://github.com/Division4Studios/multi-agent-local-team.git
cd multi-agent-local-team
npm ci          # installs exactly what package-lock.json says; install scripts are disabled
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host with your changes.

Read the [architecture guide](docs/architecture.md) before changing the review pipeline. For changes to editor decorations, hover cards, icons, or navigation, complete the [editor acceptance checks](docs/editor-testing.md) and record the tested themes and focus behavior in your PR. See the [design guide](docs/design.md) for asset conventions.

## The quality gate

Before pushing, run:

```sh
npm run verify
```

This runs, in order: the dependency policy check, strict type-checking, lint (zero warnings), dependency policy and file-selection regression tests, and the extension tests inside a real VS Code instance. CI runs the same checks plus `npm run audit`, CodeQL and dependency review. **A PR cannot merge unless all of them pass.**

Rules that are enforced and will not be waived in review:

- No `any`, no type assertions (`as`), no non-null assertions (`!`), no `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck`.
- No `eslint-disable` comments. They are ignored by configuration and will fail the build. If a rule is wrong for a case, propose a change to `eslint.config.mjs` in its own PR with a justification.
- No `console.*` in extension code; use a VS Code `OutputChannel`.
- No `child_process`, `vm`, `eval` or `new Function` without a prior security discussion in an issue.
- No `TODO`/`FIXME` comments; open an issue instead.
- New behavior comes with tests.

## Branches and merging

| Branch | Role | Accepts |
|---|---|---|
| `dev` | Default branch. All work lands here first. | Pull requests from any branch or fork, squash-merged |
| `main` | What has been released. | Pull requests from `dev` only, opened by a maintainer, merged with a merge commit |

- **Branch from `dev` and open your pull request against `dev`.** A pull request into `main` from any other branch fails the *Source branch is dev* check and can't merge.
- Both branches are protected by repository rulesets. Nobody can push to them directly, force-push or delete them. Every change needs a pull request with an approving code-owner review, all review conversations resolved, and every CI check passing: the build, tests on Linux, macOS and Windows, CodeQL with no new alerts, and dependency review. New commits dismiss earlier approvals.
- Commits that land on `dev` and `main` must be signed. GitHub signs the squash and merge commits it makes, so your own commits don't need to be signed, though it's encouraged.
- Release tags (`v*`) can only be created by maintainers, and can't be moved or deleted.

[docs/repository-settings.md](docs/repository-settings.md) lists every repository setting and the reason for it.

## Pull request guidelines

- **Keep PRs small and focused.** One logical change per PR. If your diff is large, split it.
- **Explain the why**, not just the what. Link the issue it resolves.
- **Fill out the PR template completely**, including the AI-assistance disclosure.
- **You must be able to explain every line** you are submitting. Reviewers will ask.
- Don't mix refactors, formatting changes and behavior changes in one PR.
- Keep your branch up to date with `dev`; maintainers squash-merge it into `dev`.

## AI-assisted contributions

AI tools are welcome here. MALT is built for teams that use them. But **you are the author** of everything you submit, whatever tool produced the first draft.

1. **Disclose it.** Tick the AI-assistance box in the PR template and say which parts were AI-assisted.
2. **Own it.** You have read, understood and tested every line. "The AI wrote it" is never an answer to a review question.
3. **Trim it.** Remove speculative abstractions, unused code paths, redundant comments and boilerplate that AI tools tend to add.
4. **Verify it.** Don't trust generated claims about APIs, versions or behavior; check them. Hallucinated APIs and invented dependencies will get a PR closed.
5. **No AI-generated issues or review comments without human curation.**

PRs that look like unreviewed AI output (large, unfocused, unexplained, or failing the checks above) will be closed without detailed review.

## Dependency policy

MALT ships with **zero runtime dependencies**, and the development toolchain is a fixed allowlist:

| Package | Purpose |
|---|---|
| `@typescript/native` | Exact npm alias for the TypeScript 7 compiler |
| `typescript` | Exact npm alias for Microsoft's TypeScript 6 compatibility API used by ESLint |
| `@types/node`, `@types/vscode` | Type definitions (no runtime code) |
| `eslint`, `@eslint/js`, `typescript-eslint` | Linting |
| `@vscode/test-electron` | Runs tests in a real VS Code instance |
| `@vscode/vsce` | Packages the `.vsix` |

`npm run check-deps` fails if any other package, any runtime dependency, unreviewed override, `resolutions`, or non-exact direct dependency version appears. The only override exceptions are the exact parent/version pairs documented in [SECURITY.md](SECURITY.md#temporary-minimatch-security-overrides-2026-11-03); the guard also rejects vulnerable minimatch versions anywhere in the lockfile. **Proposals to add a dependency need an issue and maintainer approval before any code is written.** Prefer the Node.js standard library and the VS Code API.

`npm run audit` rejects low and higher severity advisories, including development dependencies, and verifies registry signatures. Keep Dependabot updates enabled. A parent update requires reviewing and removing or explicitly revising its version-scoped security exception; never replace it with a blanket override. Run `npm run test:toolchain` to verify the dependency guard and ESLint/VSCE file selection after dependency changes.

### VS Code API compatibility

Keep `@types/vscode` and the minimum `engines.vscode` version aligned. MALT currently targets the VS Code 1.144 API. Newer definitions could allow APIs that do not exist in the oldest supported editor; `vsce` rejects that mismatch.

Keep Dependabot updates enabled for `@types/vscode`. When a PR raises the API version, include the matching `engines.vscode` change, exact dependency pin, lockfile and documented VS Code requirements in the same update. These PRs are the prompt to advance the supported editor version and verify compatibility.

Run `npm run verify` and `npx --no-install vsce ls --no-dependencies` before merging. CI runs the same packaging check; resolve a version mismatch by completing the coordinated update.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add command to summarize the staged diff
fix: handle workspaces without a git repository
docs: clarify dependency policy
chore: update the TypeScript compiler alias
```

Your pull request title becomes the squash commit message on `dev`, so write it in the same form. Signed commits are encouraged ([GitHub docs](https://docs.github.com/en/authentication/managing-commit-signature-verification/signing-commits)).

## Reporting security issues

Never open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
