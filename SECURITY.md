# Security Policy

## Supported versions

MALT is pre-1.0. Only the latest release (and `main`) receives security fixes.

| Version | Supported |
|---|---|
| latest / `main` | ✅ |
| older | ❌ |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions or pull requests.**

Report privately through either:

- GitHub's [private vulnerability reporting](https://github.com/Division4Studios/multi-agent-local-team/security/advisories/new) (**Security** tab → **Report a vulnerability**), or

Please include:

- A description of the issue and its impact
- Steps to reproduce, or a proof of concept
- Affected versions or commits
- Any suggested fix

What to expect:

- **Acknowledgement** within 3 business days
- **Initial assessment** within 7 days
- Coordinated disclosure: we will agree on a timeline with you, publish a GitHub Security Advisory, and credit you unless you prefer to stay anonymous

## Reviewer isolation

MALT sends changed code to a reviewer service that calls an AI model. It's designed so that the reviewed repository can't use the reviewer to run code:

- **Docker backend (preferred):** the workspace is mounted **read-only**, with a read-only root filesystem, all Linux capabilities dropped, `no-new-privileges`, memory and PID limits, and the API port published on **127.0.0.1 only**. The extension manages Docker through the Engine API (`node:http` over the local socket or named pipe) and never runs the Docker CLI.
- **Host backend (fallback):** the same service runs as a local process bound to 127.0.0.1. The model CLI it calls runs with your user's permissions, which is why Docker is preferred.
- **Per-start bearer token** on every request, compared in constant time.
- **Workspace confinement by real path.** Every file the reviewer reads is opened and then verified:
  - its real path (after following symlinks and junctions) is inside the real workspace root;
  - the opened handle is the same file as that path, so it can't be swapped mid-read;
  - it is a regular file with a single link (no hard links);
  - it was opened non-blocking, so a named pipe can't hang the reviewer.

  A repository therefore can't use links to pull files from elsewhere on the machine into a prompt. Regression tests cover junctions, hard links and the standards scan.
- **Model calls have no tools.** Each call to `claude -p` uses `--tools ""`, `--strict-mcp-config`, `--setting-sources ""` and a temporary working directory, so no tools, MCP servers, hooks, settings or `CLAUDE.md` from the reviewed repository are loaded. Output must match a JSON schema and is validated again by MALT.
- **Prompt-injection boundary.** Everything from the reviewed repository counts as untrusted: project rules in `.malt/standards.json`, patches, file contents and the docs read by the standards scan.
  - The system prompts are static and contain no repository text.
  - Repository content goes in the user message as data, inside blocks marked with a random per-request code, so content can't fake the end of its block.
  - Project rules are sanitized (control and invisible characters removed, whitespace collapsed, lengths and count capped, ids validated, baseline rules can't be shadowed) and sent as JSON.
  - A baseline check, `no-reviewer-manipulation`, fails any code, comment or rule that tries to steer an AI reviewer. It runs on every block, whatever the overview call decided applies, so injected text can't talk the reviewer out of it.
- **MALT doesn't take the model's word for it.** The overview call can only name rules MALT knows. Each rule is checked in its own call; the reviewer looks the rule up itself, takes the id and title from its own list, and sanitizes the model's text. A block passes only when every applicable rule has a passing check; one failing check makes it fail.
  - Residual risk: a model can still be persuaded to mark a rule as passed. MALT's verdicts help the people reviewing a change; they don't replace them.
- **No temporary files with secrets or prompts.** Each model call runs in a fresh private directory that is deleted afterwards (`mkdtemp`, mode 0700).
- **Untrusted output stays inert.** Review text is escaped when rendered in hovers; the only command link enabled is MALT's own "Review again". The rule detail page HTML-escapes every value, has scripts disabled, and its content security policy allows only its own nonce-tagged stylesheet.
- **Credentials** live in VS Code SecretStorage (your OS keychain) and are passed only to the reviewer.
- Process execution is limited by lint policy to exactly two files: the host backend and the Claude Code provider.

## Supply-chain policy

MALT is designed to keep its attack surface as small as possible.

**What ships to users**

- The published extension has **zero runtime dependencies**. The `.vsix` contains only the compiled extension and reviewer, the activity-bar icon, the reviewer `Dockerfile`, `package.json`, the README, the changelog and the license; `.vscodeignore` is an allowlist.
- The reviewer image is built locally from a base image pinned by digest (`node:24-slim@sha256:…`), with the Claude Code CLI pinned to an exact version.

**What runs on developer and CI machines**

- A fixed allowlist of development tools, enforced by `npm run check-deps` in CI: `typescript`, `@types/node`, `@types/vscode`, `eslint`, `@eslint/js`, `typescript-eslint`, `@vscode/test-electron`, `@vscode/vsce`.
- Every version is pinned exactly, `package-lock.json` (with integrity hashes) is committed, and CI installs with `npm ci`.
- `overrides` and `resolutions` are forbidden, so the tree is always exactly what upstream publishes and what the lockfile records.
- Package install scripts are disabled (`ignore-scripts=true` in `.npmrc`).
- Registry signatures and provenance are verified in CI (`npm audit signatures`).
- Type-checking, linting and the dependency check run under the **Node.js permission model** (`node --permission`) with **read-only** filesystem access and **no child processes, workers or native addons**. The compiler may write only to `out/`. A compromised tool in those steps cannot modify the repository or launch other programs.
- GitHub Actions are limited to first-party `actions/*` and `github/*` actions, **pinned to full commit SHAs**, with least-privilege `permissions`.
- Dependabot proposes updates; every update goes through the same CI gate and human review.

**Audit gate**

`npm run audit` (run in CI) fails on:

- **any** advisory in runtime dependencies (there are none), and
- any **high** or **critical** advisory anywhere in the tree.

**Known, accepted advisories**

| Advisory | Package | Reached via | Why accepted |
|---|---|---|---|
| [minimatch ReDoS (< 11.0.1)](https://github.com/advisories?query=minimatch) | `minimatch@10.x` | `eslint`, `typescript-eslint`, `@vscode/vsce` | Moderate severity, development-only, never shipped. It only parses glob patterns from this repository's own config. No upstream release has a fix yet, and `overrides` are forbidden by policy. Lint runs sandboxed (read-only, no process spawning). Extension code is lint-blocked from importing `minimatch` or `glob`. Re-evaluated on every Dependabot update. |
