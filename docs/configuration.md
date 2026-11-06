# Settings and commands

Open VS Code Settings and search `@ext:division4studios.malt`, or edit your user/workspace settings JSON.

| Setting | Default | Purpose |
| --- | --- | --- |
| `malt.reviewer.backend` | `auto` | `auto`, `docker`, or `host`; restart reviewer after changing |
| `malt.reviewer.autoStart` | `true` | Start when a workspace opens |
| `malt.reviewer.maxConcurrentReviews` | `2` | Initial agents across all call types; positive integer with no fixed maximum. User-only; restart to apply |
| `malt.reviewer.claudePath` | `claude` | Host CLI executable; restart reviewer. User (machine) settings only: workspace settings are ignored, so a repository cannot choose what MALT runs |
| `malt.docker.socketPath` | empty | Docker socket/pipe override; otherwise `DOCKER_HOST` or platform default; restart reviewer. User (machine) settings only |
| `malt.reviewer.<type>Provider` | `claude` | Who answers each review type: `claude` or `copilot` (see **Review providers** below). `<type>` is `triage`, `review`, `consolidation`, `standards` or `investigation`. User (machine) settings only, so a repository can never choose which service receives its code |
| `malt.reviewer.<type>CopilotModel` | `auto` | The GitHub Copilot model for that type when its provider is `copilot`: a model id from **Detect Review Providers**, or `auto` for the first model Copilot offers. Separate from the Claude model and user-only like the provider, so switching provider never pairs one provider with the other's model |
| `malt.reviewer.triageModel` / `triageEffort` | `sonnet` / `low` | Block overviews: one call per changed block |
| `malt.reviewer.reviewModel` / `reviewEffort` | `haiku` / `low` | Rule checks: one call per applicable rule per block, most of the usage |
| `malt.reviewer.consolidationModel` / `consolidationEffort` | `sonnet` / `low` | The whole-change consolidation check |
| `malt.reviewer.standardsModel` / `standardsEffort` | `opus` / `medium` | Scan Project Standards (three calls, only when you scan) |
| `malt.reviewer.investigationModel` / `investigationEffort` | `sonnet` / `medium` | Investigate Gap (one call per gap you investigate), and questions about architecture views and changes |
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

## Review providers

Each review type can be answered by a different provider. Choose them under **Models & effort** in the MALT Reviewer view: select a review type, then a provider, a model and (for Claude and Codex) an effort. The search icon on that row, or **MALT: Detect Review Providers**, shows what this machine can use:

- **Claude** (the default): available when Claude credentials are stored for the Docker reviewer or the Claude Code CLI is on PATH. Calls run in the reviewer with no tools and a schema-enforced answer.
- **GitHub Copilot**: available when you are signed in to GitHub Copilot in VS Code. VS Code asks once whether MALT may use it. Copilot calls run in the extension through VS Code's Language Model API, and the reviewer still builds every prompt and checks every answer. They count against your Copilot plan's limits.
- **Codex**: available when Docker is running and an OpenAI API key is saved with **MALT: Set Codex Credentials** (billed per token by OpenAI). Each call runs in its own throwaway container from a pinned image (the Codex CLI at an exact version). The container has no workspace or other mount, a read-only root filesystem, no capabilities and memory and process limits, and Codex's tools (shell, images, apps, agents, web search) are switched off. The container receives only MALT's static instructions, the redacted prompt and the answer schema, and is removed after the call. The first Codex call builds the image, which takes a few minutes. Choose `auto` for Codex's default model, or type an OpenAI model id. The key goes only to these containers, never to the reviewer. Signing in with a ChatGPT account isn't supported yet.

