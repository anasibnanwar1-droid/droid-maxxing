# Runbooks

These runbooks cover local development and release triage for Droid Control.

## App does not start in Electron development mode

1. Confirm dependencies are installed:
   ```bash
   npm install
   npm ci --prefix sidecar
   ```
2. Confirm Vite is reachable at the URL used by Electron:
   ```bash
   npm run dev
   ```
3. In another terminal, launch Electron:
   ```bash
   npm run electron
   ```
4. If the renderer is blank, set `ELECTRON_START_URL=http://127.0.0.1:1420` in `.env`.
5. Run syntax and build checks:
   ```bash
   npm run electron:check
   npm run sidecar:build
   ```

## Sidecar bridge is unreachable

1. Check that `BRIDGE_PORT` matches the port logged by Electron and sidecar.
2. In development, use `BRIDGE_ALLOW_LOCAL_NO_TOKEN=1` unless you are testing packaged bridge-token behavior.
3. Run sidecar tests and typecheck:
   ```bash
   npm --prefix sidecar run test
   npm run sidecar:typecheck
   ```
4. If a custom sidecar entry is configured, verify `SIDECAR_ENTRY` points to an existing built file.

## Droid CLI cannot be found

1. Run `droid --version` in the same shell that starts the app.
2. If PATH discovery is not reliable, set `DROID_PATH` in `.env` to the absolute CLI path.
3. Remove stale `DROID_PATH` values if the binary was moved.
4. Re-run sidecar environment tests:
   ```bash
   npm --prefix sidecar run test
   ```

## Factory API key problems

1. Prefer the app onboarding flow for key entry.
2. For local debugging, set `FACTORY_API_KEY` in `.env` or the shell.
3. Do not commit keys or paste them into logs.
4. If child processes still lack credentials, inspect sidecar startup logs and confirm the app is passing an explicit key.

## Build or CI failure

1. Reproduce the failing job locally with the same command listed in `.github/workflows/ci.yml`.
2. For broad changes, run:
   ```bash
   npm run docs:check
   npm run format:check
   npm run typecheck
   npm run sidecar:typecheck
   npm run electron:check
   npm run test
   npm --prefix sidecar run test
   npm run build
   ```
3. Check whether generated docs are stale. If so, run `npm run docs:generate` and commit the generated file.
4. Known baseline: lint is non-blocking in CI while the strict lint backlog is being paid down.
