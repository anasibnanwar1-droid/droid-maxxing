# GitHub CLI Recovery Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a production-safe Context-panel recovery card that installs GitHub CLI through an existing Homebrew installation or guides the user to the official installer, then completes GitHub CLI browser authentication and restores PR features.

**Architecture:** `electron/github.cjs` remains the only owner of GitHub CLI/Homebrew discovery, installation, authentication processes, and cleanup. Narrow IPC contracts expose availability and two setup operations; a renderer hook owns the repository-scoped async lifecycle, while a small Context-panel component renders the current state and `usePullRequest` remains the sole owner of PR data.

**Tech Stack:** Electron IPC/preload, Node.js `execFile`/`spawn`, React 19 hooks, TypeScript discriminated unions, Tailwind/DROIDEX design tokens, Node test runner, React server rendering tests.

## Global Constraints

- Scope is the currently shipped macOS application and GitHub.com repositories.
- Never install Homebrew, run a remote shell script, use `sudo`, bundle GitHub CLI, or implement DROIDEX-owned OAuth.
- Never collect, parse, persist, log, or send a GitHub token to the renderer.
- Installation and authentication begin only after an explicit user click.
- Execute only resolved absolute executables with closed argument vectors; never execute either operation through a shell.
- Accept only the exact authentication URL `https://github.com/login/device` before opening a browser.
- Keep local git commit and push behavior unchanged; gate only GitHub-dependent PR behavior.
- Preserve the app ID, updater feed, persistence schema, release asset names, and Sparkle metadata.
- Keep all work in `/Users/anas/Documents/droid-control-hotfix-v1.1.1` on `hotfix/v1.1.1-production-integrations`.
- Do not push, open a PR, merge, tag, or release without explicit user approval; Cubic review is required after a PR exists.

---

## File map

- `electron/github.cjs`: resolve Homebrew, serialize setup operations, install `gh`, drive browser/device authentication, verify completion, and clean up child processes.
- `electron/github.test.cjs`: production-boundary tests for executable selection, fixed arguments, URL allowlisting, concurrency, verification, timeout, and cleanup.
- `electron/main.cjs`: authorize and register setup IPC; pass the safe external opener; cancel setup work during renderer/app teardown.
- `electron/mainRegression.test.cjs`: prove privileged GitHub handlers authorize the main renderer and teardown calls the GitHub process owner.
- `electron/preload.cjs` and `electron/preload.test.cjs`: expose and verify the closed renderer API.
- `src/types/vcs.ts`: canonical discriminated contracts for availability and setup results.
- `src/lib/desktop.ts`: type the new preload methods.
- `src/lib/github.ts` and `src/lib/githubSetupContract.test.ts`: renderer-safe wrappers and transport-failure behavior.
- `src/hooks/useGithubSetup.ts` and `src/hooks/useGithubSetup.test.ts`: own repository-scoped probe/action state and stale-result rejection.
- `src/components/environment/GithubSetupCard.tsx` and `GithubSetupCard.test.ts`: render the compact, accessible recovery states.
- `src/components/RightPanel.tsx`: compose GitHub setup before PR detection and enable PR polling only when ready.
- `src/components/environment/EnvironmentSection.tsx`: place the setup card at the PR boundary and hide stale PR context while unavailable.
- `src/components/environment/GitActionsBar.tsx`: keep commit/push unchanged and gate only Open PR.
- `src/components/RightPanel.test.ts`: prove the integrated Context-panel behavior.
- `README.md`: document that GitHub PR features self-diagnose, use Homebrew only when present, and authenticate through GitHub CLI.

---

### Task 1: Electron-owned GitHub CLI setup service

**Files:**
- Modify: `electron/github.cjs:1-93, 391-403`
- Test: `electron/github.test.cjs:1-108`

**Interfaces:**
- Consumes: existing `resolveGhExecutable(options)`, `runFile(file, args, options)`, and cached GitHub CLI discovery.
- Produces: `available()`, `install()`, `authenticate(openExternal)`, `cancelSetup()`, and exported test seams `resolveBrewExecutable(options)` and `isGithubDeviceUrl(value)`.

- [ ] **Step 1: Write failing Homebrew discovery and installation tests**

