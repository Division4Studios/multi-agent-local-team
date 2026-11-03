# Editor acceptance checks

Run `npm run verify` first. Automated tests launch VS Code, but visual layout and focus behavior also need a human pass in an Extension Development Host.

## Setup

Press **F5**, then open a disposable Git repository in the new window. Start with one committed text file. Disable `malt.changes.autoReview` if checking presentation without model calls. Use a configured reviewer for the verdict/hover checks.

| Check | Expected result |
| --- | --- |
| Save a one-line change | One continuous outline, readable inline status, one sidebar block |
| Save a multiline change and separate block | Correct top/side/bottom edges; no doubled rounded corners between lines |
| Hover a reviewed block | Verdict and summary first, then what/why/necessity and labeled checks; retry link works |
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
