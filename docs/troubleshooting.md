# Troubleshooting

| Symptom | What to check |
| --- | --- |
| No outlined blocks | Save the file. Confirm VS Code Source Control sees it and the built-in Git extension is enabled. Check the first workspace folder is the intended repository. Ignored files, `.malt/`, deleted files, binary new files, new files over 512,000 bytes, symlinks, and files whose real path is outside the workspace folder are skipped. |
| Instructions in an ignored folder are missing | Ignored agent instructions are allowed; confirm a supported format and allowed folder in [standards discovery](standards.md). Linked files and scan limits can exclude sources. |
| A declaration or relationship is missing | Check the selected workspace folder, remove filters, and inspect the skipped file count. Ignored paths, index limits, generated code, aliases and dynamic calls affect coverage. [Supported relationships and limits](architecture-explorer.md) |
| A branch is missing from the comparison picker | The picker lists local branches. Fetch the remote branch and create a local tracking branch with VS Code Source Control before comparing it. |
| An explanation is missing or still says **Working hypothesis** | The structural map updates automatically. Run **Scan Project Standards** for model interpretations, or open a file’s discussion. A source-backed claim needs a matched excerpt. An accepted clarification applies only to the branch and file version where it was recorded. |
| No spans, lifecycle or SQL tables | Select an applicable evidence file or supply an authored model. The waterfall needs measured spans, and the timeline requires timestamps with an explicit offset. [Supported inputs](architecture-views.md) |
| An agent cannot read a clarification | Confirm the workspace is trusted and indexed. Recopy its MCP configuration if the verifier changed. Read the new revision before posting a handoff. To post handoffs at all, enable `malt.architecture.shareAgentHandoffs` in user settings and recopy or reconnect; posting is limited to one handoff every 5 seconds and 30 per session. |
| Publication reports a failed gate | Read the finalization receipt and task terminal. Check the reported layout diagnostics, Node executable and Chrome availability. An artifact can have been delivered before a later check failed. |
| Reviewer won't start | Open **MALT: Show Reviewer Logs**. For host mode, verify the configured Claude CLI is installed and authenticated. For Docker, check the engine and stored credentials. |
| Docker reviewer on Linux fails with `EACCES` reading your files | The reviewer runs as your own user ID on a native, rootful Linux Docker engine, so it can read whatever you can. With rootless Docker or Docker Desktop for Linux it runs as the image's `node` user (UID 1000) and can't read a private (`0700`/`0750`) folder; make the workspace readable to that user or use the host backend (`malt.reviewer.backend: host`). The Reviewer log shows which user the container started as. |
| Docker was expected, but the Reviewer row says local process | `auto` falls back to host when Docker isn't running or no Claude credentials are stored (**MALT: Set Claude Credentials**). Select `malt.reviewer.backend: docker` to require Docker. |
| Files keep appearing in the editor | Turn off `malt.changes.autoOpen`. You can still select blocks in the sidebar. |
| Blocks stay waiting | Start the reviewer and check `malt.changes.autoReview`. Use **Review All Unreviewed Changes** for a pending backlog. |
| Review failed | Open the logs; check authentication, model access and connectivity. Retry with the block's **Review Again** action. A failed request is not a failing code verdict. |
| New standards did not update an old verdict | Rules apply to subsequent requests. Use **Review Again** to replace a cached result. |
| A pull request review won't start | MALT needs a github.com remote and no uncommitted changes. It refuses a pull request that changes anything in a `.malt` folder (it would choose its own review rules) or lists 3,000 or more files. Private repositories need GitHub's `repo` scope, which MALT asks for. |
| Pull request files are skipped | Deleted, binary and too-large files, symlinks, and blocks beyond 400 per review are skipped; the Pull Request view lists them. |
| A pull request review says it stopped | Switching branches or editing files on the pull request checkout stops the review for good, so it never reviews files that aren't the PR's. **Finish** the review, then start it again. |
| `.malt/standards.json` is still in Git | Ignore rules do not untrack committed files. MALT excludes it from review regardless. Decide with your team whether to remove generated files from Git's index. |

## Report a useful bug

Include OS, VS Code and MALT versions, selected backend, exact reproduction steps, expected/actual behavior, and relevant sanitized **MALT Reviewer** logs. For visual problems include the theme, zoom level, and a screenshot with private code removed. Never include credentials, tokens, or private source in public reports. Use [SUPPORT.md](../SUPPORT.md) or the [bug report form](https://github.com/Division4Studios/multi-agent-local-team/issues/new?template=bug_report.yml).

## Current boundaries

MALT reviews saved working-tree changes against HEAD, and GitHub pull requests that it checks out locally. Nothing is posted to GitHub; it is not a hosted pull-request integration. Block review and standards scanning use the first workspace folder. The architecture explorer supports each trusted local workspace folder. Deleted files and unsaved buffer edits do not receive block verdicts. Claude is the current provider. Human review and normal tests remain necessary.