Add tests that inject filesystem/process seams and assert both standard architectures, the fixed install command, miss-cache invalidation, verification, and busy behavior:

```js
test('resolves Apple Silicon Homebrew under a Finder-style PATH', async () => {
  const executable = await resolveBrewExecutable({
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/zsh' },
    access: async (candidate) => {
      if (candidate !== '/opt/homebrew/bin/brew') throw new Error('missing');
    },
    runFile: async (file, args) => {
      assert.equal(file, '/opt/homebrew/bin/brew');
      assert.deepEqual(args, ['--version']);
      return ghResult({ stdout: 'Homebrew 4.6.0' });
    },
  });
  assert.equal(executable, '/opt/homebrew/bin/brew');
});

test('installs gh with a fixed Homebrew argument vector and verifies gh', async () => {
  const calls = [];
  const result = await install({
    resolveBrew: async () => '/opt/homebrew/bin/brew',
    execute: async (file, args) => {
      calls.push([file, args]);
      return ghResult();
    },
    resolveGh: async () => '/opt/homebrew/bin/gh',
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [['/opt/homebrew/bin/brew', ['install', 'gh']]]);
});
```

Also assert `{ ok: false, reason: 'installer_missing', message: 'Homebrew is not installed.' }`, `install_failed`, `verification_failed`, `timeout`, and `busy` results without exposing raw stderr.

- [ ] **Step 2: Run the Electron GitHub tests and confirm the new tests fail**

Run: `rtk node --test electron/github.test.cjs`

Expected: FAIL because `resolveBrewExecutable` and `install` are not exported.

- [ ] **Step 3: Implement Homebrew resolution and serialized installation**

Add `COMMON_BREW_PATHS`, a cached resolver using the existing executable-validation rules, and one authoritative active setup process. The production contract is:

```js
const COMMON_BREW_PATHS = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];
const INSTALL_TIMEOUT = 10 * 60 * 1000;

async function install(options = {}) {
  if (activeSetup) {
    return { ok: false, reason: 'busy', message: 'GitHub setup is already running.' };
  }
  const operation = { kind: 'install', cancelled: false, child: null };
  activeSetup = operation;
  const resolveBrew = options.resolveBrew || cachedBrewExecutable;
  const execute = options.execute || runSetupFile;
  const resolveGh = options.resolveGh || resolveGhExecutable;
  try {
    const brew = await resolveBrew();
    if (!brew) {
      return { ok: false, reason: 'installer_missing', message: 'Homebrew is not installed.' };
    }
    const result = await execute(brew, ['install', 'gh'], {
      timeout: INSTALL_TIMEOUT,
      operation,
    });
    if (operation.cancelled) {
      return { ok: false, reason: 'cancelled', message: 'GitHub CLI installation was cancelled.' };
    }
    if (result.timedOut) {
      return { ok: false, reason: 'timeout', message: 'GitHub CLI installation timed out.' };
    }
    if (result.code !== 0) {
      return { ok: false, reason: 'install_failed', message: 'Homebrew could not install GitHub CLI.' };
    }
    cachedGhExecutablePromise = undefined;
    if (!(await resolveGh())) {
      return { ok: false, reason: 'verification_failed', message: 'GitHub CLI was not found after installation.' };
    }
    return { ok: true };
  } finally {
    if (activeSetup === operation) activeSetup = null;
  }
}
```

Implement `runSetupFile` with `spawn(file, args, { stdio: ['ignore', 'ignore', 'ignore'] })`. Assign the child to `operation.child`, settle once on `error`, `close`, or timeout, kill it on timeout, and clear the timer/listeners before resolving `{ code, timedOut }`. `cancelSetup()` sets `operation.cancelled = true` and kills `operation.child` when present. Keep the injected `execute` seam for deterministic tests.

- [ ] **Step 4: Write failing browser-authentication tests**

Add a deterministic fake child process with `stdout`, `stderr`, `close`, and `error` events. Assert:

