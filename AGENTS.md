# Agent Instructions

This repository contains the Droid Control Electron app, a React frontend, Electron host code, and a Node sidecar that talks to the Factory Droid SDK.

## Fast start

Use Node.js 22.

```bash
npm install
npm ci --prefix sidecar
npm run dev
```

For the full desktop app, run:

```bash
npm run electron
```

## Required validation

Before handing work back, run the checks that match the files you changed. For broad changes, run the full local gate:

```bash
npm run format:check
npm run typecheck
npm run sidecar:typecheck
npm run electron:check
npm run test
npm --prefix sidecar run test
npm run docs:check
npm run build
```

Known baseline: `npm run lint` is present but currently non-blocking in CI because the strict lint backlog predates this guide.

## Project map

- `src/`: React UI, state, hooks, and frontend unit tests
- `electron/`: Electron main process, preload scripts, and development launcher
- `sidecar/src/`: local WebSocket bridge, Droid SDK runtime integration, browser automation runtime, and sidecar tests
- `docs/`: architecture, generated reference, runbooks, and deployment observability notes
- `tools/`: repository maintenance scripts for documentation generation and validation

## Environment variables

Start from `.env.example` when local overrides are needed. Common variables include:

- `ELECTRON_START_URL`: frontend URL used by Electron development mode
- `BRIDGE_PORT`: local sidecar WebSocket port
- `BRIDGE_TOKEN`: local bridge token used by packaged Electron sessions
- `DROID_PATH`: explicit path to the Droid CLI binary
- `FACTORY_API_KEY`: optional Factory API key passed to Droid child processes

Never commit real secrets. Keep them in `.env`, your shell, or the app's secure onboarding flow.

## Documentation upkeep

When package scripts, source environment variables, or onboarding commands change, run:

```bash
npm run docs:generate
npm run docs:check
```

`npm run docs:check` validates that generated docs are current and that AGENTS.md command references still map to real package scripts.
