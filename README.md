# Droid Control

Droid Control is an Electron and React desktop app for running Factory Droid sessions, managing mission workspaces, and connecting the UI to the local Droid sidecar process.

## Prerequisites

- Node.js 22
- npm 10 or newer
- A working Factory Droid CLI installation, or let the app install it during onboarding

## Setup

From a fresh clone, install both app dependency sets and start the Vite dev server:

```bash
npm install && npm ci --prefix sidecar && npm run dev
```

To run the full Electron shell locally:

```bash
npm install && npm ci --prefix sidecar && npm run electron
```

## Common commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the frontend dev server |
| `npm run electron` | Build the sidecar and launch Electron in development mode |
| `npm run build` | Typecheck, build Vite assets, build the sidecar, and syntax-check Electron files |
| `npm run test` | Run frontend unit tests |
| `npm --prefix sidecar run test` | Run sidecar unit tests |
| `npm run typecheck` | Typecheck the frontend and Electron TypeScript project |
| `npm run sidecar:typecheck` | Typecheck the sidecar project |
| `npm run electron:check` | Syntax-check Electron CommonJS entrypoints |
| `npm run format:check` | Verify Prettier formatting |
| `npm run docs:generate` | Regenerate `docs/generated/project-reference.md` |
| `npm run docs:check` | Verify generated docs and AGENTS.md command references are current |

## Environment

Copy `.env.example` to `.env` for local overrides. Most variables are optional because the app defaults to a local sidecar and localhost Vite server.

Secrets such as `FACTORY_API_KEY` should stay in `.env`, shell environment variables, or the app onboarding flow. Do not commit real API keys.

## Architecture and operations

- Architecture overview: `docs/architecture.md`
- Generated command and environment reference: `docs/generated/project-reference.md`
- Runbooks: `docs/runbooks.md`
- Deployment observability checklist: `docs/deployment-observability.md`
- Agent-specific instructions: `AGENTS.md`
