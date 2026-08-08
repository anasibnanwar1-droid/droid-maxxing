# Releasing DROIDEX

This is the team checklist for publishing a DROIDEX macOS release. The source
repository is public. Installers and update files remain isolated in the public
[`droidex-releases`](https://github.com/droidex-anas/droidex-releases)
repository so the app consumes only the seven verified release assets, never
source archives.

## Before you start

- Use Node.js 22 on a Mac.
- Work from a clean commit already pushed to `main`.
- Pick a new version. Published releases are immutable, so never reuse a
  version or replace an existing asset.
- Confirm the protected Sentry DSN is available without printing it.
- Confirm the Sparkle signing key is available as `SPARKLE_PRIVATE_KEY` in the
  protected GitHub environment. For an approved manual release, keep it in the
  release Mac's Keychain. Never commit or paste the private key into a terminal
  log.

## 1. Prepare the version

Create a small release branch from current `main`, then update the version. The
version below is an example; always choose the actual next version:

```bash
git switch main
git pull --ff-only
git switch -c release/v1.0.2
npm version 1.0.2 --no-git-tag-version
npm run docs:generate
```

Run the complete release checks:

```bash
npm run format:check
npm run docs:check
npm run typecheck
npm run sidecar:typecheck
npm run electron:check
npm run test
npm --prefix sidecar run test
npm run quality:file-size
npm run quality:tech-debt
npm run quality:boundaries
npm run quality:deps
npm run quality:deadcode
npm run quality:duplicates
npm run security:audit-report
npm run build
```

Commit the version and generated documentation, open a PR, and merge it into
`main`. Build the release from a fresh, clean checkout of that exact `main`
commit. Do not release an unmerged feature branch.

## 2. Start the automated release

After the version PR is merged and `main` is green, tag that exact commit. The
tag must be `v` followed by the version in `package.json`:

```bash
git switch main
git pull --ff-only
test "$(node -p "require('./package.json').version")" = "1.0.2"
git tag -a v1.0.2 -m "DROIDEX v1.0.2"
git push origin v1.0.2
```

Pushing the tag starts `.github/workflows/release-macos.yml`. The protected
`macos-release` environment must contain `SENTRY_DSN`, `SPARKLE_PRIVATE_KEY`,
and `DROIDEX_RELEASE_TOKEN`.

The workflow reruns the release gates, builds Intel and Apple silicon packages,
signs the Sparkle feeds, verifies the packages and checksums, creates a public
draft, compares every uploaded SHA-256 digest, publishes the immutable release,
and verifies GitHub's asset attestations. A normal merge to `main` runs CI but
does not publish a release.

## 3. What the pipeline publishes

The current website build is ad-hoc signed and not notarized. It does not need
an Apple Developer Program subscription, but users must approve DROIDEX once in
Privacy & Security.

The automated workflow executes the equivalent of these local commands:

```bash
DROIDEX_UNSIGNED_RELEASE_BUILD=1 npm run dist:mac

npm run sparkle:appcast -- release
npm run release:verify:mac -- release --write-checksums
npm run release:preflight:unsigned
```

Every command must pass. The preflight verifies both repository identities and
visibility, app versions, architecture-specific Sparkle feeds, EdDSA signatures,
checksums, packaged native modules, and SQLite runtime.

It uploads exactly these seven files to
`droidex-anas/droidex-releases`:

```text
droidex-arm64.dmg
droidex-arm64.zip
droidex-x64.dmg
droidex-x64.zip
appcast-arm64.xml
appcast-x64.xml
SHA256SUMS
```

Do not upload blockmaps, `latest-mac.yml`, app directories, source maps,
certificates, environment files, or source archives for the current
Sparkle release path.

The permanent website download links are:

- Apple silicon:
  `https://github.com/droidex-anas/droidex-releases/releases/latest/download/droidex-arm64.dmg`
- Intel:
  `https://github.com/droidex-anas/droidex-releases/releases/latest/download/droidex-x64.dmg`
- Release page:
  `https://github.com/droidex-anas/droidex-releases/releases/latest`

Those URLs do not change between versions.

## 4. Manual recovery path

Use this only if the tag workflow cannot run and the release owner has approved
a manual publication. Build and pass the unsigned preflight first, then create
the draft from the clean source checkout:

```bash
DROIDEX_VERSION=1.0.2
RELEASE_REPOSITORY=droidex-anas/droidex-releases

gh release create "v$DROIDEX_VERSION" \
  --repo "$RELEASE_REPOSITORY" \
  --target main \
  --title "DROIDEX v$DROIDEX_VERSION" \
  --notes "DROIDEX v$DROIDEX_VERSION for Apple silicon and Intel Macs." \
  --draft

gh release upload "v$DROIDEX_VERSION" \
  release/droidex-arm64.dmg \
  release/droidex-arm64.zip \
  release/droidex-x64.dmg \
  release/droidex-x64.zip \
  release/appcast-arm64.xml \
  release/appcast-x64.xml \
  release/SHA256SUMS \
  --repo "$RELEASE_REPOSITORY"
```

Compare every draft asset's GitHub SHA-256 digest with the local file before
publishing. Confirm the public README still describes the real install and
update behavior. A mismatch must stop publication:

```bash
test "$(gh release view "v$DROIDEX_VERSION" \
  --repo "$RELEASE_REPOSITORY" \
  --json assets --jq '.assets | length')" = "7"

for asset in \
  release/droidex-arm64.dmg \
  release/droidex-arm64.zip \
  release/droidex-x64.dmg \
  release/droidex-x64.zip \
  release/appcast-arm64.xml \
  release/appcast-x64.xml \
  release/SHA256SUMS; do
  name="${asset##*/}"
  local_digest="$(shasum -a 256 "$asset" | awk '{print $1}')"
  remote_digest="$(gh release view "v$DROIDEX_VERSION" \
    --repo "$RELEASE_REPOSITORY" \
    --json assets \
    --jq '.assets[] | select(.name == "'"$name"'") | .digest')"
  test "sha256:$local_digest" = "$remote_digest"
done
```

Only then publish and verify the draft:

```bash
gh release edit "v$DROIDEX_VERSION" --repo "$RELEASE_REPOSITORY" --draft=false
gh release verify "v$DROIDEX_VERSION" --repo "$RELEASE_REPOSITORY"

for asset in \
  release/droidex-arm64.dmg \
  release/droidex-arm64.zip \
  release/droidex-x64.dmg \
  release/droidex-x64.zip \
  release/appcast-arm64.xml \
  release/appcast-x64.xml \
  release/SHA256SUMS; do
  gh release verify-asset "v$DROIDEX_VERSION" "$asset" \
    --repo "$RELEASE_REPOSITORY"
done
```

## 5. Prove the update works

Release work is not complete until the public files work end to end:

1. Install the previous public version on a clean test account.
2. Use **DROIDEX → Check for Updates…**.
3. Confirm Sparkle finds the new architecture-matched version.
4. Approve the download, then choose **Install and Relaunch**.
5. Confirm the installed app reports the new version.
6. Confirm the Sidebar update icon is absent when the installed version is
   current.
7. Launch a session and submit a private test feedback report. Record its
   `RPT-…` ID without copying private report contents into GitHub.

If a published release is bad, do not replace its assets. Fix the problem and
publish a higher patch version.

## Future Developer ID releases

When the project joins the Apple Developer Program, update the one canonical
`.github/workflows/release-macos.yml` publisher to use `DROIDEX_RELEASE_BUILD=1`,
Developer ID credentials, notarization, and electron-updater metadata. Before
tagging, run `npm run release:preflight`; then create and push the annotated
`v<package-version>` tag from merged `main`. That future path publishes
`latest-mac.yml` and blockmaps instead of Sparkle appcasts. Do not run both
distribution paths for one release.

## Public source repository controls

Repository visibility is part of the release contract. Keep the source
repository public and the artifact-only `droidex-releases` repository public;
the preflight fails if either changes unexpectedly. A public repository exposes
its tracked files, Git history, issues, pull requests, Actions metadata, and
source archives, so none may contain credentials, private reports, privileged
server logic, or unpublished source maps.

Before every release, keep secret scanning and CodeQL green, review generated
security findings, and confirm the packaged artifacts contain no source-repo
URLs, machine paths, environment files, source maps, or credentials. Keep Sentry
reports and release secrets in their private services. The application must use
only the signed appcasts and archives from `droidex-releases`; GitHub source
archives are never update payloads.

For detailed release controls, failure recovery, permissions, diagnostics, and
the paid signing path, see
[`deployment-observability.md`](deployment-observability.md) and
[`runbooks.md`](runbooks.md).