```js
test('browser authentication uses fixed arguments and opens only the GitHub device URL', async () => {
  const opened = [];
  const child = fakeChild();
  const pending = authenticate(async (url) => opened.push(url), {
    resolveGh: async () => '/opt/homebrew/bin/gh',
    spawnProcess: (file, args, options) => {
      assert.equal(file, '/opt/homebrew/bin/gh');
      assert.deepEqual(args, [
        'auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https',
        '--web', '--clipboard', '--skip-ssh-key',
      ]);
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('Open this URL to continue: https://github.com/login/device\n'));
        child.emit('close', 0, null);
      });
      return child;
    },
    verifyAuth: async () => true,
  });
  assert.deepEqual(await pending, { ok: true });
  assert.deepEqual(opened, ['https://github.com/login/device']);
});
```

Add cases for a split URL across chunks, a hostile origin/path, missing device URL, browser-open rejection, non-zero exit, failed final `gh auth status --hostname github.com`, concurrent setup rejection, timeout, and `cancelSetup()` killing the active child.

- [ ] **Step 5: Run the auth tests and confirm they fail**

Run: `rtk node --test electron/github.test.cjs`

Expected: FAIL because `authenticate`, `cancelSetup`, and `isGithubDeviceUrl` are absent.

- [ ] **Step 6: Implement bounded browser/device authentication**

Implement `isGithubDeviceUrl` with URL parsing and exact origin/path comparison. Use `spawn` with piped output, retain at most 16 KiB needed to find the URL across chunk boundaries, open it once, and settle once on error/close/timeout/cancel. The success gate is:

```js
async function verifyGithubAuth(executable, execute = runFile) {
  const result = await execute(executable, ['auth', 'status', '--hostname', 'github.com'], {
    timeout: DEFAULT_TIMEOUT,
  });
  return result.code === 0;
}
```

Return only fixed `GithubSetupResult` messages. Never return buffered output. Remove listeners and clear timers on every settlement path. Export the production methods and test seams.

- [ ] **Step 7: Run focused tests and commit the service**

Run: `rtk node --test electron/github.test.cjs`

Expected: all GitHub Electron tests pass.

Commit:

```bash
rtk git add electron/github.cjs electron/github.test.cjs
rtk git commit -m "feat(github): install and authenticate CLI"
```

---

### Task 2: Closed IPC and renderer contracts

**Files:**
- Modify: `src/types/vcs.ts:223-227`
- Modify: `src/lib/desktop.ts:20-44, 201-207`
- Modify: `electron/preload.cjs:52-58`
- Test: `electron/preload.test.cjs:1-100`
- Modify: `electron/main.cjs:119-130, 301-318, 610-629`
- Test: `electron/mainRegression.test.cjs:1-55`
- Modify: `src/lib/github.ts:1-65`
- Create: `src/lib/githubSetupContract.test.ts`

**Interfaces:**
- Consumes: Task 1 `available`, `install`, `authenticate`, and `cancelSetup`.
- Produces: `GithubAvailability`, `GithubSetupResult`, `getGithubAvailability()`, `installGithubCli()`, and `authenticateGithubCli()` for Task 3.

- [ ] **Step 1: Write the canonical discriminated TypeScript contracts**

Replace the loose availability interface and add the closed result union:

```ts
export type GithubAvailability =
  | { installed: false; authenticated: false; installMethod: 'homebrew' | 'manual' }
  | { installed: true; authenticated: boolean; installMethod: null };

export type GithubSetupFailureReason =
  | 'busy'
  | 'installer_missing'
  | 'install_failed'
  | 'verification_failed'
  | 'browser_failed'
  | 'auth_failed'
  | 'timeout'
  | 'cancelled'
  | 'not_desktop';

export type GithubSetupResult =
  | { ok: true }
  | { ok: false; reason: GithubSetupFailureReason; message: string };
```

Update `available()` to return `installMethod: null` for installed CLI and resolve Homebrew only for a missing CLI.

- [ ] **Step 2: Write failing preload, authorization, teardown, and renderer-wrapper tests**

Preload assertions:

```js
await api.githubInstall();
await api.githubAuthenticate();
assert.deepEqual(calls[0], { channel: 'github-install', payload: undefined });
assert.deepEqual(calls[1], { channel: 'github-authenticate', payload: undefined });
```

Add `github-available`, `github-install`, and `github-authenticate` to the privileged-handler loop in `mainRegression.test.cjs`; assert `githubVcs.cancelSetup()` appears in renderer replacement and `before-quit` cleanup.

