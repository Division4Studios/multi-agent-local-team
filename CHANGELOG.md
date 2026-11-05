# Changelog

All notable changes to MALT are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-11-05

### Added

- **Releases.** Versions follow MAJOR.MINOR.PATCH. Pushing a signed `vX.Y.Z` tag on `main` runs the full CI matrix, rebuilds the extension, checks that the build matches the tested output, and drafts a GitHub release with the `.vsix`, its SHA-256 checksum and a signed build provenance attestation (`gh attestation verify`). The release notes come from this changelog. [Releasing](docs/releasing.md)

- **Before Commit: Explain and Inspect Changes** (Changes view title bar): a page that reviews all saved local changes before you commit. It shows a file map, changed import connections, recorded failures and consolidation candidates, with links to the verified source. You can ask questions on demand. Test results you record are kept separate from AI review as developer-reported. Opening the page makes no model call. [Before commit](docs/before-commit-review.md)
- Architecture, consolidation, reuse, abstraction, boundary and dead-code checks receive complete relevant implementations from a repository-wide inventory, and a check may request up to two rounds of additional evidence. A check whose evidence is still missing is left incomplete rather than passed. [Standards](docs/standards.md)
- Architecture views explain what you are looking at, answer questions for a product or developer audience, and play back flows step by step. The standards scan shows its progress by stage.

- Ten interactive architecture views, cross-view navigation in the sidebar and editor, repository-specific agent classifications, standalone MALT HTML publications with delivery receipts and a signed guidance feed for connected local agents. [Walkthrough](docs/architecture-views.md)

- Interactive architecture maps with tagged source relationships, path tracing and visual branch comparisons. The reviewer separates source evidence from hypotheses and can discuss a question with a developer before saving a clarification for that branch and file version. [Architecture explorer walkthrough](docs/architecture-explorer.md)

### Changed

- New look: the barley sprig from the activity bar becomes the full-color mark (amber grains, teal stem) for the extension icon. The README, wiki and docs have a new hero image and diagrams of how a change is reviewed and of the trust boundary, all hand-built from reviewable SVG and HTML sources in `design/`.

### Fixed

- Rule checks after a standards rescan: a saved review that names a renamed or removed rule is reviewed again with the current rules, instead of failing on every retry with "Unknown rule".
- Rule checks and consolidation are no longer rejected by the API ("input_schema.type: Field required").
- A code example in a changed Markdown file no longer stops consolidation of the source files beside it.
- Questions about changes and architecture views keep MALT's rules (context is unverified, never claim tests ran) in the static system prompt, and a recorded test result is passed as the developer's own words.

- A failed reviewer request redacts secrets in the error it returns and logs (a Claude CLI error could quote a key), and a thrown value that isn't an `Error` is reported only as "Internal reviewer error", never echoed. Fixes CodeQL `js/stack-trace-exposure`.

- `malt.reviewer.claudePath` and `malt.docker.socketPath` are machine-scoped: a repository's `.vscode/settings.json` can no longer choose the program MALT runs or the Docker endpoint it talks to. In untrusted workspaces they are restricted too.

- Changed files are only read when they really live in the workspace: symlinks (and files reached through linked folders) are skipped, so a link in the repository can never pull an outside file into a review or the editor.
- Opening a gap or finding resolves its real path and refuses anything outside the workspace.
- The live log page only accepts messages from the extension host (same origin).

- The live reviewer log redacts recognizable secrets (API keys, tokens, private keys, credentials in URLs and literals) in prompts, streamed text and errors, including secrets split across streamed chunks.
- Stream readers decode UTF-8 across chunk boundaries (Claude output, the live stream, Docker build logs and host logs); a final line without a newline is no longer lost.
- The live log disconnects when the reviewer stops and reattaches to a restarted one; reviewer shutdown closes open streams, and a host reviewer that does not exit is force-stopped.
- The live log page releases evicted calls, so long sessions stay bounded.

- Auto-open no longer pulls you away while you investigate: it waits until you have been idle for `malt.changes.autoOpenPauseSeconds` (default 60) after clicking, typing, scrolling, switching files or opening anything from MALT.
- The Reviewer view's Queue row counts only work in progress; finished blocks drop off.
- Selecting Standards or Architecture opens the saved results instead of starting a new scan; rescanning is the view's title-bar action.
- One-line blocks read "Line 21" instead of "Lines 21–21".

- Replace vulnerable minimatch toolchain dependencies with 11.0.4 using exact, parent-scoped security overrides; preserve ESLint and VSCE file selection.
- Give repeated identical blocks distinct sidebar identities and navigate to the selected occurrence while retaining content-based review caching.

- Check Git ignore rules before generating review or auto-open events; remove blocks when files become ignored.
- Exclude generated `.malt/` output from micro-reviews, even when tracked, to prevent standards self-review loops.
- Create `.malt/` before saving standards and add a local `.gitignore` without overwriting existing policy.

### Changed

