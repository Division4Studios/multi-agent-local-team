<!-- Target the dev branch. main is never a pull request target: the Release workflow copies a tested dev commit into it. -->

## What and why

<!-- What does this PR change, and why is it needed? Link the issue. -->

Closes #

## How it was verified

<!-- Commands run, manual steps in the Extension Development Host, screenshots for UI changes. -->

- [ ] `npm run verify` passes locally
- [ ] This pull request targets `dev`
- [ ] Every commit is signed ([how](https://github.com/Division4Studios/multi-agent-local-team/blob/dev/CONTRIBUTING.md#signing-your-commits))

## AI assistance

- [ ] No AI tools were used
- [ ] AI tools were used. Which parts, and with which tool:

<!-- Example: "Initial draft of src/foo.ts with <tool>; tests written by hand." -->

## Author checklist

- [ ] This PR does one thing, and the diff is as small as it can be
- [ ] I have read and understand every line, and can explain it in review
- [ ] New behavior has tests
- [ ] No new dependencies (or an approved issue is linked)
- [ ] No `eslint-disable`, `@ts-ignore`, `as` assertions, `any` or `!` were added
- [ ] Docs and `CHANGELOG.md` updated if user-facing
