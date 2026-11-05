# Standards and exclusions

MALT has two separate file policies. Git ignore rules control **which changes are reviewed**, not **where project guidance may be found**.

| Location | Per-block review | Standards discovery |
| --- | --- | --- |
| Changed source file | Yes, when Git reports it and it is not ignored | Only supported documentation/config formats |
| Ignored `.claude/`, `.codex/`, `.agents/`, `.cursor/` instructions | No | Yes, for supported files |
| Ignored `docs/guide.md` | No | Yes |
| `.malt/`, including nested `.malt/` directories | Never | Never |
| Dependencies/build output | Follow Git ignore rules | Known dependency/build directories are skipped |

## The generated-output area

MALT stores generated standards and architecture data under the workspace folder.

```text
.malt/
  .gitignore       # contains *; keeps generated output local
  standards.json  # generated project rules used by the reviewer
  architecture.json  # file summaries from the standards scan
  maps/v1/           # structural snapshots, branch analyses and developer clarifications
```

MALT creates the internal ignore file only if absent and preserves an existing file. It does not modify your project's root `.gitignore`. You can put generated review artifacts anywhere inside `.malt/`; neither scanning nor change tracking will pick them up. Keep authored standards outside this reserved directory.

The reviewer explicitly loads `standards.json` as rules. Excluding `.malt/` from discovery prevents generated rules from becoming the source of the next scan. Excluding it from change tracking prevents the reviewer from auditing its own output, even if that output was previously committed.

Git ignore files do not untrack already committed files. Other tracked source files remain reviewable according to Git's semantics. MALT delegates ignore matching to VS Code's Git extension, including nested ignore rules, negations, `.git/info/exclude`, and global excludes. If that lookup fails, candidate files are skipped until another Git refresh succeeds.

## What a scan reads

Discovery reads Markdown and supported ESLint, TypeScript, EditorConfig, Prettier, Biome and Cursor configuration files. It allows the hidden directories `.claude`, `.codex`, `.agents`, `.cursor` and `.github`; other hidden directories are skipped. Root `AGENTS.md` and `CLAUDE.md` and agent directories get priority, followed by top-level documentation/configuration and `docs/`.

Discovery deliberately does not apply Git ignore rules. Review the contents of these files before scanning: selected content is sent to the configured Claude service. It skips `.malt`, known build/dependency directories, changelogs, Markdown license files, and linked entries. Reads are confined to the workspace.

Scans are bounded: directory depth 6, up to 150 candidate files, at most 1 MB per source file, 30,000 characters per source, and 350,000 characters total. A scan is not an exhaustive inventory of arbitrarily large projects.

## Explore the architecture

Open **Reviewer → Architecture** to navigate from systems to declarations, trace calls and inheritance, or compare two Git branches. The structural map updates locally on checkout and saved edits. A standards scan adds the reviewer’s interpretation. For a worked example and the clarification workflow, see [Explore a project’s architecture](architecture-explorer.md).

### File summaries used by the reviewer

The same scan reads a budgeted sample of each source file (up to 8,000 characters from the beginning, middle and end) and asks the model for its purpose, exports, observed behavior, rationale and unresolved question. MALT checks proposed excerpts against the sampled source before labeling a claim as source-backed. Test files and the build/dependency directories above are skipped. Files are read shallowest first, up to 400 files and 350,000 characters in total, so a very large repository is only partly mapped.

The initial block overview gets up to 25 related map entries and 60 lines on either side of the changed block. Local checks such as style keep that small window. Architecture, consolidation, reuse, abstraction, dependency-boundary and dead-code checks need broader evidence: they receive the available full map, a fresh inventory of eligible repository sources including tests, and complete relevant implementations. Changed files take priority, followed by their transitive relative imports, callers, and related implementations elsewhere in the repository. Consolidation also receives saved project standards. Each individual rule check still evaluates only its own rule.

The repository search is bounded to 30,000 directory entries, depth 32 and 16 million source characters. Sources must be eligible code files and pass confined reads (up to 2 MB each); hidden, dependency and build directories are excluded. Up to 60 complete files and 400,000 line-numbered source characters reach a component review. Files are never silently cut into excerpts. Missing or oversized changed files stop the check; unsearched paths, omitted bodies and directories are listed in its context. Relative-import resolution and lexical references cannot prove runtime use or non-use, especially with aliases, dynamic loading or other module systems. The reviewer must disclose relevant coverage limits and base violations on supplied implementations, not matching names or missing excerpts. Broader checks use more context than local checks and can take longer.