Copilot's separation between instructions and data is weaker than Claude's. VS Code's API has no system role, so MALT's static instructions arrive as the first message and the repository data, in the same marked blocks, as the second. Copilot doesn't enforce the answer's JSON schema either; MALT's own parsers and checks reject anything that doesn't fit. For the details, see [Security](../SECURITY.md#the-trust-boundary). Codex keeps Claude's separation: MALT's static instructions replace Codex's own, and Codex enforces the answer's schema.

Changes apply when the reviewer restarts. More parallel calls and finer per-call settings are planned in [#33](https://github.com/Division4Studios/multi-agent-local-team/issues/33).

## Command palette

All commands below have the **MALT:** prefix.

| Command | Action |
| --- | --- |
| Start Reviewer | Start/restart the selected backend |
| Stop Reviewer | Stop the managed reviewer |
| Scan Project Standards | Read docs, map the source files, infer undocumented conventions and list gaps; saves `.malt/standards.json` and `.malt/architecture.json` |
| Show Project Standards | Open the saved rules as a page grouped by category, with the MALT baseline checks (also the **Standards** row) |
| Show Architecture Map | Explore files, symbols and relationships in the **Architecture** row. Compare local branch tips or a branch against saved edits. |
| Copy Local Agent MCP Configuration | Copy the stdio connection and public verifier for Claude, Codex or another local MCP client. |
| Finalize Diagram or One-page Answer | Publish a version 1 MALT model. Diagram exports request Chrome checks. One-page answers offer a choice. |
| Show Architecture File Summaries | Read the reviewer’s file summaries and applicable developer clarifications. |
| Show Standards Gaps | Reopen the gaps the last scan found as one page. In the Reviewer view, the **Gaps** row lists them; selecting one opens the file at the declaration it names, outlined, with the gap on hover |
| Show Live Reviewer Log | Watch every model call as it happens: what it is for, the prompt sent and the answer streaming in, with elapsed time and a stall indicator. Nothing is saved; individual logs are available under **Reviewers health** |
| Detect Review Providers | Show which review providers this machine can use (Claude, GitHub Copilot) and their models. The first Copilot check asks your permission |
| Check Consolidation Across Changes | One reviewer call over the new declarations in every changed block; findings appear at the top of **Changes** |
| Review Pull Request… | Pick an open pull request on the workspace's GitHub repository (sign in with VS Code's GitHub account), check it out, and list its changed blocks in the **Pull Request** view. Refuses while you have uncommitted changes |
| Review All Pull Request Blocks | Review every block of the open pull request, after showing what it will cost |
| Finish Pull Request Review | Return to the branch you were on and drop the PR's results. Refuses, keeping your work, if you changed files on the checkout |
| Open Pull Request on GitHub | Open the PR in the browser |
| Review All Unreviewed Changes | Queue pending and failed blocks; does not rerun completed reviews |
| Show Reviewer Logs | Open the MALT Reviewer output channel |
| Set Claude Credentials | Store credentials; offers to restart the reviewer |
| Clear Claude Credentials | Remove stored credentials |
| Set Codex Credentials | Store the OpenAI API key that Codex calls use |
| Clear Codex Credentials | Remove the stored OpenAI API key |

**Review Again** is available on a block's hover card or sidebar action. **Reveal Change** is invoked by selecting a block in the sidebar; these contextual actions are not listed in the command palette.

Structural indexing and branch comparison run locally. **Scan Project Standards** and the explorer’s clarification chat use the configured reviewer. Discussion turns use its investigation profile. [Architecture explorer walkthrough](architecture-explorer.md)

## Theme customization

Use `workbench.colorCustomizations` for `malt.hunkPending`, `malt.hunkPass`, and `malt.hunkFail`. Defaults cover dark, light, and both high-contrast themes. Status icons and text explain the state without requiring color recognition.

## Individual reviewer agents

Expand **Reviewer > Reviewers health** to see each agent. MALT starts two agents by default, shared across all review call types. Set `malt.reviewer.maxConcurrentReviews` in user settings and restart the reviewer to change the initial count. There is no fixed maximum; available memory and provider quotas still govern actual throughput. Repository settings cannot increase this machine-scoped value.

Right-click **Reviewers health** to **Add Reviewer Agent** for this session. Right-click an agent to **Cancel Current Task**, **Stop Agent**, **Start Agent**, or **Show Agent Live Stream Log**. Cancel releases the agent after its operation ends; Stop also removes its capacity until started again. Cancelling leaves that review incomplete and available for an explicit retry. Adding or starting capacity lets already queued work proceed. Changes to the running pool last until the reviewer restarts.

| Agent status | Meaning |
| --- | --- |
| Green / working | A provider call is running normally |
| Yellow / waiting for activity | No provider activity for 60 seconds; the call has not yet failed |
| Red / error | The last provider call failed |
| Grey / idle or stopped | No work is running on this agent |

The parent is green when all agents are healthy or idle, including an unused pool. Mixed health or a warning is yellow. When every agent is failed it is red; a mix of failed and idle/stopped agents is yellow. An unavailable service/status check is shown separately. Colors are accompanied by text and distinct icons.

Each agent's log shows only its own calls, including recent in-memory history. Existing redaction, size limits and offline webview protections apply. Agent and task identities are checked by the authenticated service so a stale Cancel/Stop action cannot target newer work. Claude cancellation terminates the call process. Copilot cancellation is propagated through the extension's cancellation token, normally within one second; the slot remains occupied until the delegated operation acknowledges completion or reaches its deadline. A cancelled response cannot become a successful review.