In `githubSetupContract.test.ts`, install a fake `window.droidControl` and assert wrappers preserve success/availability results while transport rejection maps to:

```ts
{
  ok: false,
  reason: 'not_desktop',
  message: 'GitHub setup is available in the desktop app.',
}
```

for a missing desktop bridge, and `auth_failed`/`install_failed` fixed messages for IPC rejection.

- [ ] **Step 3: Run contract tests and confirm they fail**

Run: `rtk node --test electron/preload.test.cjs electron/mainRegression.test.cjs && rtk node --import tsx --test src/lib/githubSetupContract.test.ts`

Expected: FAIL because the new methods and contracts do not exist.

- [ ] **Step 4: Implement authorized IPC, preload methods, cleanup, and renderer wrappers**

Register handlers with the trusted renderer check:

```js
ipcMain.handle('github-available', (event) => {
  assertMainRenderer(event);
  return githubVcs.available();
});
ipcMain.handle('github-install', (event) => {
  assertMainRenderer(event);
  return githubVcs.install();
});
ipcMain.handle('github-authenticate', (event) => {
  assertMainRenderer(event);
  return githubVcs.authenticate(openExternal);
});
```

Expose `githubInstall()` and `githubAuthenticate()` without renderer payloads. Add matching `DroidControlApi` methods. Add `githubVcs.cancelSetup()` to `before-quit` and main-renderer replacement cleanup.

Implement renderer wrappers that call the desktop API, preserve typed results, and translate thrown transport errors to fixed messages without raw Electron errors.

- [ ] **Step 5: Run focused contracts, typecheck, and commit**

Run:

```bash
rtk node --test electron/github.test.cjs electron/preload.test.cjs electron/mainRegression.test.cjs
rtk node --import tsx --test src/lib/githubSetupContract.test.ts
rtk npm run typecheck
rtk npm run electron:check
```

Expected: all commands pass.

Commit:

```bash
rtk git add electron/github.cjs electron/main.cjs electron/mainRegression.test.cjs electron/preload.cjs electron/preload.test.cjs src/types/vcs.ts src/lib/desktop.ts src/lib/github.ts src/lib/githubSetupContract.test.ts
rtk git commit -m "feat(github): expose safe CLI setup controls"
```

---

### Task 3: Repository-scoped GitHub setup controller

**Files:**
- Create: `src/hooks/useGithubSetup.ts`
- Create: `src/hooks/useGithubSetup.test.ts`

**Interfaces:**
- Consumes: Task 2 `getGithubAvailability`, `installGithubCli`, `authenticateGithubCli`, and existing `openExternal`.
- Produces: `useGithubSetup(enabled, repositoryKey)` returning `GithubSetupController`.

- [ ] **Step 1: Write failing reducer/controller-state tests**

Define and test the public state contract:

```ts
export interface GithubSetupController {
  availability: GithubAvailability | null;
  action: 'idle' | 'installing' | 'authenticating';
  error: string | null;
  manualGuideOpened: boolean;
  isReady: boolean;
  refresh: () => void;
  runPrimaryAction: () => void;
}
```

Test the exported pure reducer with request IDs. A stale `probe-finished` event must return the same state object; current results must transition checking to missing/unauthenticated/ready; repository reset must clear availability, error, and `manualGuideOpened`; install/auth failures must return to idle with the fixed message.

Test `primaryActionFor(state)` returns exactly `install`, `check`, `authenticate`, or `none` for each state.

- [ ] **Step 2: Run the hook state tests and confirm they fail**

Run: `rtk node --import tsx --test src/hooks/useGithubSetup.test.ts`

Expected: FAIL because the hook module is absent.

- [ ] **Step 3: Implement the reducer and hook effects**

Use one reducer as the authoritative renderer owner. Increment a request ID before every probe and on repository reset; ignore all result events whose request ID is no longer current.

The primary action dispatch is exactly:

```ts
switch (primaryActionFor(state)) {
  case 'install':
    void runInstall();
    break;
  case 'check':
    refresh();
    break;
  case 'authenticate':
    void runAuthentication();
    break;
  case 'none':
    break;
}
```

