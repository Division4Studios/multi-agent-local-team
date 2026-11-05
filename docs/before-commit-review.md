# Review changes before committing

Open **MALT → Changes → Before Commit: Explain and Inspect Changes** using the preview icon in the view title, or run the command from the command palette.

The page follows four questions: what changed, why it matters, what needs attention, and where to verify it. Opening it reads local review state; it does not call a model. **Explain these changes** and the question buttons make an on-demand call to the configured reviewer.

## Inspect the evidence

- The file map groups the current tracked changes by folder. Select a card to read available responsibility summaries, changed line ranges, the block reviewer's explanation and recorded rule checks.
- **Open changed source** opens the verified file. **Explore this file** opens its architecture view.
- **Changed connections** shows added or removed relative imports resolved from the patches. It is a focused change view, not a complete runtime dependency graph. Unresolved imports and other kinds of architecture changes may be absent.
- **What needs attention?** gathers recorded failures and consolidation candidates. No recorded failures does not mean a change is ready to commit. Consolidation candidates may come from an earlier check.
- Tests are separate from AI code review. The panel does not execute tests. Open VS Code Testing to run your configured tests, then optionally record the result you observed. Recorded notes are explicitly developer-reported, not independently verified, and are included as such in later answers.

## Ask questions

Try **What will users notice?**, **How did the architecture change?**, or **What should I check?** Then ask follow-up questions. The answer links to the files whose patches were supplied. Available exact quotations are shown separately from inferred rationale.

The discussion uses whole captured patch blocks within a 46,000-character source budget, bounded architecture summaries and current review metadata. It does not read every complete implementation. Omitted block counts appear with the answer. Large change sets may omit detailed metadata as well; that omission is included in the model context.

This workspace covers the first tracked workspace folder, matching MALT's current local-change tracker. The branch and folder are shown at the top. Deleted, binary, excluded or otherwise untracked-by-MALT changes are not represented in the file map; when Git information is available, a notice counts unrepresented changes. Unsaved editor content is not included. Save edits and wait for change tracking before requesting an explanation.

If changes or recorded reviews update while a response is being prepared, that response is discarded. Unsaved document edits also invalidate earlier explanations and verification notes, even though the discussion only reads saved patches. Save or discard those edits before recording a fresh verification result. Git coverage compares file identities across staged, working-tree and untracked changes, so an untracked addition cannot hide an unrepresented deletion.

**Run missing code reviews** starts the reviewer if it is offline and shows queued, running, waiting and error counts. Startup failure is reported instead of silently leaving an idle queue. The page is unavailable during an active pull request review to keep that checkout distinct from local pre-commit work.

## Product acceptance tasks

These are human usability tasks to perform, not a claim that user testing has passed.

1. Without reading source first, identify the folders affected and explain one file's responsibility.
2. Follow an import addition or removal and open both files. Distinguish a changed relationship from the complete architecture.
3. Find a failing rule, understand its recorded reason, and open the affected source.
4. Distinguish an AI review pass from an executed test result. Record a failed test and confirm later answers treat it as developer-reported evidence.
5. Ask a nontechnical question, inspect the supporting files, and identify which rationale is inferred.
6. Save another change while an answer is in flight; confirm the page does not present the stale response as current.
7. Repeat with keyboard navigation, a narrow editor and light/dark/high-contrast themes.
