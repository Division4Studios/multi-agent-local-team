# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

MALT ("Multi-Agent Local Team") is a VS Code extension, MIT-licensed, intended to be open-sourced (the GitHub repo is private for now). Its purpose is to help teams get AI-assisted PRs merged faster and more safely, by reviewing every changed block surgically as it appears instead of reviewing a huge PR at the end. Don't invent features beyond what the user has described.

This repo must model the anti-slop bar it will enforce elsewhere. Keep diffs small, don't add speculative abstractions, and don't leave unused code.

## Commands

```sh
npm ci                 # install (install scripts are disabled by .npmrc)
npm run verify         # check-deps → check-types → lint → test (what CI runs, minus audit)
npm run compile        # tsc → out/
npm run check-types    # extension (tsconfig.json) + scripts (scripts/tsconfig.json)
npm run lint           # ESLint, --max-warnings 0
npm run check-deps     # dependency allowlist / exact-pin / no-overrides guard
npm run audit          # runtime advisories (any) + whole tree (high+) + registry signatures
npm test               # compile, then run tests in a downloaded VS Code (.vscode-test/)
npm run vsix           # package .vsix
```

There is no single-test filter. To run a subset, temporarily narrow the file list in `src/test/suite/index.ts`, or put the cases in their own `*.test.ts` file.

## Hard rules (user-mandated)

- **Dependencies are frozen.** The only allowed devDependencies are `typescript`, `@types/node`, `@types/vscode`, `eslint`, `@eslint/js`, `typescript-eslint`, `@vscode/test-electron` and `@vscode/vsce`. **Zero runtime `dependencies`.** No mocha, esbuild, prettier or anything else. `scripts/check-deps.mts` enforces this. Never add a package without the user's explicit approval.
- **Never use `overrides`/`resolutions`**, not even to fix an audit finding. The accepted minimatch advisory is documented in `SECURITY.md`.
- **Exact version pins only** (`.npmrc` has `save-exact`).
- **Lint: every rule is an error, and `eslint-disable` comments don't work** (`noInlineConfig`). Fix the code; never weaken `eslint.config.mjs` unless the user asks. The config bans `as` assertions, `!`, `any`, `@ts-*` directives, constructor parameter properties (via `erasableSyntaxOnly`), `console` in `src/`, `child_process`/`vm`/`eval`, TODO comments, and imports of `minimatch`/`glob`. It also enforces explicit return types and complexity/size limits.
- **Process execution is allowed in exactly two files:** `src/backend/hostBackend.ts` and `src/reviewer/providers/claudeCode.ts`. That exception is in `eslint.config.mjs`. The extension never runs git or docker itself; it uses the built-in Git extension API and the Docker Engine API over `node:http`.

## Feature architecture

Data flows: **git change → blocks → review queue → reviewer service → decorations/hover/sidebar.**

