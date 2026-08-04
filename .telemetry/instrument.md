# Sentry instrumentation guide

The canonical implementation is `electron/diagnostics.cjs`.

## Startup order

1. Read the automatic-diagnostics preference. The documented default is enabled.
2. Load or create the locally persisted pseudonymous `USR-…` profile ID.
3. Initialize the Sentry Electron main-process SDK with that ID in
   `initialScope.user.id`.
4. Let the SDK's main-process session integration create one Release Health
   session for the app lifetime.
5. Continue app startup even if diagnostics identity persistence fails; log an
   actionable local error and do not start an anonymous Sentry session.

## Configuration

- Release: `droidex@<app version>`
- Environment: `production` for packaged builds, `development` otherwise
- Default PII: disabled
- Breadcrumbs: disabled
- Performance tracing: disabled
- Product analytics events: none

Do not use `captureMessage` as an analytics `track` substitute. Add a dedicated
analytics destination and update the tracking plan before instrumenting feature
usage.

Automatic crash intake uses the Sentry Electron default integrations. It can
include exception stacks, technical contexts, and native minidumps containing
incidental sensitive process data. Keep the Settings disclosure, disable/reset
control, private-project access restriction, and retention policy aligned with
that behavior.

Preference writes are atomic and corrupt or unreadable existing state fails
closed. Changing the preference relaunches the app; do not close and reinitialize
the Electron SDK in the same process. Manual reports use an ephemeral report ID
instead of recreating persistent profile identity while automatic diagnostics
are disabled.

## Verification

Run `node --test electron/diagnostics.test.cjs`, then verify a packaged build in
the private Sentry project with the `production` environment filter. Confirm the
session includes a `USR-…` user ID and the expected `droidex@<version>` release.
