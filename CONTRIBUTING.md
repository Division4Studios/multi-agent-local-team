# Contributing to MALT

Thanks for your interest in MALT! This project exists to raise the quality bar on pull requests, so we hold our own pull requests to that bar. This guide explains how.

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Table of contents

- [Before you start](#before-you-start)
- [Development setup](#development-setup)
- [The quality gate](#the-quality-gate)
- [Pull request guidelines](#pull-request-guidelines)
- [AI-assisted contributions](#ai-assisted-contributions)
- [Dependency policy](#dependency-policy)
- [Commit messages](#commit-messages)
- [Reporting security issues](#reporting-security-issues)

## Before you start

- **Bugs:** search [existing issues](https://github.com/Division4Studios/multi-agent-local-team/issues) first, then open a [bug report](https://github.com/Division4Studios/multi-agent-local-team/issues/new?template=bug_report.yml).
- **Features and larger changes:** open a [feature request](https://github.com/Division4Studios/multi-agent-local-team/issues/new?template=feature_request.yml) and get agreement on the approach **before** writing code. Unsolicited large PRs are likely to be closed.
- **Small fixes** (typos, docs, obvious bugs) can go straight to a PR.

## Development setup

Requirements: **Node.js 24+** (see `.nvmrc`) and **VS Code 1.140+**.

```sh
git clone https://github.com/Division4Studios/multi-agent-local-team.git
cd multi-agent-local-team
npm ci          # installs exactly what package-lock.json says; install scripts are disabled
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host with your changes.

## The quality gate

Before pushing, run:

```sh
npm run verify
```

This runs, in order: the dependency policy check, strict type-checking, lint (zero warnings), and the extension tests inside a real VS Code instance. CI runs the same checks plus `npm run audit`, CodeQL and dependency review. **A PR cannot merge unless all of them pass.**

Rules that are enforced and will not be waived in review:

- No `any`, no type assertions (`as`), no non-null assertions (`!`), no `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck`.
- No `eslint-disable` comments. They are ignored by configuration and will fail the build. If a rule is wrong for a case, propose a change to `eslint.config.mjs` in its own PR with a justification.
- No `console.*` in extension code; use a VS Code `OutputChannel`.
- No `child_process`, `vm`, `eval` or `new Function` without a prior security discussion in an issue.
- No `TODO`/`FIXME` comments; open an issue instead.
- New behavior comes with tests.

## Pull request guidelines

- **Keep PRs small and focused.** One logical change per PR. If your diff is large, split it.
- **Explain the why**, not just the what. Link the issue it resolves.
- **Fill out the PR template completely**, including the AI-assistance disclosure.
- **You must be able to explain every line** you are submitting. Reviewers will ask.
- Don't mix refactors, formatting changes and behavior changes in one PR.
- Keep the branch up to date with `main`; maintainers squash-merge.

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
| `typescript` | Compiler |
| `@types/node`, `@types/vscode` | Type definitions (no runtime code) |
| `eslint`, `@eslint/js`, `typescript-eslint` | Linting |
| `@vscode/test-electron` | Runs tests in a real VS Code instance |
| `@vscode/vsce` | Packages the `.vsix` |

`npm run check-deps` fails if any other package, any runtime dependency, any `overrides`/`resolutions`, or any non-exact version appears. **Proposals to add a dependency need an issue and maintainer approval before any code is written.** Prefer the Node.js standard library and the VS Code API.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add command to summarize the staged diff
fix: handle workspaces without a git repository
docs: clarify dependency policy
chore: bump typescript to 6.0.4
```

Signed commits are strongly encouraged ([GitHub docs](https://docs.github.com/en/authentication/managing-commit-signature-verification/signing-commits)).

## Reporting security issues

Never open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
