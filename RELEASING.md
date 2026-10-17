# Releasing Buffer

## In short
- **See changes while working:** double-click `Run Buffer (dev).cmd` (local helper, not in git). No installer needed.
- **Ship a version:** `scripts\release.ps1` (or double-click `Release Buffer.cmd`). It bumps the version, pushes and tags;
  GitHub builds, signs and publishes the installer, and installed copies update themselves.

## One-time setup
1. **Updater key.** Already generated on the maintainer's machine in `%USERPROFILE%\.buffer-release\`
   (`updater.key`, `updater.pw`, `updater.key.pub`). The *public* key is in `src-tauri/tauri.conf.json`; the private
   key never goes into the repository. **Back it up** (password manager): if it is lost, installed copies can never
   be updated again and a new key means a manual reinstall for everyone.
   Create a new pair with `npx tauri signer generate --write-keys <path> --password <pw>`.
2. **GitHub secrets** (needed only for CI releases):
   `gh secret set TAURI_SIGNING_PRIVATE_KEY < %USERPROFILE%\.buffer-release\updater.key` and
   `gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD < %USERPROFILE%\.buffer-release\updater.pw`
3. The release feed is fetched anonymously, so **the repository (or at least its releases) must be public**.

## Shipping a version
```
# write release-notes/0.2.0.md first (see "Release notes" below) and commit it
.\scripts\release.ps1 0.2.0 -DryRun     # every check, including the notes, without changing anything
.\scripts\release.ps1 0.2.0             # bump, commit, push, tag; GitHub builds (-Local builds here)
```
`bump-version.ps1` and `publish.ps1` are the steps `release.ps1` runs; `publish.ps1` alone publishes the committed
version from this machine.

## Release notes
Every version has `release-notes/<version>.md`, committed before the release. All three release paths (local,
GitHub, `-DryRun`) read it through `scripts/release-notes.ps1` and refuse to release without it or when it is not
in the format. Copy `release-notes/TEMPLATE.md`:

```
One sentence about what this version brings.

## New
- **Fans:** a Fans page with fan curves.

## Improved
## Fixed
## Removed
## Heads-up
```

- Line 1 is a one-sentence summary; it is what the update popover shows first.
- Sections are only those five, each with `- **Area:** ...` bullets; leave out the empty ones. They always come
  out in that order. Heads-up is for what the user must do or know (admin prompt, reinstall).
- Write for users: what they can now do or what was wrong, no internals or commit hashes.

From the file the script makes the GitHub body (Markdown, plus the install note and the installer's SHA-256) and the
plain-text notes in `latest.json` for the in-app popover (no Markdown, `•` bullets). Check both without releasing:
`.\scripts\release-notes.ps1 -Version 0.2.0`.

A release contains the installer, its `.sig`, and `latest.json`. Installed copies read
`https://github.com/<repo>/releases/latest/download/latest.json`, compare versions, verify the `.sig` against the
embedded public key, then run the installer in passive mode.

## Testing an update locally
Serve a `latest.json` that points at a built installer from `http://127.0.0.1`, start the app with an updater
override config (`"endpoints": ["http://127.0.0.1:8765/latest.json"]`, `"dangerousInsecureTransportProtocol": true`)
and watch the chip appear in the top bar.
