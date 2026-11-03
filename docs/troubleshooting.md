# Troubleshooting

| Symptom | What to check |
| --- | --- |
| No outlined blocks | Save the file. Confirm VS Code Source Control sees it and the built-in Git extension is enabled. Check the first workspace folder is the intended repository. Ignored files, `.malt/`, deleted files, binary new files, and new files over 512,000 bytes are skipped. |
| Instructions in an ignored folder are missing | Ignored agent instructions are allowed; confirm a supported format and allowed folder in [standards discovery](standards.md). Linked files and scan limits can exclude sources. |
| Reviewer won't start | Open **MALT: Show Reviewer Logs**. For host mode, verify the configured Claude CLI is installed and authenticated. For Docker, check the engine and stored credentials. |
| Docker was expected, but sidebar says Host daemon | `auto` can fall back to host. Select `malt.reviewer.backend: docker` to require Docker. |
| Files keep appearing in the editor | Turn off `malt.changes.autoOpen`. You can still select blocks in the sidebar. |
| Blocks stay waiting | Start the reviewer and check `malt.changes.autoReview`. Use **Review All Unreviewed Changes** for a pending backlog. |
| Review failed | Open the logs; check authentication, model access and connectivity. Retry with the block's **Review Again** action. A failed request is not a failing code verdict. |
| New standards did not update an old verdict | Rules apply to subsequent requests. Use **Review Again** to replace a cached result. |
| `.malt/standards.json` is still in Git | Ignore rules do not untrack committed files. MALT excludes it from review regardless. Decide with your team whether to remove generated files from Git's index. |

## Report a useful bug

Include OS, VS Code and MALT versions, selected backend, exact reproduction steps, expected/actual behavior, and relevant sanitized **MALT Reviewer** logs. For visual problems include the theme, zoom level, and a screenshot with private code removed. Never include credentials, tokens, or private source in public reports. Use [SUPPORT.md](../SUPPORT.md) or the [bug report form](https://github.com/Division4Studios/multi-agent-local-team/issues/new?template=bug_report.yml).

## Current boundaries

MALT reviews saved working-tree changes against HEAD; it is not a hosted pull-request integration. It currently uses the first workspace folder, does not review deleted files, and does not render verdicts for unsaved buffer edits. Claude is the current provider. Human review and normal tests remain necessary.
