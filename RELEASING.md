# Releasing Buffer

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
.\scripts\bump-version.ps1 0.2.0        # tauri.conf.json, Cargo workspace, package.json
git commit -am "Release 0.2.0"
.\scripts\publish.ps1 -Notes "What changed"      # local: build, sign, create the GitHub release
```
or push a tag `v0.2.0` and let `.github/workflows/release.yml` do it.

A release contains the installer, its `.sig`, and `latest.json`. Installed copies read
`https://github.com/<repo>/releases/latest/download/latest.json`, compare versions, verify the `.sig` against the
embedded public key, then run the installer in passive mode.

## Testing an update locally
Serve a `latest.json` that points at a built installer from `http://127.0.0.1`, start the app with an updater
override config (`"endpoints": ["http://127.0.0.1:8765/latest.json"]`, `"dangerousInsecureTransportProtocol": true`)
and watch the chip appear in the top bar.
