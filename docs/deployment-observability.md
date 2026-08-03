# Deployment Observability

This project currently observes release readiness through GitHub Actions, build artifacts, updater configuration, and local runtime logs.

## Pre-release signal checklist

Before cutting or promoting a desktop build, verify the latest default-branch CI run is green for:

- Frontend tests
- Sidecar tests
- Frontend typecheck
- Sidecar typecheck
- Electron syntax
- Production build
- Format check
- Documentation check

The CI workflow is defined in `.github/workflows/ci.yml`. Each job uses Node.js 22 and runs the same commands documented in `README.md` and `AGENTS.md`.

## Deployment configuration to capture

Record these values with each release candidate:

| Variable | Why it matters |
| --- | --- |
| `DROIDEX_RELEASE_BUILD` | Enables the fail-closed signed/notarized release configuration |
| `CSC_LINK` | Developer ID Application certificate supplied through CI secrets |
| `APPLE_API_KEY` | App Store Connect API key used for notarization |
| `SENTRY_DSN` | Public client DSN embedded for crash and `/bug` reporting |
| `SIDECAR_ENTRY` | Sidecar bundle override, if used |

Keep real secrets out of release notes and CI logs.

## Runtime health checks

After installing a candidate build:

1. Launch the app and confirm the renderer loads.
2. Complete onboarding or confirm existing settings load.
3. Start a Droid session and verify sidecar connection status.
4. Confirm CLI discovery or installation works on a clean machine.
5. Trigger an update check against the public releases repository.
6. Inspect Electron and sidecar logs for bridge authentication, download, or update errors.

The direct-download app is not App Sandbox–restricted. It asks macOS for access
to Desktop, Documents, or Downloads only when the user selects a protected
project location. Camera, microphone, Accessibility, Screen Recording, and
Apple Events permissions are not requested because current DROIDEX features do
not use those system capabilities.

The sidecar uses Electron's bundled Node 22 runtime and its built-in
`node:sqlite`; users do not install or download SQLite. The canonical session
index is `~/.factory/droidex/session-index.sqlite`. It is DROIDEX-owned derived
state built from raw Factory session history under `~/.factory/sessions`.

## Crash and bug intake

Sentry captures uncaught main/renderer/native crashes and sidecar exits. The
`/bug <description>` composer command creates a sortable `BUG-…` report ID and
a stable pseudonymous `USR-…` support ID. DROIDEX disables default PII,
performance tracing, request capture, and breadcrumbs. User prompts, project
files, API keys, and GitHub credentials are not attached automatically.

Connect the Sentry project to the private source repository using Sentry's
server-side GitHub integration and an issue alert rule. No GitHub token belongs
in the DMG. Upload private source maps from release CI only; never attach source
maps to the public GitHub release.

## Incident triage

If a deployment causes user impact:

1. Stop promotion of the current release candidate.
2. Capture OS version, app version, CPU architecture, and the public release tag.
3. Reproduce with `npm run electron` when possible.
4. Run the relevant runbook in `docs/runbooks.md`.
5. File the fix with the failing CI command and observed runtime log excerpt.

## Missing observability

If the project adds crash reporting, product analytics, or release notifications, link the dashboard and alert channel here and update `docs/runbooks.md` with escalation steps.
