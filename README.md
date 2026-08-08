# DROIDEX

DROIDEX is a macOS desktop workspace for Factory Droid. It keeps chats,
projects, terminals, browser sessions, and agent work together in one app.

Website: [droidex.vercel.app](https://droidex.vercel.app)

## Run it locally

You need Node.js 22, npm, and the Factory Droid CLI. DROIDEX can install the
CLI during onboarding if it is not already available.

Install dependencies and launch the desktop app:

```bash
npm install
npm ci --prefix sidecar
npm run electron
```

For renderer-only development, use:

```bash
npm run dev
```

## GitHub pull requests

For GitHub repositories, the Context panel shows pull requests, checks, and
review comments through GitHub CLI. If `gh` is missing or signed out, DROIDEX
shows the recovery action in Context. It can install `gh` through an existing
Homebrew installation; otherwise it opens GitHub's official installation page.
Authentication always completes through GitHub CLI's browser/device flow. The
Context popover keeps the one-time code visible and copyable until `gh` confirms
the account is connected.

## Useful commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the frontend dev server |
| `npm run electron` | Build the sidecar and launch DROIDEX |
| `npm run build` | Create a production build |
| `npm run test` | Run app and Electron tests |
| `npm --prefix sidecar run test` | Run sidecar unit tests |
| `npm run typecheck` | Check app TypeScript |
| `npm run sidecar:typecheck` | Check sidecar TypeScript |
| `npm run format:check` | Check formatting |

## Updates

DROIDEX checks its signed Sparkle feed for new versions. A blue download button
appears beside Settings only when a newer version is available. Clicking it
opens Sparkle's native update window; nothing downloads or installs until the
user approves it. You can also check manually from the DROIDEX menu.

Official macOS downloads and first-launch instructions live in the
[public releases repository](https://github.com/droidex-anas/droidex-releases).
The permanent website links and tag-controlled publishing flow are documented
in `docs/releasing.md`.

## Privacy and diagnostics

Automatic crash reports and Sentry Release Health are enabled by default in
release builds. They use a random local profile ID and can include crash stacks,
native crash dumps, and technical device/runtime context. Crash material can
contain incidental sensitive data; access belongs only to the private DROIDEX
Sentry project. DROIDEX does not intentionally attach account identity or use
Sentry for feature analytics.

Users can turn automatic diagnostics off under **Settings → Privacy &
diagnostics**. Changing the preference restarts DROIDEX. Disabling it stops
automatic reporting and deletes the local profile ID. `/bug` and `/feedback`
reports are sent only when the user explicitly submits them; while automatic
diagnostics are off, those reports use a non-persisted report-scoped ID.

## More documentation

- Architecture overview: `docs/architecture.md`
- Command reference: `docs/generated/project-reference.md`
- Runbooks: `docs/runbooks.md`
- Team release guide: `docs/releasing.md`
- Release controls and observability: `docs/deployment-observability.md`
- Engineering instructions: `AGENTS.md`
