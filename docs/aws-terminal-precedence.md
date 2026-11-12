# Native terminal environment precedence measurement

Measured on **Windows 10 Pro x64 10.0.19045**, **VS Code 1.144.1** (product commit
`261c84cb1eddf11235f9e2c921425e9663fbe556`), extension-host Node **v24.22.1**,
Windows PowerShell **5.1.19041.6456**, and terminal Node **v26.13.0**, on
2026-11-11. This retained measurement supports the combined-mode rule in the
[Local AWS guide](local-aws.md).

## Method

An isolated scratch extension used the real `EnvironmentVariableCollection` and
`window.createTerminal` APIs. Its workspace, profile, home, extensions and dummy
AWS files were disposable. Synthetic inherited profile/token markers were set
before launching the editor. No real AWS files were used. Terminals ran
PowerShell `-NoLogo -NoProfile -NonInteractive -Command` with shell integration
disabled and launched an owned Node environment observer.

The observer reported only marker equality/absence, controlled endpoints/regions
and equality to known dummy-file paths. Open/close events were matched to the
returned Terminal object. Every observer's parent PID matched that terminal's
`processId`; every shell exited 0 with `TerminalExitReason.Process`.

Dedicated options used the fixed endpoint/dummy credentials and exactly four
null entries: `AWS_PROFILE`, `AWS_DEFAULT_PROFILE`, `AWS_SESSION_TOKEN` and
`AWS_SECURITY_TOKEN`. The nonpersistent collection replaced the two profiles
with `malt-local`, tokens with empty strings, and config/credentials paths with
the isolated `terminal-profile.ini`. No global clear/create/restore sequence was
used for dedicated creation.

## Corrected run: actual child environment

| Case | Shell → Node PID | Profiles | Tokens | Profile files | Parent marker |
| --- | --- | --- | --- | --- | --- |
| Inherited control | 8496 → 29016 | Synthetic inherited | Synthetic inherited | Owned inherited | Preserved |
| Dedicated nulls, injection off | 34260 → 18044 | Absent | Absent | Owned inherited | Preserved |
| Ordinary, injection on | 31224 → 33552 | `malt-local` | Empty | Isolated dummy | Preserved |
| Dedicated nulls, injection on | 17324 → 21356 | `malt-local` | Empty | Isolated dummy | Preserved |
| Strict environment control | 3856 → 40560 | Absent | Absent | Absent | Absent |
| Ordinary after strict control | 5276 → 19276 | `malt-local` | Empty | Isolated dummy | Preserved |
| Ordinary after collection clear | 28700 → 15796 | Synthetic inherited | Synthetic inherited | Owned inherited | Preserved |

The four endpoint overrides and both regions agreed in every row: active local
cases used `http://127.0.0.1:4566` / `us-east-1`; inherited controls used
`http://127.0.0.1:49999` / `us-west-2`. Dedicated/injected credentials were dummy
`test`/`test`, metadata was disabled and the pager inactive.

**Result:** collection replacements apply after dedicated null removals. The
strict control kept the four variables absent, but discarded unrelated inherited
environment and bypassed collection mutations. Production Local AWS preserves
native inheritance and does not use `strictEnv`.

## Provenance and limitations

The corrected run lasted **23:36:23.194–23:36:30.768 UTC**. Its original
`native-results.json` SHA-256 was
`1f1da1a398a4cca2b75b45e5d860c3c76db21bf6379d835f973e9cb9186d72bd`.
An initial seven-case run had the same profile/token result but misclassified
known Windows paths because of drive-letter case. The corrected run normalized
those two known paths and used a fresh profile; it did not change terminal logic.

Inspection of the installed `workbench.desktop.main.js` (SHA-256
`2b9b74b72a64429d9165babad937fc5c4dcb3f04b7aa77f08328964bf412e93d`)
confirmed the ordering: merge terminal options first, then
`applyToProcessEnvironment`; `strictEnv` skips that latter call.

All 14 terminals across both runs exited; both collections ended with zero
mutators and zero remaining probe terminals. Scoped process checks found no
remaining editor/observer processes. Owned transient directories were removed
at 23:38:28 UTC; receipt/hash/cleanup verification passed at 23:39:38.709 UTC.

These were hidden scratch terminals, not `malt.aws.openTerminal`. No gateway or
AWS request ran. Editor background fetches failed through an unbound loopback
proxy; this was not packet-capture proof of zero attempted networking.
`test-electron` disabled workspace trust, so the observed trusted flag proves no
genuine consent or trust interaction. This measurement establishes neither
production CLI/SDK round trips, interactive shell startup behavior, visual
acceptance nor execution on Linux/macOS/remote hosts.
