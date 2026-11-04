# Ten views of a project

Open **MALT → Architecture Explorer** in the VS Code sidebar. Expand a workspace, choose a view, and select a subject. Expand the subject again to inspect its parts or follow a relationship without leaving the sidebar. **Reviewer → Architecture** opens the same explorer in an editor.

The **View** selector carries a selected subject into another view when they share an identity. **Related views** offers exact matches. **Previous view** returns to the previous selection. **Reveal in sidebar** expands the active subject there. Use **Compare branches** to select two revisions. The connection map overlays changes and the other screens let you switch between the base and target.

| View | What you can inspect | Evidence MALT uses |
| --- | --- | --- |
| Architecture | Project overview, a component’s children, subsystem responsibilities and security or infrastructure boundaries | Code relationships, agent-defined subsystem names, Terraform declarations, Compose services and dependencies, Docker build stages |
| Workflow | Steps in each lane and dependencies across lanes | GitHub Actions jobs, steps and needs, agent interpretations or authored stages |
| Sequence | Participants, ordered messages, repeated calls and explicit returns | Resolved call sites in source order, agent interpretations or authored messages. Source order alone cannot establish execution order. |
| Data flow | Producers, consumers, destinations and named transfers | SQL writes from SELECT and JOIN, agent interpretations or authored flows |
| Lifecycle | States, transitions, waits, retry loops, entry and exit | Mermaid state diagrams in `.mmd` or `.mermaid` files, agent interpretations or authored transitions |
| Entity–relationship | Table definitions, all parsed columns, primary, foreign and unique constraints, and crow’s-foot ends | SQL CREATE TABLE, inline and table-level constraints. Nullability and uniqueness constrain each end. |
| Class / interface | Members and contracts, inheritance, realization, composition and dependencies | Resolved declarations, typed member signatures and explicitly constructed fields. Owned-field composition is a static inference. |
| Tree | One root, successive levels, parents and children | The repository’s folder, file and declaration hierarchy, or an authored taxonomy |
| Timeline | Events on a time axis, UTC/local display and marked breaks in stretches longer than seven days | Up to 120 Git commits at the selected revision or authored timestamps with explicit offsets |
| Waterfall | Nested durations and overlapping work on a common clock | Complete-duration Chrome trace events (`ph: "X"`) in `*.trace.json` or authored spans. Trace microseconds are converted to milliseconds. |

![How a clarification in the explorer reaches other local sessions](images/architecture-guidance.svg)

Run **MALT: Scan Project Standards (Rescan)** for the reviewer’s interpretation. It reads bounded samples of the implementation and project guidance, groups files by the responsibilities it finds, and can suggest relationships across systems. Infrastructure discovery extracts declaration names and dependency names. The infrastructure reader omits environment values. A suggested relationship with no matching source quote is labeled **Hypothesis**. A matching quote proves that the text occurs in the sample. A developer can clarify its meaning.

**Discuss this panel** opens the reviewer with the selected item and bounded context. Edit and apply its proposed explanation. The working map, later reviews and connected agents then receive the clarification. **Copy panel question** includes the selected passage, view, item, branch and commit for a follow-up in another agent. Git history and observed timings remain independent of model interpretation.

## Describe a domain the source cannot express

A file ending in `.malt-model.json` can describe people, accounts, operational steps or design intent alongside the code. Store the authored file in your repository outside `.malt`. Give a subject the same **ref** in different views to make navigation between them explicit. Save this example as `household.malt-model.json` and select the account in either view.

```json
{
  "version": 1,
  "diagrams": [
    {"id":"accounts","kind":"architecture","title":"Household accounts","items":[
      {"id":"checking","label":"Checking account","group":"Accounts","ref":"household:checking"},
      {"id":"card","label":"Debit card","parent":"checking","group":"Cards","ref":"household:card"}
    ],"links":[{"from":"card","to":"checking","label":"draws from"}]},
    {"id":"payday","kind":"dataflow","title":"Payday transfers","items":[
      {"id":"pay","label":"Paycheck","group":"Income"},
      {"id":"current","label":"Checking account","group":"Accounts","ref":"household:checking"}
    ],"links":[{"from":"pay","to":"current","label":"net pay"}]}
  ]
}
```

