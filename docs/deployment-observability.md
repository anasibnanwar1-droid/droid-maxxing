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
| `DROID_DOWNLOAD_BASE` | Base URL used for Droid CLI downloads |
| `DROID_UPDATE_FEED` | Update metadata endpoint used by Electron |
| `DROID_UPDATE_HOSTS` | Allowed update hosts |
| `SIDECAR_ENTRY` | Sidecar bundle override, if used |
| `NODE_BIN` | Node binary override, if used |

Keep real secrets out of release notes and CI logs.

## Runtime health checks

After installing a candidate build:

1. Launch the app and confirm the renderer loads.
2. Complete onboarding or confirm existing settings load.
3. Start a Droid session and verify sidecar connection status.
4. Confirm CLI discovery or installation works on a clean machine.
5. Trigger an update check when `DROID_UPDATE_FEED` is configured.
6. Inspect Electron and sidecar logs for bridge authentication, download, or update errors.

## Incident triage

If a deployment causes user impact:

1. Stop promotion of the current release candidate.
2. Capture OS version, app version, `DROID_DOWNLOAD_BASE`, `DROID_UPDATE_FEED`, and bridge settings.
3. Reproduce with `npm run electron` when possible.
4. Run the relevant runbook in `docs/runbooks.md`.
5. File the fix with the failing CI command and observed runtime log excerpt.

## Missing observability

If the project adds crash reporting, product analytics, or release notifications, link the dashboard and alert channel here and update `docs/runbooks.md` with escalation steps.