For manual installation, call `openExternal('https://github.com/cli/cli#installation')`, mark `manualGuideOpened`, and do not report installation success. Add a `visibilitychange` listener only while manual guide state is active; when `document.hidden` becomes false, call `refresh()`. Remove the listener during state change/unmount.

For Homebrew install and authentication, set the busy state, await the Task 2 wrapper, show a fixed failure on `{ok:false}`, and call `refresh()` on `{ok:true}`. `isReady` is true only for `{ installed: true, authenticated: true, installMethod: null }`.

- [ ] **Step 4: Run focused tests and commit**

Run: `rtk node --import tsx --test src/hooks/useGithubSetup.test.ts && rtk npm run typecheck`

Expected: both commands pass.

Commit:

```bash
rtk git add src/hooks/useGithubSetup.ts src/hooks/useGithubSetup.test.ts
rtk git commit -m "feat(github): own Context setup state"
```

---

### Task 4: Accessible Context recovery card and PR gating

**Files:**
- Create: `src/components/environment/GithubSetupCard.tsx`
- Create: `src/components/environment/GithubSetupCard.test.ts`
- Modify: `src/components/RightPanel.tsx:20-43, 124-160`
- Modify: `src/components/environment/EnvironmentSection.tsx:1-103`
- Modify: `src/components/environment/GitActionsBar.tsx:34-105`
- Test: `src/components/RightPanel.test.ts:30-94`

**Interfaces:**
- Consumes: Task 3 `GithubSetupController` and existing `usePullRequest`/`EnvironmentSection` composition.
- Produces: the discoverable Context-panel recovery UI and ready-only PR integration.

- [ ] **Step 1: Write failing card rendering tests**

Use `renderToStaticMarkup` to test each view. The missing/Homebrew case must contain `GitHub CLI required` and `Install GitHub CLI`; manual-after-open must contain `Check installation`; unauthenticated must contain `Connect GitHub` and `Sign in to GitHub`; busy states must disable the button and contain `Installing…` or `Waiting for GitHub…`; ready/checking must render an empty string.

Assert error markup includes `role="status"` or `aria-live="polite"`, and that the button uses visible text rather than icon-only labeling.

- [ ] **Step 2: Run the card test and confirm it fails**

Run: `rtk node --import tsx --test src/components/environment/GithubSetupCard.test.ts`

Expected: FAIL because `GithubSetupCard` does not exist.

- [ ] **Step 3: Implement the compact card**

Render one bordered surface below the action row using DROIDEX tokens. The component receives:

```ts
export interface GithubSetupCardProps {
  availability: GithubAvailability | null;
  action: 'idle' | 'installing' | 'authenticating';
  error: string | null;
  manualGuideOpened: boolean;
  onPrimaryAction: () => void;
}
```

Use `Github`, `Download`, `ExternalLink`, and `Loader2` Lucide icons at 14-16 px. Keep the title at 12.5 px, explanation/error at 11.5-12 px, and button styling aligned with `GitActionsBar`. Render no card for checking or ready.

- [ ] **Step 4: Write failing RightPanel integration assertions**

Extend the RightPanel render helper with a fake desktop bridge and assert:

- a GitHub repository does not enable PR polling/Open PR until authenticated;
- a missing CLI renders the setup card after the availability promise settles in the reducer-level tests rather than flashing during server render;
- local Commit and Push remain rendered while Open PR is gated; and
- ready state restores Open PR/PR context.

Add a source-contract assertion only where server rendering cannot settle effects: `usePullRequest` must receive `enabled: isGitHub && githubSetup.isReady`, and `EnvironmentSection` must receive the setup controller values.

- [ ] **Step 5: Run the integration test and confirm it fails**

Run: `rtk node --import tsx --test src/components/RightPanel.test.ts`

Expected: FAIL because RightPanel does not compose GitHub setup or gate PR behavior.

- [ ] **Step 6: Integrate the controller without moving PR ownership**

In `RightPanel`, create setup state before `usePullRequest`:

```ts
const isGitHub = !!git.env?.isGitHub;
const githubSetup = useGithubSetup(isGitHub, git.env?.repoRoot ?? cwd);
const pr = usePullRequest(cwd, git.env?.branch ?? null, {
  enabled: isGitHub && githubSetup.isReady,
  active: view === 'pr',
});
```

