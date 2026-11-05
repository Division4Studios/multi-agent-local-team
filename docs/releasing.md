# Releasing MALT

MALT versions follow [Semantic Versioning](https://semver.org/): **MAJOR.MINOR.PATCH**.

| Bump | When | Example |
| --- | --- | --- |
| `major` | Something that worked stops working or needs action from users: a removed or renamed setting or command, a changed `.malt/` file format, a higher minimum VS Code version | 1.4.2 → 2.0.0 |
| `minor` | New features or behavior that existing setups keep working with | 1.4.2 → 1.5.0 |
| `patch` | Fixes only | 1.4.2 → 1.4.3 |

A release is a GitHub release with the packaged `malt-X.Y.Z.vsix`, its SHA-256 checksum and a signed [build provenance attestation](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations). MALT is not on the VS Code Marketplace.

## Release a new version

Only the repository admin can create release tags. The steps follow the usual branch rules: everything reaches `dev` and then `main` through pull requests.

1. **Prepare the version on a branch from `dev`.**

   ```sh
   git switch -c release/vX.Y.Z origin/dev
   npm run release:bump -- minor        # or major / patch
   ```

   This sets the version in `package.json` and `package-lock.json` and moves everything under `## [Unreleased]` in `CHANGELOG.md` to a new `## [X.Y.Z] - YYYY-MM-DD` section. It changes nothing else, and refuses if there is nothing under Unreleased. Read the section: it becomes the release notes. Commit it (signed), push, and open a pull request to `dev` titled `release: vX.Y.Z`.

2. **Merge `dev` into `main`.** Open the pull request from `dev` to `main` with the `release` label and merge it with a merge commit, as for every release.

3. **Tag the merge commit on `main` and push the tag.**

   ```sh
   git fetch origin
   git tag -s vX.Y.Z -m "MALT X.Y.Z" origin/main
   git push origin vX.Y.Z
   ```

   The tag must be annotated and signed with a key on your GitHub account (`-s`; this clone signs with its SSH key). A tag can't be moved or deleted afterwards, so check `git log -1 origin/main` first.

4. **The Release workflow** (`.github/workflows/release.yml`) then:
   - refuses unless the tag is `vMAJOR.MINOR.PATCH`, its signature verifies on GitHub, it points to a merge commit on `main`, and `package.json`, `package-lock.json` and `CHANGELOG.md` all have that version (`node scripts/release.mts check`);
   - runs the full CI matrix (Linux, Windows and macOS) on the tagged commit;
   - runs the **live reviewer test**: builds the reviewer image from that commit and makes a real Claude call of every kind (overview, rule checks, consolidation, discussion, standards scan, gap investigation). A release whose reviewer can't complete them is never drafted. It needs a credential in the `reviewer-live` environment ([repository settings](repository-settings.md#releases)); run it locally with `npm run test:live`;
   - packages the `.vsix`, and stops unless its compiled JavaScript is byte-identical to what CI just tested;
   - records the provenance attestation and creates a **draft** release with the `.vsix`, `SHA256SUMS.txt` and the changelog section as notes.

5. **Publish the draft.** Open the draft under **Releases**, check the notes and assets, and select **Publish release**. Publishing makes the release immutable, and posts it to the Discord #releases and #shipped channels.

If a step fails, fix the cause in a new pull request. A pushed tag can't be moved, so the fix ships as the next patch version. If the workflow fails on something outside the repository (for example a runner outage), re-run it from the Actions tab; it never replaces an existing release.

## Install and verify a release

1. Download `malt-X.Y.Z.vsix` from the [releases page](https://github.com/Division4Studios/multi-agent-local-team/releases).
2. Optionally confirm that GitHub Actions built it from this repository's tagged source:

   ```sh
   gh attestation verify malt-X.Y.Z.vsix --repo Division4Studios/multi-agent-local-team
   ```

   or compare its SHA-256 with `SHA256SUMS.txt` from the same release.
3. In VS Code, run **Extensions: Install from VSIX…** and select the file. Reload when prompted.

To update, install the newer `.vsix` the same way.