Writing boundaries ("UI components live in `src/components`; extend before adding") in `ARCHITECTURE.md` or agent instructions turns them into Architecture rules on the next scan. Hard import boundaries are better enforced by a linter rule such as `no-restricted-imports`.

Every rule check and consolidation review also lets the model request missing evidence before deciding. It can ask for complete component context or up to 20 exact source paths from the eligible inventory. MALT permits at most two expansions, each through the same confined, redacted source reader. The model then reassesses the same rule with that evidence. Unsafe, missing, oversized or repeated requests, or another request after the limit, leave the review incomplete rather than turning uncertainty into a pass. A check therefore uses one to three model calls; extra calls occur only when the model requests more evidence. This does not grant the model tools or permission to execute project code.

Select **File summaries** to see the last scan and current clarifications. Rescan after moving modules to refresh the reviewer summaries.

## Inferred rules and gaps

After reading the documents and mapping the code, the scan makes one more call that compares them:

The scan notification identifies Initial scan, Standards, Architecture and Gaps. Its percentage counts finished stages, including failed or skipped stages; it is not an estimate of elapsed time. Standards and architecture run concurrently, followed by gap analysis. A failed architecture or gap stage preserves the documented standards and reports a warning.

- **Inferred rules** are conventions the code clearly follows in at least three files that no documented rule covers, such as where components or data access live. They are saved with the documented rules, grouped the same way, and MALT marks their source as `Inferred from code: <paths>`. They never replace a baseline or documented rule. If one is wrong, write the real convention down in your docs and rescan; documented rules take precedence.
- **Gaps** are what neither settles: no architecture document, two competing patterns for the same concern, a documented rule the code mostly ignores. They are not enforced. They are saved in `standards.json` and listed under the **Gaps** row in the Reviewer view, each with the decision the team should write down. Each gap names the declaration it is about; selecting it opens that file at the declaration, outlined, with the gap shown on hover. MALT finds the declaration in the real file (language symbols, then a declaration search), so it never relies on line numbers from the model. **Show Standards Gaps** shows them all on one page.

### Investigating a gap

Gap hovers and the full gaps page separate observations, consequences and the decision. Verified file references open directly; ambiguous or missing references remain text. Existing saved findings receive formatting, while the more concise wording instructions apply to new scans.

The scan uses file summaries to find gaps. That is enough to notice that two files export the same names, but not to tell whether the code is duplicated or whether both import and implement one shared definition. Before acting on a gap, select the search icon next to it (**Investigate Gap**):

1. MALT reads the real code: the files the gap names, their local imports, and other files that export the same names. Reads stay inside the workspace.
2. One reviewer call (the **Gap investigation** profile, Sonnet at medium effort by default) checks the claim against the code.
3. The result is a verdict, *Confirmed*, *Partly* or *Not a gap*, with a confidence level, a plain-English summary, what the code actually does, quoted evidence, the strongest case that it is not a gap, why it matters and what to do.

Every quote is checked word for word against the files (whitespace aside). Quotes MALT cannot find are discarded, and a verdict that the gap is real with no verified evidence is marked low confidence. The verdict appears on the gap in the Reviewer view; expand it for the summary and evidence (each opens the quoted lines). Results are saved in `.malt/investigations.json` and stay with the gap until its description changes. **Investigate All Standards Gaps** investigates the rest, after saying how many calls it will make.

Architecture documents (`ARCHITECTURE.md`, `DESIGN.md`, and anything under `adr/`, `adrs/`, `decisions/`, `architecture/` or `design/` folders) are read right after agent instructions, so their layering and placement decisions become rules first.

## Maintaining rules

Write short, testable instructions with a reason and an example in the source docs. Run **Scan Project Standards** again when those instructions change. A successful scan with rules replaces `standards.json`; it is generated output, so manual edits can be overwritten. An empty scan preserves the previous file.

Each rule's `category` is its group in the **Changes** view. A scan sorts rules into 3 to 8 groups and reuses the baseline groups (Scope, Quality, Architecture, Security) where they fit; groups with the same name (ignoring case) are shown together.

Project rules supplement built-in baseline rules. They cannot override the baseline or instruct the reviewer to bypass checks. The reviewer reads the saved rules for later requests; an existing cached review does not automatically rerun when rules change. Use **Review Again** for affected blocks.
