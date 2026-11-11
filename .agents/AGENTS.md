# MALT agent guidance

Commands and code paths below are relative to the repository root.

## Shared instructions and skills

- Edit shared guidance and skills under `.agents/`; root and tool-specific instruction files are pointers. Run `node .agents/setup.mjs` in each checkout to create the Claude/Codex skill links.
- Load a matching `.agents/skills/<name>/SKILL.md` when needed. Read [skill compatibility notes](README.md#compatibility-with-malt) before using imported workflows; their examples do not override MALT's dependency, test, branch or design rules.

## Toolchain and commands

- Use Node.js 24+ (`.nvmrc` pins 24), VS Code 1.144+, and a running Docker **Linux** engine. Install with `npm ci`; `.npmrc` disables lifecycle scripts, including npm pre/post hooks, so required steps must be chained explicitly.
- `npm run compile`, `npm run check-types`, and `npm run watch` run TypeScript 7 in Docker; there is no host fallback. Do not substitute `npx tsc`. The host reviewer still needs Docker for compilation. The first compiler image build needs network access; see [the toolchain guide](../docs/toolchain.md).
- Keep the two compiler aliases distinct: `@typescript/native` supplies TypeScript 7; `typescript` supplies Microsoft's TypeScript 6 compatibility API for ESLint. Do not replace the latter with TypeScript 7 or bypass peer checks with `--force` / `--legacy-peer-deps`.
- F5 launches the Extension Development Host with `npm run watch` as its prelaunch task. `tsconfig.json` emits `src/` to CommonJS in `out/`; `scripts/tsconfig.json` is no-emit, and its `.mts` files run directly through Node's type stripping. `check-types` checks both projects.
- Before pushing, run `npm run verify`: dependency policy → AWS model integrity/drift → types → lint → toolchain tests → compiler sandbox → extension tests. CI additionally runs `npm run audit`, `npx --no-install vsce ls --no-dependencies`, and, on Linux, `xvfb-run -a node scripts/verify-architecture-publication.mjs --browser-check` (requires Chrome).

## Tests

- `npm test` compiles, then runs tests in a downloaded VS Code instance. `npm run test:compiled` skips compilation: use it only with current `out/`. Headless Linux needs `xvfb-run -a npm run test:compiled` after compiling. CI compiles once on Linux and tests that same output on Linux, Windows and macOS.
- Extension tests in `src/test/suite/*.test.ts` export `tests: TestCase[]` from the local `harness.ts` and use `node:assert/strict`. Keep this harness rather than introducing Mocha or `node:test` into the extension host. There is no CLI single-test filter; `src/test/suite/index.ts` discovers every adjacent compiled `*.test.js`.
- Tooling tests use Node's test runner: `npm run test:toolchain`, or one file with `node --test scripts/test/compiler.test.mjs`. A focused case is `node --test --test-name-pattern="compiler launcher" scripts/test/compiler.test.mjs`.
- `npm run test:live` builds the Docker reviewer and makes real Claude calls; it requires `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`. Set `MALT_LIVE_MODEL=haiku` in the environment for a cheaper check. It is separate from `verify`.

## Runtime and packaging boundaries

- This is one npm package with isolated extension, reviewer and AWS-emulator code. `src/extension.ts` wires the VS Code side: Git API → `ChangeTracker` → `HunkStore` / `ReviewQueue` → `ReviewerClient` → reviewer service → editor/sidebar. Reviews have an overview call followed by isolated per-rule checks.
- `src/reviewer/main.ts` starts the same plain-Node service in Docker or as a host daemon. The reviewer image contains only `out/reviewer` and `out/shared`: code in those directories must not import `vscode` or other extension modules. Put reusable pure helpers in `src/shared`; validate wire data with the shared protocol parsers.
- AWS service code under `src/aws` may import only its own modules and `src/shared`; backends do not import other service backends. `src/cloud` integrates through the admin API. Shared code cannot import either service's implementation. Follow `specs/aws/` for approved scope and sourced behavior; regenerate model tables with `npm run generate:aws-models` and check them with `npm run check:aws-models`. Do not edit generated tables directly or infer compatibility from modeled operations.
- Extension Git operations use the built-in Git extension API; Docker operations use the Engine HTTP API. The only `src/` files allowed to import `child_process` are `src/backend/hostBackend.ts` and `src/reviewer/providers/claudeCode.ts`; development/container launchers have separate explicit exceptions in `eslint.config.mjs`.
- Change reviews skip Git-ignored files; standards discovery deliberately reads supported ignored instructions. Both exclude generated `.malt/` content. Preserve these separate policies rather than sharing one ignore filter.
- `npm run vsix` compiles and packages with `--no-dependencies`. `.vscodeignore` is an allowlist: a new shipped top-level `src/` directory needs an explicit `!out/<directory>/**/*.js` entry. Do not broaden it to `!out/**`: VSCE re-includes override later exclusions and would ship tests. `media/` webview scripts and `bin/` publisher scripts are shipped directly.

## Constraints to preserve

- Zero runtime dependencies; dev dependencies are exact-pinned and allowlisted by `scripts/check-deps.mts`. New packages require explicit approval. Preserve the reviewed parent-scoped security overrides in `SECURITY.md` and the low-severity audit gate. Keep `@types/vscode` aligned with `engines.vscode` when updating either.
- ESLint allows zero warnings and ignores inline disable comments. Do not weaken it without an explicit request. Its TypeScript rules require explicit return types/accessibility and ban `any`, type casts, non-null assertions and suppression directives; lint also bans `console` in `src/` and TODO/FIXME comments. Limits include complexity 10, 60 code lines per function and 400 per file.
- Route every model call through `ReviewService.ask` for redaction and agent scheduling. System prompts stay static; repository-controlled text goes through `dataBlock`, and project rules through `sanitizeProjectRules`. Preserve the `no-reviewer-manipulation` baseline rule.
- Reviewer workspace reads go through `readWorkspaceFile` in `src/reviewer/workspace.ts`; extension-side data-derived paths require `realRelativeInside` / `workspaceFile` containment checks. Consult the relevant [MALT feature notes](malt-reference.md) before changing trust, queue, provider or architecture behavior; [the architecture guide](../docs/architecture.md) describes the flow.
- UI changes require [editor acceptance checks](../docs/editor-testing.md). Preserve VS Code themes and `media/maltTheme.css`; use hand-authored SVG/HTML/CSS for artwork, not image generators. See [the design guide](../docs/design.md).
- Branch from `dev` and target PRs at `dev`; all PR commits must be signed. Never disable commit signing or push directly to `dev` / `main`. Only the Release workflow updates `main`. Use `npm run release:bump -- <major|minor|patch>` to coordinate manifest, lockfile and changelog versions; see [releasing](../docs/releasing.md).
