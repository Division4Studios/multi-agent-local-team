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

When a scan produces rules, MALT creates:

```text
.malt/
  .gitignore       # contains *; keeps generated output local
  standards.json  # generated project rules used by the reviewer
  architecture.json  # generated map of source files: purpose and exports
```

MALT creates the internal ignore file only if absent and preserves an existing file. It does not modify your project's root `.gitignore`. You can put generated review artifacts anywhere inside `.malt/`; neither scanning nor change tracking will pick them up. Keep authored standards outside this reserved directory.

The reviewer explicitly loads `standards.json` as rules. Excluding `.malt/` from discovery prevents generated rules from becoming the source of the next scan. Excluding it from change tracking prevents the reviewer from auditing its own output, even if that output was previously committed.

Git ignore files do not untrack already committed files. Other tracked source files remain reviewable according to Git's semantics. MALT delegates ignore matching to VS Code's Git extension, including nested ignore rules, negations, `.git/info/exclude`, and global excludes. If that lookup fails, candidate files are skipped until another Git refresh succeeds.

## What a scan reads

Discovery reads Markdown and supported ESLint, TypeScript, EditorConfig, Prettier, Biome and Cursor configuration files. It allows the hidden directories `.claude`, `.codex`, `.agents`, `.cursor` and `.github`; other hidden directories are skipped. Root `AGENTS.md` and `CLAUDE.md` and agent directories get priority, followed by top-level documentation/configuration and `docs/`.

Discovery deliberately does not apply Git ignore rules. Review the contents of these files before scanning: selected content is sent to the configured Claude service. It skips `.malt`, known build/dependency directories, changelogs, Markdown license files, and linked entries. Reads are confined to the workspace.

Scans are bounded: directory depth 6, up to 150 candidate files, at most 1 MB per source file, 30,000 characters per source, and 350,000 characters total. A scan is not an exhaustive inventory of arbitrarily large projects.

## The architecture map

The same scan reads the start of each source file (up to 1,500 characters: imports, exports and top-level declarations) and asks the model for one line per file: what it is for and what it exports. Test files and the build/dependency directories above are skipped. Files are read shallowest first, up to 400 files and 350,000 characters in total, so a very large repository is only partly mapped.

Reviews never send the whole map. Each block review gets up to 25 related entries: files whose names or exports share words with the added code count most, then files in the same, parent or sibling folder. The overview call and **Architecture**-group rule checks get this slice; other rule checks do not. The consolidation check gets up to 80 entries for the whole change. Writing your boundaries ("UI components live in `src/components`; extend before adding") as rules in an `ARCHITECTURE.md` or agent instructions turns them into Architecture rules on the next scan. Hard import boundaries are better enforced by a linter rule such as `no-restricted-imports`.

The map goes stale as code changes. Rescan after adding or moving modules; the **Reviewer** view shows the map's date.

## Inferred rules and gaps

After reading the documents and mapping the code, the scan makes one more call that compares them:

- **Inferred rules** are conventions the code clearly follows in at least three files that no documented rule covers, such as where components or data access live. They are saved with the documented rules, grouped the same way, and MALT marks their source as `Inferred from code: <paths>`. They never replace a baseline or documented rule. If one is wrong, write the real convention down in your docs and rescan; documented rules take precedence.
- **Gaps** are what neither settles: no architecture document, two competing patterns for the same concern, a documented rule the code mostly ignores. They are not enforced. They are saved in `standards.json` and listed under the **Gaps** row in the Reviewer view, each with the decision the team should write down. Each gap names the declaration it is about; selecting it opens that file at the declaration, outlined, with the gap shown on hover. MALT finds the declaration in the real file (language symbols, then a declaration search), so it never relies on line numbers from the model. **Show Standards Gaps** shows them all on one page.

Architecture documents (`ARCHITECTURE.md`, `DESIGN.md`, and anything under `adr/`, `adrs/`, `decisions/`, `architecture/` or `design/` folders) are read right after agent instructions, so their layering and placement decisions become rules first.

## Maintaining rules

Write short, testable instructions with a reason and an example in the source docs. Run **Scan Project Standards** again when those instructions change. A successful scan with rules replaces `standards.json`; it is generated output, so manual edits can be overwritten. An empty scan preserves the previous file.

Each rule's `category` is its group in the **Changes** view. A scan sorts rules into 3 to 8 groups and reuses the baseline groups (Scope, Quality, Architecture, Security) where they fit; groups with the same name (ignoring case) are shown together.

Project rules supplement built-in baseline rules. They cannot override the baseline or instruct the reviewer to bypass checks. The reviewer reads the saved rules for later requests; an existing cached review does not automatically rerun when rules change. Use **Review Again** for affected blocks.
