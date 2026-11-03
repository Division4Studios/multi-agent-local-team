# Changelog

All notable changes to MALT are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Check Git ignore rules before generating review or auto-open events; remove blocks when files become ignored.
- Exclude generated `.malt/` output from micro-reviews, even when tracked, to prevent standards self-review loops.
- Create `.malt/` before saving standards and add a local `.gitignore` without overwriting existing policy.

### Changed

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