- **Change tracking** (`src/review/changeTracker.ts`) subscribes to the built-in Git extension's repository state (`src/git/gitApi.ts` types only the subset used), so agent edits on disk are picked up. Each changed file is diffed with `diffWithHEAD` and split by `src/diff/unifiedDiff.ts`: one block per git hunk; untracked files are split at blank lines into blocks of 30–80 lines. A block's id is a hash of path plus body (no line numbers), so cached reviews survive line shifts. Results persist in `workspaceState`.
- **HunkStore → ReviewQueue** (`src/review/`): bounded concurrency, one isolated review per block. Blocks stay `pending` while the reviewer is offline and are queued when it reports healthy. On start-up, more than 25 unreviewed blocks triggers a prompt instead of an automatic review (cost guard).
- **Reviewer service** (`src/reviewer/`) is a plain Node HTTP server, the same code in Docker and on the host. It must not import `vscode` (lint-enforced). Every request needs a bearer token generated per start. Paths are confined to the workspace by `resolveInWorkspace`. Each review is a fresh, tool-less `claude -p` call (`--tools ""`, `--strict-mcp-config`, `--setting-sources ""`, cwd = temp dir, `--json-schema`). The system prompt (`src/reviewer/prompts.ts`) depends only on the rules, so it stays prompt-cached across reviews. `--bare` can't be used because it refuses subscription OAuth logins.
- **Shared protocol** (`src/shared/protocol.ts`): every value crossing the HTTP boundary goes through its parsers, in both directions.
- **Backends** (`src/backend/`): `ReviewerManager` prefers Docker (`DockerBackend`) when the Engine API answers and Claude credentials are in SecretStorage, and otherwise falls back to `HostBackend` (VS Code's runtime via `ELECTRON_RUN_AS_NODE`). The Docker image is built from a tar context (`tar.ts`) of `docker/Dockerfile` plus `out/reviewer` and `out/shared`, tagged with a hash of the context, so code changes rebuild it automatically. The container mounts the workspace read-only, with a read-only root filesystem, `CapDrop ALL`, `no-new-privileges`, and its port bound to 127.0.0.1 only. A health monitor polls `/health` every 10 seconds.
- **Standards scan** (`malt.scanStandards`): the reviewer reads `.claude/`, `.codex/`, `.cursor/`, Markdown docs and lint/format configs (bounded by count and size; see `standardsSources.ts`), and the model distills checkable rules. The extension writes them to `.malt/standards.json`, which is meant to be committed. The reviewer re-reads it whenever its mtime changes. Four baseline rules always apply.
- **UI**: `src/editor/decorations.ts` draws a box from per-line border decorations (top/middle/bottom/single × verdict) plus an inline status label. `reviewMarkdown.ts` builds the hover card, inserts model text only through `appendText`, and allows only the `malt.reviewAgain` command link. The activity-bar container `malt` has two views, `malt.reviewer` (status) and `malt.changes` (files → blocks), and there is a status bar item.

## Architecture and non-obvious setup

- **Sandboxed tooling.** `compile`, `check-types`, `lint` and `check-deps` run under `node --permission --allow-fs-read="*"`: read-only, with no child processes or workers. `compile` additionally gets `--allow-fs-write=./out`, and creates `out/` first because the sandbox can't create it. New tooling scripts should follow the same pattern. `test`, `watch` and `vsix` are not sandboxed because they need to spawn VS Code or npm.
- **No npm pre/post hooks.** `ignore-scripts=true` disables them too, so scripts chain steps explicitly (for example `test` runs `npm run compile && …`).
- **Two TS projects.** `tsconfig.base.json` holds the strict compiler flags. `tsconfig.json` builds `src/` → `out/` as CommonJS, with `verbatimModuleSyntax: false` because VS Code loads CJS and `erasableSyntaxOnly` forbids `import x = require()`. `scripts/tsconfig.json` type-checks `scripts/*.mts` with noEmit. Those scripts are run directly by Node 24's type stripping, so they must use erasable syntax only.
- **Tests.** `src/test/runTest.ts` calls `@vscode/test-electron`, which loads `out/test/suite/index.js` in the extension host. Each `*.test.ts` exports `tests: TestCase[]` (from `src/test/suite/harness.ts`) and uses `node:assert/strict`. `node:test` hangs in the extension host, so don't switch to it. `--disable-extensions` only disables *other* extensions; MALT is loaded through `--extensionDevelopmentPath`.
- **Packaging.** `.vscodeignore` is an allowlist (`**` then re-includes). It re-includes each `out/<folder>/**/*.js` explicitly, because vsce lets a `!` re-include beat a later exclude, so `out/test` can't be carved out of a broad `!out/**`. It also ships `media/` and `docker/Dockerfile`, which the Docker backend needs at runtime. **A new top-level folder under `src/` must be added there**, or it won't ship. `vsce` runs with `--no-dependencies`.
- **Docker image pins.** `docker/Dockerfile` pins `node:24-slim` by digest and `@anthropic-ai/claude-code` to an exact version. Bump both deliberately. They live inside the image, not in `package.json`, so `check-deps` doesn't cover them.
- **CI** (`.github/workflows/`) uses only `actions/*` and `github/*` actions, pinned to full commit SHAs. Keep that pattern when updating. CodeQL and dependency review need GitHub Advanced Security while the repo is private. When the repo goes public, enable private vulnerability reporting: `gh api -X PUT repos/Division4Studios/multi-agent-local-team/private-vulnerability-reporting`.

## Environment

Windows 10 dev machine. The repo path contains spaces, so quote paths. npm scripts run under cmd.exe locally and sh in CI, so keep script syntax portable (`--allow-fs-read=\"*\"` is quoted so sh doesn't glob it).
