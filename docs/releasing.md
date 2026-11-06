# Releasing MALT

MALT versions follow [Semantic Versioning](https://semver.org/): **MAJOR.MINOR.PATCH**.

| Bump | When | Example |
| --- | --- | --- |
| `major` | Something that worked stops working or needs action from users: a removed or renamed setting or command, a changed `.malt/` file format, a higher minimum VS Code version | 1.4.2 → 2.0.0 |
| `minor` | New features or behavior that existing setups keep working with | 1.4.2 → 1.5.0 |
| `patch` | Fixes only | 1.4.2 → 1.4.3 |

A release is a GitHub release with the packaged `malt-X.Y.Z.vsix`, its SHA-256 checksum and a signed [build provenance attestation](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations). MALT is not on the VS Code Marketplace.

## Release a new version

`main` is never a pull request target. It only ever changes when the **Release** workflow copies a tested `dev` commit into it, so `main` always holds exactly what was last released.

1. **Bump the version on `dev`** with a normal pull request:

   ```sh
   git switch -c release/vX.Y.Z origin/dev
   npm run release:bump -- minor        # or major / patch
   ```

   This sets the version in `package.json` and `package-lock.json` and moves everything under `## [Unreleased]` in `CHANGELOG.md` to a new `## [X.Y.Z] - YYYY-MM-DD` section. It changes nothing else, and refuses if there is nothing under Unreleased. Read the section: it becomes the release notes. Commit it (signed), push, open a pull request to `dev` titled `release: vX.Y.Z` with the `release` label, and merge it as usual.

2. **Run the release.** Open **Actions → Release → Run workflow**, keep **`dev`** selected, and run it. The workflow (`.github/workflows/release.yml`):
   - **checks the version:** `package.json`, `package-lock.json` and `CHANGELOG.md` must agree (`node scripts/release.mts check`), the `vX.Y.Z` tag must not exist yet, and the commit must be newer than the last release. Everything after this works on the `dev` commit the run started from, so merging more into `dev` meanwhile changes nothing;
   - **runs the full CI matrix** (Linux, Windows and macOS) on that commit;
   - **runs the live reviewer test:** it builds the reviewer image from that commit and makes a real Claude call of every kind (overview, rule checks, consolidation, discussion, standards scan, gap investigation). A release whose reviewer can't complete them never ships. It needs a credential in the `reviewer-live` environment ([repository settings](repository-settings.md#releases)); run it locally with `npm run test:live`;
   - **waits for your approval** (the `release` environment). Check the CI and live results, then select **Review deployments → Approve**;
   - **packages the `.vsix`**, and stops unless its compiled JavaScript is byte-identical to what CI just tested, then records a signed build provenance attestation;
   - **copies the commit into `main`:** a merge commit signed by GitHub whose files are exactly the tested commit's;
   - **tags it `vX.Y.Z` and publishes the release** with the `.vsix`, `SHA256SUMS.txt` and the changelog section as notes. Publishing makes the release immutable, and posts it to the Discord #releases and #shipped channels.

Nothing reaches `main` or a tag until CI, the live test and your approval have all passed.

If a run fails before approval, fix the cause on `dev` (through a pull request) and run the workflow again. If it fails after approval, use **Re-run failed jobs** (within 30 days, while CI's tested output is kept): each step reuses its own earlier result (the `main` merge, the tag), and an existing release is never replaced. A re-run of a release that a newer one has since overtaken is refused before `main` changes, so it can never put older files back on `main`. A bug in MALT itself ships as the next patch version.

### Release source

v1.0.0 (only) was built by the earlier tag-based workflow in a recovery run, whose provenance names `main`. To record what was actually packaged, it also carries a signed **release source** attestation with this section's URL as its type. It records the tag, its commit, the CI run whose tested output the build matched byte for byte, and the workflow run that built it. Read it with:

```sh
gh attestation verify malt-1.0.0.vsix --repo Division4Studios/multi-agent-local-team   --predicate-type https://github.com/Division4Studios/multi-agent-local-team/blob/dev/docs/releasing.md#release-source --format json
```

Releases made by the Release workflow don't need it: their provenance names the `dev` commit and the workflow that built them.

## Install and verify a release

1. Download `malt-X.Y.Z.vsix` from the [releases page](https://github.com/Division4Studios/multi-agent-local-team/releases).
2. Optionally confirm that GitHub Actions built it from this repository's source:

   ```sh
   gh attestation verify malt-X.Y.Z.vsix --repo Division4Studios/multi-agent-local-team
   ```

   or compare its SHA-256 with `SHA256SUMS.txt` from the same release.
3. In VS Code, run **Extensions: Install from VSIX…** and select the file. Reload when prompted.

To update, install the newer `.vsix` the same way.