Pass the setup state/action to `EnvironmentSection`. Place `GithubSetupCard` directly after `GitActionsBar`. Pass `githubReady` separately to `GitActionsBar`; render Open PR only when `isGitHub && githubReady && !hasPr && !env?.detached`. Render the PR row only when `githubReady && pr`.

Keep Commit and Push conditions unchanged. When setup becomes ready, `usePullRequest`'s enabled transition performs the authoritative detection automatically.

- [ ] **Step 7: Run focused UI tests, format, typecheck, and commit**

Run:

```bash
rtk node --import tsx --test src/components/environment/GithubSetupCard.test.ts src/components/RightPanel.test.ts src/hooks/useGithubSetup.test.ts
rtk npm run format:check
rtk npm run typecheck
```

Expected: all commands pass.

Commit:

```bash
rtk git add src/components/environment/GithubSetupCard.tsx src/components/environment/GithubSetupCard.test.ts src/components/RightPanel.tsx src/components/RightPanel.test.ts src/components/environment/EnvironmentSection.tsx src/components/environment/GitActionsBar.tsx
rtk git commit -m "feat(context): recover GitHub CLI setup"
```

---

### Task 5: User documentation and release-grade verification

**Files:**
- Modify: `README.md:7-17`
- Verify: all files changed in Tasks 1-4

**Interfaces:**
- Consumes: the complete Electron-to-renderer feature.
- Produces: discoverable public behavior documentation and a validated local hotfix candidate.

- [ ] **Step 1: Document the GitHub integration behavior**

Add a concise `## GitHub pull requests` section after local run instructions:

```markdown
## GitHub pull requests

For GitHub repositories, the Context panel shows pull requests, checks, and
review comments through GitHub CLI. If `gh` is missing or signed out, DROIDEX
shows the recovery action in Context. It can install `gh` through an existing
Homebrew installation, otherwise it opens GitHub's official installation page,
and authentication always completes in GitHub's browser/device flow.
```

- [ ] **Step 2: Run all required validation**

Run:

```bash
rtk npm run format:check
rtk npm run typecheck
rtk npm run sidecar:typecheck
rtk npm run electron:check
rtk npm run test
rtk npm --prefix sidecar run test
rtk npm run docs:check
rtk npm run build
```

Expected: every command exits zero. `npm run lint` remains non-blocking per repository policy, but inspect every changed-file diagnostic.

- [ ] **Step 3: Review the complete diff for release boundaries**

Run:

```bash
rtk git diff origin/main...HEAD --check
rtk git diff origin/main...HEAD --stat
rtk git status --short --branch
```

Confirm the branch contains no updater, bundle identity, persistence, release asset, secret, generated binary, private prompt, or unrelated main-checkout changes.

- [ ] **Step 4: Build and smoke-test an isolated packaged candidate**

Run the existing arm64 packaging command with release publishing disabled:

```bash
rtk npm run dist:mac:arm64
```

Launch the staged app with a fresh `DROIDEX_USER_DATA_DIR` distinct from the installed app. Verify:

1. Finder-style PATH still finds `/opt/homebrew/bin/gh` or `/usr/local/bin/gh`.
2. A controlled missing-CLI environment renders the inline card without hiding Commit/Push.
3. Homebrew-present installation uses the fixed package and advances to Connect GitHub.
4. Homebrew-absent fallback opens the official installation page and rechecks on return.
5. Sign in copies the device code, opens only `https://github.com/login/device`, and restores PR context after `gh auth status` succeeds.
6. Cancelling/closing the staged app terminates its setup child process.
7. The installed DROIDEX instance and profile remain uninterrupted.

Do not sign out, replace, or mutate the user's existing GitHub CLI account merely to create a negative test. Use injected automated coverage for destructive auth states and report any unavailable manual path as pending.

- [ ] **Step 5: Commit documentation and hand off for review**

Commit:

```bash
rtk git add README.md
rtk git commit -m "docs(github): explain Context recovery"
```

Report focused/full checks, packaged smoke-test results, remaining manual coverage, commit hashes, and clean worktree status. Do not push. When the user later authorizes a push, open the PR and wait for Cubic before recommending merge or release.
