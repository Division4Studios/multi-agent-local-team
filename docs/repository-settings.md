# Repository settings

This is the record of how the GitHub repository is configured, and why. The settings themselves live on GitHub; this file is how a reviewer can check them. **Change a setting and this file in the same pull request**, or describe the change in the pull request if it can only be made in the GitHub UI.

Owner: [@Division4Studios](https://github.com/Division4Studios) (a user account, so there are no teams; access is by repository role).

## Branches

| Branch | Role | Merge method |
|---|---|---|
| `dev` | Default branch. Every pull request targets it. | Squash only, so `dev` has one signed commit per pull request and a linear history |
| `main` | Released code. Accepts pull requests from `dev` only. | Merge commit only, so `dev`'s commits reach `main` unchanged and the two branches never diverge |

Rebase merging and auto-merge are off. GitHub suggests updating out-of-date pull request branches, and deletes head branches after merging (never `dev` or `main`, which rulesets protect).

Squash commits take the pull request title and description; merge commits do the same.

## Rulesets

Each protected branch has two rulesets. The **gate** has no bypass at all, not even for admins. The **maintainer approval** ruleset can be bypassed only by the repository admin role, and only by merging a pull request, so the sole maintainer can merge their own reviewed work (GitHub doesn't let authors approve themselves). Nobody can bypass the gate: there are no direct pushes, failing checks or new CodeQL alerts for anyone.

### `dev · gate` (no bypass)

- Restrict deletions, block force pushes, require linear history and require signed commits.
- Require a pull request (squash only) with every review conversation resolved; new pushes dismiss approvals.
- Required status checks, from GitHub Actions only, with the branch up to date with `dev`:
  - `TypeScript 7 (isolated Linux build)`
  - `Verify (ubuntu-latest)`, `Verify (windows-latest)`, `Verify (macos-latest)`
  - `Analyze (javascript-typescript)`, `Analyze (actions)`
  - `dependency-review`
- Code scanning results: CodeQL must report no new alerts of any severity (security alerts: all; other alerts: all).

### `dev · maintainer approval` (admin bypass, pull requests only)

- One approving review, from a code owner (`.github/CODEOWNERS`), given after the most recent push, with stale approvals dismissed and conversations resolved.

### `main · gate` (no bypass)

- The same as `dev · gate`, except the merge method is merge commit only and there is no linear-history rule. The branch doesn't need to be up to date: `main` gains merge commits that `dev` doesn't have, and requiring them would force a push to `dev`.
- One more required check: **`Source branch is dev`**, from `.github/workflows/branch-policy.yml`. It fails unless the pull request comes from this repository's `dev` branch. The workflow uses `pull_request_target`, which GitHub always runs from the default branch (`dev`, protected), so a pull request can't edit the check it is judged by. The workflow has no token permissions and never checks out or runs pull request code.

### `main · maintainer approval` (admin bypass, pull requests only)

- The same as `dev · maintainer approval`, merge commit only.

### `release tags` (admin bypass)

- `v*` tags can only be created by the admin role, and nobody can move or delete them.

### Signed commits

Both gates require **every commit in a pull request** to carry a signature GitHub can verify, not just the commit that lands. GitHub checks each signature against a key on the committer's own account, so each contributor uses their own key; nobody is ever given one. Setup is a few minutes, once: [CONTRIBUTING.md → Signing your commits](../CONTRIBUTING.md#signing-your-commits). Commits made on github.com are signed by GitHub automatically.

Commits from tools that can't sign (for example, cloud coding agents) block the pull request until someone re-signs them locally (`git rebase --exec "git commit --amend --no-edit -S" origin/dev`, then `git push --force-with-lease`).

### Merging your own pull request as the sole maintainer

GitHub never lets authors approve their own pull requests. When every check is green and the conversations are resolved, the admin sees **Merge without waiting for requirements to be met (bypass rules)** in the merge box. Ticking it skips only the *maintainer approval* ruleset; the gate still applies. Every bypass is recorded under Settings → Rules → Insights. Once there's a second maintainer, approve each other's pull requests instead.

### Adding maintainers

Give the person the **Maintain** role (Settings → Collaborators), and add them to `.github/CODEOWNERS` so their approval counts as a code-owner review. Don't add them to a ruleset bypass list.

## Features

| Setting | Value | Why |
|---|---|---|
| Issues | On, blank issues off | Every issue uses a form: bug, wrong review result, feature, baseline rule, dependency or toolchain change, documentation |
| Discussions | On | Questions and early ideas, with Q&A and Ideas forms in `.github/DISCUSSION_TEMPLATE/` |
| Wiki | On, editing restricted to collaborators | Community-facing notes; anyone-can-edit wikis are a defacement and phishing risk |
| Projects | On | [MALT roadmap](https://github.com/users/Division4Studios/projects/12) |
| Forking | Allowed | Contributors work from forks |
| Releases | Immutable | A published release's assets and tag can't be changed afterwards |

## Security

- Private vulnerability reporting: on. Prompt-injection bypasses of the reviewer are reported this way too (`SECURITY.md`).
- Dependabot alerts and security updates: on. Version updates target `dev` weekly (`.github/dependabot.yml`).
- Secret scanning and push protection: on. (Non-provider patterns and validity checks need a paid GitHub Secret Protection plan on a user-owned repository, so they stay off.)
- CodeQL: advanced setup (`.github/workflows/codeql.yml`, `security-and-quality` queries for TypeScript and Actions) on pushes to `dev` and `main`, every pull request, and weekly.
- Dependency review on every pull request, failing on low severity and on licenses outside the allowlist.

## GitHub Actions

| Setting | Value |
|---|---|
| Allowed actions | GitHub-owned only (`actions/*`, `github/*`); no Marketplace or verified-creator actions |
| SHA pinning | Required: every action must be pinned to a full commit SHA |
| Default `GITHUB_TOKEN` permissions | Read-only; workflows request more per job |
| Actions can approve pull requests | No |
| Workflows from fork pull requests | Need maintainer approval for every outside contributor, not just first-timers |

## Labels

Labels are grouped by prefix. Issue forms apply the type label and `triage`, and maintainers add the area during triage.

- **Type:** `bug`, `enhancement`, `documentation`, `review quality`, `security`, `accessibility`, `question`, `breaking change`
- **Area:** `area: block review`, `area: changes view`, `area: pull request`, `area: standards`, `area: consolidation`, `area: reviewer`, `area: prompt safety`, `area: backend`, `area: live log`, `area: settings`, `area: toolchain`, `area: ci`
- **Status:** `triage`, `needs: repro`, `needs: info`, `accepted`, `blocked`, `duplicate`, `invalid`, `wontfix`
- **Other:** `cost` (changes how many model calls MALT makes), `policy: dependency`, `dependencies` (Dependabot), `release` (a `dev` → `main` pull request), `good first issue`, `help wanted`

## Set only in the GitHub UI

These have no API, so check them by hand after changes:

- Wiki: "Restrict editing to collaborators only" is on (Settings → General → Features).
- Discussion categories: GitHub's defaults (Announcements, General, Ideas, Polls, Q&A, Show and tell). The `q-a` and `ideas` forms match their slugs, so renaming those categories breaks the forms.
- Social preview: a 1280×640 copy of `media/banner.png` on the banner's background color (Settings → General). GitHub's limit is 1 MB, and the banner itself is larger.
- Project built-in workflows ([MALT roadmap → Workflows](https://github.com/users/Division4Studios/projects/12/workflows)). Changing the Status options breaks any workflow that sets one, so re-check these after editing the field:

  | Workflow | Sets Status to |
  |---|---|
  | Auto-add to project (`is:issue is:open` in this repository) | — |
  | Item added to project | Triage |
  | Item reopened | Backlog |
  | Pull request linked to issue | In progress |
  | Pull request merged | Done |
  | Item closed | Done |
  | Auto-close issue (Status set to Done) | — |