- Compile with TypeScript 7.0.2 in an isolated Docker Linux container; retain Microsoft's TypeScript 6 compatibility API for strict ESLint rules and test the compiled output across all CI editor platforms.
- Reject low and higher dependency advisories, including development tools; verify security exception policy and ESLint/VSCE file selection on all CI platforms.
- Review each applicable rule in its own isolated call. One overview call per block writes the business purpose, a technical description and a skeptical design assessment (should a new abstraction exist, or extend existing code?) and sorts out which rules apply; the new `malt.reviewer.triageModel` setting picks its model.
- Expand a block in **Changes** to see its rules in collapsible groups, sorted running → failed → passed → not run → not applicable; selecting a checked rule opens a full-page explanation.
- Standards scans sort rules into 3 to 8 groups. New baseline rules `justified-abstraction` and a stricter `reuse-existing` push back on new components that should extend existing code.
- **Scan Project Standards** also maps the source files (purpose and exports) into `.malt/architecture.json`. Block overviews and Architecture-group rule checks get a related slice of it, so design arguments can name the existing code to extend. The **Reviewer** view shows when the map was made.
- The scan now compares docs with code. Conventions the code clearly follows but no doc states are added as rules marked *Inferred from code*; missing or contradictory standards are recorded as gaps, shown by **Show Standards Gaps** and a **Gaps** row in the Reviewer view. Architecture docs and decision records are read first.
- New **Check Consolidation Across Changes**: one call compares new declarations across the whole change and against the map. Findings appear at the top of **Changes**; `malt.changes.autoConsolidation` runs it 30 seconds after new files stop appearing.
- Drop the amber "Needs attention" verdict: a block fails as soon as one rule fails and passes once every applicable rule passes. Retrying a failed block reruns only its missing rule checks. Reviewer protocol version 2.

- Raise the minimum VS Code version and API definitions together to 1.144; retain Dependabot API updates.

- Standards discovery continues to read ignored instructions and now includes `.agents/`.
- Consistent native status icons, concise inline verdicts, clearer hover hierarchy, and stable sidebar identities.
- New barley-inspired identity, extension PNG icon, repository banner, and extension listing metadata.
- Added setup, settings, standards/exclusion, troubleshooting, architecture, design, and editor testing guides.


### Added

- **Review Pull Request**: pick an open pull request on the workspace's GitHub repository and review it with the same outlines, hover cards, per-rule checks and consolidation as local changes, in a new **Pull Request** view. MALT checks the PR out with VS Code's Git (refusing while you have uncommitted changes, and verifying HEAD is GitHub's exact head commit), turns GitHub's diff into blocks, and says what reviewing them will cost before anything runs. **Finish Pull Request Review** returns you to your branch (refusing, and keeping your work, if you changed files on the checkout). Results stay in VS Code and are discarded when you finish; nothing is posted to GitHub. Sign-in uses VS Code's built-in GitHub account.

- **Investigate gap**: a deeper, on-demand review of one standards gap. The scan finds gaps from a one-line-per-file map, which cannot tell duplicated code from code that imports or implements a shared contract. The investigation reads the real code (the gap's files, their local imports, and other files exporting the same names) and returns a plain-English verdict: *Confirmed*, *Partly* or *Not a gap*, with confidence, what the code actually does, quoted evidence (checked word for word against the files; anything not found is discarded), the case against it being a gap, why it matters and what to do. Results show on the gap in the tray, on a report page, and as evidence entries that open the quoted code. **Investigate all** says what it will cost first. New review type **Gap investigation** (default Sonnet, medium effort) in **Models & effort**.
- Gap descriptions from the scan are written for someone who has not seen the code, and say when names alone cannot tell duplication from a shared definition.

- **Models & effort** in the Reviewer view: pick the model and reasoning effort for each review type (block overview, rule checks, consolidation, standards scan). New settings `malt.reviewer.{triage,review,consolidation,standards}Effort` and `malt.reviewer.consolidationModel`; changes offer a reviewer restart.
- Lower-usage defaults: rule checks (most calls) on Haiku, overview and consolidation on Sonnet, all at low effort; the standards scan on Opus at medium effort.
- The live reviewer log shows each call's model and effort, and its tokens and cost, with a running session total.

- **Live reviewer log**: every model call streams as it happens (purpose, prompt sent, answer as it is written, elapsed time, stall indicator). Nothing is saved; the reviewer keeps a short in-memory backlog. Open it from the **Reviewer** row or the view title.
- **Standards** page grouped by category, and the **Standards** row expands into categories → rules. **Architecture** page grouped by folder.
- **Gaps** row lists each gap; selecting one opens the file at the declaration it names, outlined, with the gap on hover. Consolidation findings link to their declarations the same way. Findings now carry `anchors` (file + declaration name), resolved by MALT in the real file.
- The **Reviewer** row combines health and where it runs (Docker container or local process).

- MALT activity-bar sidebar with **Reviewer** (health, backend, standards, queue) and **Changes** (files → changed blocks) views, plus a status bar summary.
- Change tracking through VS Code's built-in Git API: every changed block is outlined in the editor and colored by review verdict, and files are brought into view as changes land.
- Per-block reviews with hover cards showing what, why, whether it's needed, and a ✅/❌ per check.
- Reviewer service with Docker (hardened container, managed through the Docker Engine API) and host-daemon backends; Claude Code as the first provider.
- **Scan Project Standards**: distills `.claude`/`.codex` skills, docs and lint configs into `.malt/standards.json`.
- Claude credentials stored in VS Code SecretStorage.
- VS Code extension scaffold.
- Strictest TypeScript and ESLint configuration (all rules are errors, no inline disables).
- Sandboxed tooling via the Node.js permission model.
- Dependency allowlist enforcement (`npm run check-deps`).
- Zero-dependency test harness running in a real VS Code instance.
- Open-source project files: license, code of conduct, contributing guide, security policy, issue and PR templates, CI, CodeQL and Dependabot.
