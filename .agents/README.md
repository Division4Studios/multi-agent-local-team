# Shared agent environment

`.agents/` owns MALT's shared instructions, skills and supporting resources.

| Path | Purpose |
| --- | --- |
| [AGENTS.md](AGENTS.md) | Compact, repository-specific instructions for every agent. |
| [malt-reference.md](malt-reference.md) | Detailed feature invariants moved from the original root `CLAUDE.md`. |
| `skills/<name>/` | A skill's `SKILL.md` and its scripts, references, assets and notices. |
| [setup.mjs](setup.mjs) | Creates Claude/Codex skill-directory links to the shared source. |
| `licenses/` | Notices supplied with the imported skills. |

## Set up a checkout

Run from the repository root after cloning or creating a worktree:

```sh
node .agents/setup.mjs
```

The script links `.claude/skills` and `.codex/skills` to `.agents/skills`. It uses Windows directory junctions (no administrator privileges required) or relative directory symlinks elsewhere. These generated links are Git-ignored; the canonical files and instruction pointers belong in version control. New skills appear through both links immediately.

Setup is repeatable and refuses to overwrite a real directory or a link to a different target. Consolidate any such directory manually first. Windows junctions use absolute targets; if the checkout moves, remove only the old junctions and rerun setup. npm does not run this automatically because this repository disables lifecycle scripts.

| Tool | Instruction entry point | Skill discovery |
| --- | --- | --- |
| Claude Code | Root `CLAUDE.md` and `.claude/CLAUDE.md` import the canonical `AGENTS.md` with `@path`. | `.claude/skills` directory link. |
| Codex | Root `AGENTS.md` directs it to the canonical file; `.codex/AGENTS.md` is also a pointer. | Native `.agents/skills`; `.codex/skills` is a compatibility link. |
| OpenCode | Root `AGENTS.md` directs it to the canonical file. | Native `.agents/skills`; no extra config or copy is required. |

Edit through `.agents/`, including when a tool exposes a linked path. Keep future shared resources here and put only the required import, link or tool-specific adapter in `.claude/` or `.codex/`.

## Retained skills and their uses

| Work | Skills |
| --- | --- |
| Implementation and debugging | `karpathy-guidelines`, `systematic-debugging`, `verification-before-completion` |
| Plans and parallel work | `executing-plans`, `subagent-driven-development`, `dispatching-parallel-agents`, `using-git-worktrees` |
| Review and handoff | `requesting-code-review`, `receiving-code-review`, `review-loop`, `finishing-a-development-branch` |
| Webviews, diagrams and editor-facing UI | `accessibility`, `break-ui`, `frontend-design`, `make-interfaces-feel-better`, `design-motion-principles`, `ux-writing` |
| Documentation and product work | `copywriting`, `unslop`, `user-research`, `scoping-cutting`, `claude-md-improver` |
| Optional website, illustration and coaching work | `hallmark`, `teardown`, `vibe-coding` |

The optional skills remain available for matching requests. Hallmark's website workflow is not the default for native extension UI; Teardown is for explanatory illustrations rather than MALT's source-derived architecture maps.

## Compatibility with MALT

- The imported skills are reusable workflows, not MALT policy. Follow [AGENTS.md](AGENTS.md) for setup, dependencies, tests, signed commits and the `dev` PR target instead of generic `npm install`, `main` or local-merge examples.
- UI examples may use React, Tailwind or animation packages. MALT uses native VS Code APIs and plain JavaScript/CSS webviews; apply the principles within that stack and preserve [the design system](../docs/design.md). Skills do not authorize package additions or generated project artwork.
- `superpowers:<name>` references refer to the corresponding local skill when present. `writing-plans`, `test-driven-development` and `using-superpowers` are not bundled. Some plan workflows require them; resolve a missing prerequisite explicitly rather than pretending it loaded.
- `executing-plans` and `subagent-driven-development` include Bash helpers with Unix-tool assumptions. On Windows they need a suitable Bash environment, such as Git Bash; they are not PowerShell scripts. Keep their sibling directories together because the inline helpers call the subagent workflow's helpers.
- Other unbundled companion names appear in upstream text: `web-quality-audit`, `emil-design-eng`, `review-animations`, `prototype`, and the `better-*` skills referenced by Teardown. Installed alternatives include `accessibility`, `make-interfaces-feel-better`, `design-motion-principles`, `frontend-design` and `ux-writing`; check their scope before substituting.
- `claude-md-improver` should improve the canonical files here and preserve the root/tool-specific import pointers. Tools named in skill examples must be mapped to tools actually available in the current session.
- Imported skill examples and helper code are excluded from MALT's ESLint pass; `.agents/setup.mjs` remains linted. Discovery and link checks do not establish that every bundled helper has been runtime-tested.

## Maintaining the collection

Install or update a skill in `.agents/skills/<name>/`, keeping its resources beside `SKILL.md`. Preserve supplied license notices, including the [Frontend Design license](skills/frontend-design/LICENSE.txt), [Emil Kowalski notice](licenses/emilkowalski-skills-LICENSE.txt) and [Superpowers notice](licenses/obra-superpowers-LICENSE.txt).

This collection was imported from another project without a `skills-lock.json`. Its old installation history is not a verified MALT dependency lock; record actual upstream revisions when updating skills rather than inventing them.
