# Settings and commands

Open VS Code Settings and search `@ext:division4studios.malt`, or edit your user/workspace settings JSON.

| Setting | Default | Purpose |
| --- | --- | --- |
| `malt.reviewer.backend` | `auto` | `auto`, `docker`, or `host`; restart reviewer after changing |
| `malt.reviewer.autoStart` | `true` | Start when a workspace opens |
| `malt.reviewer.triageModel` | `sonnet` | Model alias or ID for each block's overview (purpose, technical, design) and for sorting out which rules apply; `haiku` is cheaper but argues design less well; restart reviewer |
| `malt.reviewer.reviewModel` | `sonnet` | Model alias or ID for the per-rule checks (one call per applicable rule); restart reviewer |
| `malt.reviewer.standardsModel` | `opus` | Model alias or ID for standards scans; restart reviewer |
| `malt.reviewer.maxConcurrentReviews` | `2` | Parallel reviewer calls (overviews and rule checks), from 1 to 8 |
| `malt.reviewer.claudePath` | `claude` | Host CLI executable; restart reviewer |
| `malt.docker.socketPath` | empty | Docker socket/pipe override; otherwise `DOCKER_HOST` or platform default; restart reviewer |
| `malt.reviewer.triageModel` / `triageEffort` | `sonnet` / `low` | Block overviews: one call per changed block |
| `malt.reviewer.reviewModel` / `reviewEffort` | `haiku` / `low` | Rule checks: one call per applicable rule per block, most of the usage |
| `malt.reviewer.consolidationModel` / `consolidationEffort` | `sonnet` / `low` | The whole-change consolidation check |
| `malt.reviewer.standardsModel` / `standardsEffort` | `opus` / `medium` | Scan Project Standards (three calls, only when you scan) |
| `malt.reviewer.investigationModel` / `investigationEffort` | `sonnet` / `medium` | Investigate Gap (one call per gap you investigate) |
| `malt.changes.autoOpen` | `true` | Show newly changed files in preview tabs, preserving keyboard focus |
| `malt.changes.autoOpenPauseSeconds` | `60` | While you are working (clicking, typing, scrolling, switching files, or opening something from MALT), auto-open waits until you have been idle this long, so it never pulls you away from what you are investigating. New changes still appear in **Changes** right away |
| `malt.changes.autoReview` | `true` | Queue new blocks automatically |
| `malt.changes.autoConsolidation` | `true` | Run the whole-change consolidation check (one reviewer call) 30 seconds after new files stop appearing |

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
| Scan Project Standards | Read docs, map the source files, infer undocumented conventions and list gaps; saves `.malt/standards.json` and `.malt/architecture.json` |
| Show Project Standards | Open the saved rules as a page grouped by category, with the MALT baseline checks (also the **Standards** row) |
| Show Architecture Map | Open the saved map as a page grouped by folder (also the **Architecture** row) |
| Show Standards Gaps | Reopen the gaps the last scan found as one page. In the Reviewer view, the **Gaps** row lists them; selecting one opens the file at the declaration it names, outlined, with the gap on hover |
| Show Live Reviewer Log | Watch every model call as it happens: what it is for, the prompt sent and the answer streaming in, with elapsed time and a stall indicator. Nothing is saved (also the **Reviewer** row) |
| Check Consolidation Across Changes | One reviewer call over the new declarations in every changed block; findings appear at the top of **Changes** |
| Review All Unreviewed Changes | Queue pending and failed blocks; does not rerun completed reviews |
| Show Reviewer Logs | Open the MALT Reviewer output channel |
| Set Claude Credentials | Store credentials; offers to restart the reviewer |
| Clear Claude Credentials | Remove stored credentials |

**Review Again** is available on a block's hover card or sidebar action. **Reveal Change** is invoked by selecting a block in the sidebar; these contextual actions are not listed in the command palette.

## Theme customization

Use `workbench.colorCustomizations` for `malt.hunkPending`, `malt.hunkPass`, and `malt.hunkFail`. Defaults cover dark, light, and both high-contrast themes. Status icons and text explain the state without requiring color recognition.
