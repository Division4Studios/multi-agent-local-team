# Editor acceptance checks

Run `npm run verify` first. Automated tests launch VS Code, but visual layout and focus behavior also need a human pass in an Extension Development Host.

## Setup

Press **F5**, then open a disposable Git repository in the new window. Start with one committed text file. Disable `malt.changes.autoReview` if checking presentation without model calls. Use a configured reviewer for the verdict/hover checks.

| Check | Expected result |
| --- | --- |
| Save a one-line change | One continuous outline, readable inline status, one sidebar block |
| Save a multiline change and separate block | Correct top/side/bottom edges; no doubled rounded corners between lines |
| Hover a reviewed block | Status and summary first, then purpose/technical/design and rule counts with failing rules; retry link works |
| Run **Scan Project Standards** in a repo with code but no architecture doc | Message counts documented and inferred rules and gaps; **Show Gaps** opens a page that includes a missing-architecture-doc gap; inferred rules show `Inferred from code:` as their source |
| Explore a project, file and declaration with keyboard and mouse | Breadcrumbs and **Back** restore focus to the chosen neighbourhood. Filter connections, zoom, trace a call and open its source. |
| Pan a large map and each diagram view with middle drag; drag empty canvas; focus the canvas and use Space + drag, arrows, and Home | Movement follows the pointer, releasing outside or changing focus ends the gesture, card clicks still select, Center diagram restores the center, and Fit respects viewport width. Repeat in a portable HTML export. |
| Compare a base and target with a removed declaration and a changed call | **Changes only** includes the affected entities. Trace each side separately and open removed source from the base. The checkout stays on the original branch. |
| Select a working hypothesis, ask a follow-up, edit the wording and apply it | The map and file summaries identify a developer clarification. A rescan preserves it on the same branch and file version. Editing the file or switching branches removes it from current review context until applicable again. |
| Open a subject from **Architecture Explorer**, switch to a related view, then **Reveal in sidebar** | Both surfaces navigate to the same subject. Back, search, keyboard selection, paging and reduced motion remain usable. |
| Finalize a timed diagram and compare two agent sessions | The receipt binds the delivered HTML hash. A subscriber receives an update and a stale handoff cannot enter the new revision. |
| Run **Check Consolidation Across Changes** with two new similar files | A **Consolidation** row appears above the files with its findings; selecting one opens its detail page |
| Expand a reviewed block in Changes | Rule groups sorted running → failed → passed → not run → not applicable; selecting a checked rule opens its detail page beside the editor |
| Select a sidebar block | Correct file and line revealed; file icons follow the selected icon theme |
| Create an untracked file of 160 identical nonblank lines | Two independent rows (lines 1–80 and 81–160); selecting each reveals its own block |
| Collapse a file, then update review status | Stable tree identity preserves navigation state |
| Edit another file on disk | Preview opens without moving keyboard focus when auto-open is enabled |
| Disable auto-open, edit another file | Sidebar updates; editor stays where it was |
| Reopen with pre-existing changes | No automatic file opening |
| Edit an ignored file | No block, review request, or automatic opening |
| Scan with ignored `.claude/SKILL.md` | Instructions are discoverable; generated `.malt/standards.json` is never a changed block |
| Run scan a second time | Generated output is not used as a discovery source; `.malt/.gitignore` stays intact |
| Revert/commit a changed block | Obsolete decorations and sidebar entries disappear after Git refresh |
| Stop reviewer or force a request failure | Pending/error text is distinct from a code verdict; retry works after recovery |

Repeat presentation checks in **Dark+**, **Light+**, **High Contrast**, and **High Contrast Light**. Check keyboard navigation, narrow sidebars, zoomed text, long review summaries and filenames, and multiple editor groups. Do not rely solely on red/green to identify results.

Record OS, VS Code version, theme, checks performed, and any untested items in the PR. Screenshots should use disposable code. Model output varies: verify the layout and state mapping, not a guaranteed verdict for a particular snippet.
