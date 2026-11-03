# Settings and commands

Open VS Code Settings and search `@ext:division4studios.malt`, or edit your user/workspace settings JSON.

| Setting | Default | Purpose |
| --- | --- | --- |
| `malt.reviewer.backend` | `auto` | `auto`, `docker`, or `host`; restart reviewer after changing |
| `malt.reviewer.autoStart` | `true` | Start when a workspace opens |
| `malt.reviewer.reviewModel` | `sonnet` | Model alias or ID for block reviews; restart reviewer |
| `malt.reviewer.standardsModel` | `opus` | Model alias or ID for standards scans; restart reviewer |
| `malt.reviewer.maxConcurrentReviews` | `2` | Parallel review requests, from 1 to 8 |
| `malt.reviewer.claudePath` | `claude` | Host CLI executable; restart reviewer |
| `malt.docker.socketPath` | empty | Docker socket/pipe override; otherwise `DOCKER_HOST` or platform default; restart reviewer |
| `malt.changes.autoOpen` | `true` | Show newly changed files in preview tabs, preserving keyboard focus |
| `malt.changes.autoReview` | `true` | Queue new blocks automatically |

For a manual workflow:

```json
{
  "malt.reviewer.autoStart": false,
  "malt.changes.autoOpen": false,
  "malt.changes.autoReview": false
}
```

## Command palette

All commands below have the **MALT:** prefix.

| Command | Action |
| --- | --- |
| Start Reviewer | Start/restart the selected backend |
| Stop Reviewer | Stop the managed reviewer |
| Scan Project Standards | Discover rules and save generated output |
| Review All Unreviewed Changes | Queue pending and failed blocks; does not rerun completed reviews |
| Show Reviewer Logs | Open the MALT Reviewer output channel |
| Set Claude Credentials | Store credentials; offers to restart the reviewer |
| Clear Claude Credentials | Remove stored credentials |

**Review Again** is available on a block's hover card or sidebar action. **Reveal Change** is invoked by selecting a block in the sidebar; these contextual actions are not listed in the command palette.

## Theme customization

Use `workbench.colorCustomizations` for `malt.hunkPending`, `malt.hunkPass`, `malt.hunkConcerns`, and `malt.hunkFail`. Defaults cover dark, light, and both high-contrast themes. Status icons and text explain the state without requiring color recognition.
