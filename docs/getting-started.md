# Your first MALT review

MALT reviews saved changes in a local Git repository inside VS Code. It does not create a pull request or commit changes for you. This is an early preview, currently installed from source or a locally built VSIX.

## Install and launch

1. Install Node.js 24 or newer, VS Code 1.144 or newer, and Docker with a running Linux engine. TypeScript 7 compilation requires Docker; see the [toolchain guide](toolchain.md).
2. Clone this repository, run `npm ci`, and open its folder in VS Code.
3. Press **F5** and choose **Run Extension**. The watch task compiles the extension and opens an Extension Development Host.
4. In that new window, open a local Git repository. MALT currently reviews the **first workspace folder** only.
5. Open the MALT activity-bar view (the barley sprig).

To install without debugging, run `npm run vsix`, then use **Extensions: Install from VSIX** and select the generated package. Reload VS Code when prompted.

## Connect a reviewer

For the host backend, install and sign into the Claude Code CLI, then select **MALT: Start Reviewer**. If `claude` is not on your PATH, set `malt.reviewer.claudePath` to its executable path.

For Docker, start Docker Desktop and run **MALT: Set Claude Credentials**. Supply an Anthropic API key or a subscription token obtained with `claude setup-token`. MALT stores credentials in VS Code SecretStorage. With the default `auto` backend, MALT chooses Docker when available and credentials are stored; otherwise it uses the host process. Choose `docker` explicitly if container isolation is required.

The sidebar should show **Reviewer: running**. Clicking the reviewer row opens its logs. Model calls use your configured Claude account and may incur charges. The reviewer runs locally, but the Claude CLI sends supplied code/context to its configured model service; this is not offline inference.

## Scan, edit, understand

1. Run **MALT: Scan Project Standards**. This reads project documentation, agent instructions and supported lint/config files, including instructions in ignored agent folders. It also maps your source files (what each is for and what it exports), so reviews can point at existing code to reuse, and compares docs with code: conventions the code follows that no doc states become rules marked *Inferred from code*, and what neither settles is listed under **Show Gaps**. Rescan to refresh the reviewer’s explanations and open design questions. The structural map updates automatically on branch checkout and saved edits in each trusted local workspace folder. Open **Reviewer → Architecture** to explore it. [Trace your first call or compare branches](architecture-explorer.md)
2. Inspect the generated `.malt/standards.json` using **Open Rules**. Generated rules are project guidance; built-in baseline checks remain active.
3. Edit and **save** a text file, or let a coding agent edit it on disk. After Git refreshes, MALT outlines the changed blocks.
4. Hover a block for its summary, business purpose, technical description, design assessment and rule results. Select a block in **Changes** to reveal it, and expand it to see its rules by group: running first, then failed, passed, not run and not applicable. Select a checked rule for its full explanation. Use **Review Again** to rerun a block from the start; reviewing a failed block again only reruns the rules that are missing.

| State | Meaning |
| --- | --- |
| Waiting / queued / reviewing | No failure yet and rules still to check; the outline is dashed |
| Passed | Green outline; checks passed |
| Changes requested | Red outline; at least one rule failed (shown as soon as it fails, even while other rules run) |
| Review failed | The request failed, not a verdict on the code; check logs and retry |

Text and icons accompany color. Your theme can override the three `malt.hunk*` colors.

## Keep the editor quiet

Set `malt.changes.autoOpen` to `false` to choose when to open changed files. Automatic opening uses a preview tab and preserves keyboard focus; it can still replace the visible preview. Existing changes at startup do not automatically open files.

Set `malt.changes.autoReview` to `false` to review on demand with **MALT: Review All Unreviewed Changes**. Set `malt.reviewer.autoStart` to `false` to start the reviewer manually as well. Disable both to make a new workspace fully manual.

See [all settings and commands](configuration.md), [standards and exclusions](standards.md), and [troubleshooting](troubleshooting.md).

## Join the community

Stuck, or want to show what MALT found? Join the [MALT Discord](https://discord.gg/DwSpsGjvFY): ask in **#help**, share exported diagrams in **#architecture-maps**, and talk through a wrong verdict in **#wrong-verdicts**.
