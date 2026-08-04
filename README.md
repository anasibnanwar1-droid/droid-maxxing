# DROIDEX

DROIDEX is a macOS desktop workspace for Factory Droid. It keeps chats,
projects, terminals, browser sessions, and agent work together in one app.

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

DROIDEX checks a signed Sparkle feed for new versions. When an update is
available, the app shows an update button. Downloading and installation begin
only after the user clicks, and installation always requires approval.

Official macOS downloads and first-launch instructions live in the
[public releases repository](https://github.com/anasibnanwar1-droid/droidex-releases).

## More documentation

- Architecture overview: `docs/architecture.md`
- Command reference: `docs/generated/project-reference.md`
- Runbooks: `docs/runbooks.md`
- Release checklist: `docs/deployment-observability.md`
- Engineering instructions: `AGENTS.md`