The supported `kind` values are `architecture`, `workflow`, `sequence`, `dataflow`, `lifecycle`, `er`, `classes`, `tree`, `timeline` and `waterfall`. Item IDs are unique within a diagram. Use `parent` for nesting, `group` for a lane or category, and `fields` for member or column lists. Link endpoints name item IDs. ER edges use `fromEnd` and `toEnd` with `1`, `0..1`, `1..*` or `0..*`. Sequence links can set `kind` to `return`. Timeline events need `start` as an epoch-millisecond number or an ISO timestamp with a timezone. Waterfall spans need numeric millisecond start/end values. A blank cell does not become zero.

## Publish a checked, standalone artifact

VS Code navigation and scanning work with MALT alone. **Finalize and export** uses the official [Archify 3.2 installation](https://github.com/tt-a1i/archify/tree/a4065941f12be7967436261d9934784e381d423c/archify) for its publication pipeline. Install the complete Archify skill on your machine. On first use, select its trusted `bin/archify.mjs` and your Node.js executable. Chrome or Chromium must be available for browser checks. These executable paths are machine settings. The extension launches an explicit VS Code process task when you request an export.

1. Select a diagram and a destination HTML file. On the project map, focus the component layer you want to share. MALT writes a content-addressed input under `.malt/maps/v1/`.
2. Archify validates the schema, references and layout, stages and delivers the HTML atomically, reads back the delivered file, and records the source and artifact hashes. The diagram task requests a real browser check across desktop sizes. Read its finalization receipt for exact results and diagnostics. A later check failure leaves an already delivered file available.
3. Open the delivered HTML directly. The viewer supplies dark/light themes, live/still motion, route inspection and playback. Its export menu supports SVG, PNG, JPEG, WebP, WebM and clipboard where the browser supports those APIs. Raster export supports up to 4×. The viewer carries its assets and localization inside the file.
4. To finalize an authored Archify diagram or one-page answer with custom translations, source cards or content panels, use **MALT: Finalize Diagram or One-page Answer**. For one-page answers, choose whether to run the browser check. Archify’s `patch explainer` command accepts an exact panel ID and replacement file.
5. In an architecture branch comparison, choose **Export branch delta and receipt** to publish the base and target as a delta diagram. A clean working tree or a pinned branch revision can include full-commit GitHub or GitLab source links. Local edits do not acquire a misleading committed source link.

Publication can stop on difficult geometry or unsupported input. The task terminal shows the actual failure. A receipt with a failed browser gate is distinct from one whose delivered HTML passed every gate.

## Connect active local agents

MALT advertises a local MCP server per trusted folder to VS Code. In an external MCP-capable client, use **MALT: Copy Local Agent MCP Configuration** to obtain the installed server script, workspace path and the public verification key for that workspace connection. Paste the entry into the client’s trusted MCP settings and connect or reconnect the session. Claude-style JSON uses the copied `mcpServers` object. For Codex CLI, supply the same executable and three literal arguments using `codex mcp add malt -- node <script> <workspace> <public-key>`, quoting paths that contain spaces.

- **Read.** `malt_read_guidance` returns the branch, commit, revision, file fingerprints, the reviewer’s interpretations, developer confirmations and current peer handoffs.
- **Subscribe.** `malt://workspace/guidance` emits a resource-update notification when the signed guidance or a current handoff changes. Clients without resource subscriptions can call the read tool again before acting.
- **Coordinate.** `malt_share_handoff` takes `agent`, `message` and the exact `revision` returned by the read. A new branch or revised guidance requires another read. Peer messages remain attributed to agents. Only a developer action in MALT can confirm intent.

The signed feed and current handoffs live in `.malt/maps/v1/`. The bridge verifies the feed against the public key from VS Code and the workspace path before returning it. Its transport is local stdio. Sessions must be connected or explicitly read the shared files to receive updates.

See [the architecture explorer walkthrough](architecture-explorer.md) for the original call trace, historical-source navigation, and indexing limits.
