# Changelog

All notable changes to MALT are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Replace vulnerable minimatch toolchain dependencies with 11.0.4 using exact, parent-scoped security overrides; preserve ESLint and VSCE file selection.
- Give repeated identical blocks distinct sidebar identities and navigate to the selected occurrence while retaining content-based review caching.

- Check Git ignore rules before generating review or auto-open events; remove blocks when files become ignored.
- Exclude generated `.malt/` output from micro-reviews, even when tracked, to prevent standards self-review loops.
- Create `.malt/` before saving standards and add a local `.gitignore` without overwriting existing policy.

### Changed

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
