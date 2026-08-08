# Production Integrations Hotfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a production-safe macOS hotfix that finds the user's GitHub CLI, reports notification delivery truthfully, clears all in-app unread chats, and makes manual reports discoverable and verifiably accepted by Sentry.

**Architecture:** Keep each behavior with its existing owner: Electron GitHub integration resolves `gh`, a focused Electron notification module owns native delivery settlement, the root reducer owns read state, and diagnostics owns Sentry envelopes. Renderer changes consume small discriminated results and reuse existing sidebar/settings styling.

**Tech Stack:** Electron CommonJS, Node.js 22, React 19, TypeScript, Tailwind CSS, Node test runner, Sentry envelope APIs.

## Global Constraints

- Work only in `/Users/anas/Documents/droid-control-hotfix-v1.1.1` on `hotfix/v1.1.1-production-integrations` based on `origin/main` `1458290012df142736501361ea2a46df4ff04277`.
- Do not change the app ID, updater feed, release asset names, persistence schema, session identity, or sidecar protocol.
- Add no dependency and no historical-state compatibility path.
- Preserve background-only completion-notification behavior.
- Keep the existing bell; add only an in-app **Mark all as read** action visible in unread mode.
- Do not send authenticated Sentry queries or production test reports.
- Use Node.js 22 and prefix shell commands with `rtk`.

---

### Task 1: Packaged GitHub CLI discovery

**Files:**
- Modify: `electron/github.cjs`
- Modify: `electron/github.test.cjs`

**Interfaces:**
- Produces: `resolveGhExecutable(options?): Promise<string | null>` for one cached, validated executable.
- Produces: existing `gh(cwd, args, options?)` behavior with an absolute executable and unchanged `{ code, stdout, stderr, spawnFailed }` results.
- Consumes: injected `execFile`, filesystem access, PATH, home directory, and login shell only in tests; production defaults use Node APIs.

- [ ] **Step 1: Write failing resolver tests**

Add table-driven tests that inject a fake process environment and executable probe. Assert this order: PATH result, `/opt/homebrew/bin/gh`, `/usr/local/bin/gh`, `/opt/local/bin/gh`, then a fixed login-shell `command -v gh` lookup. Assert invalid/non-executable candidates are skipped and no candidate returns `null`.

```js
test('resolves Homebrew gh under a Finder-style PATH', async () => {
  const calls = [];
  const executable = await resolveGhExecutable({
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/zsh' },
    access: async (candidate) => {
      if (candidate !== '/opt/homebrew/bin/gh') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    runFile: async (file, args) => {
      calls.push([file, args]);
      return file === '/opt/homebrew/bin/gh'
        ? ghResult({ stdout: 'gh version 2.78.0' })
        : ghResult({ code: 1 });
    },
  });
  assert.equal(executable, '/opt/homebrew/bin/gh');
  assert.deepEqual(calls.at(-1), ['/opt/homebrew/bin/gh', ['--version']]);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `rtk mise x node@22 -- node --test electron/github.test.cjs`

Expected: FAIL because `resolveGhExecutable` is not exported.

- [ ] **Step 3: Implement the minimal resolver**

Use `fs.promises.access(candidate, fs.constants.X_OK)`, `path.delimiter`, and a bounded `execFile` wrapper. The shell fallback must execute only `[shell, ['-lc', 'command -v gh']]`; trim and validate its output as another candidate. Cache only a successful production resolution. Make `gh()` return `spawnFailed: true` when resolution returns `null`, then reuse the resolved absolute path for every operation.

- [ ] **Step 4: Run focused GitHub tests and verify GREEN**

Run: `rtk mise x node@22 -- node --test electron/github.test.cjs`

Expected: all GitHub tests pass, including Finder-style PATH discovery.

- [ ] **Step 5: Commit the GitHub slice**

```bash
rtk git add electron/github.cjs electron/github.test.cjs
rtk git commit -m "fix(github): resolve gh in packaged macOS app"
```

### Task 2: Native notification permission and truthful settlement

**Files:**
- Create: `electron/notifications.cjs`
- Create: `electron/notifications.test.cjs`
- Modify: `electron/main.cjs`
- Modify: `electron/preload.cjs`
- Modify: `electron/preload.test.cjs`
- Modify: `src/lib/desktop.ts`
- Modify: `src/components/NotificationsSettings.tsx`
- Create: `src/lib/desktopNotifications.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `showDesktopNotification(NotificationClass, payload): Promise<NotifyResult>`.
- Produces: `NotifyResult = { shown: true } | { shown: false; reason: 'unsupported' | 'permission_denied' | 'failed' | 'timeout'; message?: string }`.
- Produces: `requestNotificationPermission(): Promise<'granted' | 'denied' | 'unsupported'>` in the renderer.
- Consumes: Electron notification constructor, `show`, `failed`, `click`, and `action` events.

- [ ] **Step 1: Read the sidebar/settings style reference before UI edits**

Read `/Users/anas/.codex/skills/frontend-design-consistency/references/style-system.md` completely and preserve the existing compact ghost-button/settings-row visual language.

- [ ] **Step 2: Write failing native notification tests**

Create a deterministic fake Notification class. Test unsupported, synchronous constructor failure, `show`, `failed`, and timeout. Confirm click/action invoke `onActivate` and timers/listeners settle once.

```js
test('resolves shown only after Electron emits show', async () => {
  const pending = showDesktopNotification(FakeNotification, {
    title: 'DROIDEX', body: 'Finished', timeoutMs: 100, onActivate() {},
  });
  FakeNotification.latest.emit('show');
  assert.deepEqual(await pending, { shown: true });
});

test('returns the failed event message instead of claiming success', async () => {
  const pending = showDesktopNotification(FakeNotification, {
    title: 'DROIDEX', body: 'Finished', timeoutMs: 100, onActivate() {},
  });
  FakeNotification.latest.emit('failed', {}, 'Notifications are disabled');
  assert.deepEqual(await pending, {
    shown: false, reason: 'failed', message: 'Notifications are disabled',
  });
});
```

- [ ] **Step 3: Run native tests and verify RED**

Run: `rtk mise x node@22 -- node --test electron/notifications.test.cjs`

Expected: FAIL because the module does not exist.

- [ ] **Step 4: Implement and wire native settlement**

Move only native delivery settlement into `electron/notifications.cjs`. Keep IPC authorization and session-open queue ownership in `electron/main.cjs`; pass `onActivate: () => queueNotificationSessionOpen(appSessionId)`. Await `show`/`failed` with a bounded 5-second timer. Update `package.json` test and `electron:check` scripts to include the new module/test.

- [ ] **Step 5: Write failing renderer contract tests**

Test that `notify()` returns the bridge result, `requestNotificationPermission()` maps absent API to `unsupported`, and denied/granted values pass through. Extend the preload test to prove the notify IPC result is returned unchanged.

```ts
test('requestNotificationPermission returns denied without sending a test banner', async () => {
  const previous = globalThis.Notification;
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value: { permission: 'default', requestPermission: async () => 'denied' },
  });
  try {
    assert.equal(await requestNotificationPermission(), 'denied');
  } finally {
    Object.defineProperty(globalThis, 'Notification', { configurable: true, value: previous });
  }
});
```

- [ ] **Step 6: Run renderer contract tests and verify RED**

Run: `rtk mise x node@22 -- node --import tsx --test src/lib/desktopNotifications.test.ts && rtk mise x node@22 -- node --test electron/preload.test.cjs`

Expected: FAIL because the permission/result contracts do not exist.

- [ ] **Step 7: Implement permission and truthful settings feedback**

Add the discriminated types to `src/lib/desktop.ts`; return `{ shown: false, reason: 'unsupported' }` when no desktop bridge exists. Before enabling the master notification switch and before testing, call `requestNotificationPermission()`. On denied permission, leave the setting disabled and toast: `Notifications are disabled for DROIDEX. Enable them in macOS System Settings.` On test, show success only for `{ shown: true }`; map other reasons to explicit error messages.

- [ ] **Step 8: Run notification tests and verify GREEN**

Run: `rtk mise x node@22 -- node --test electron/notifications.test.cjs electron/preload.test.cjs && rtk mise x node@22 -- node --import tsx --test src/lib/desktopNotifications.test.ts`

Expected: all notification tests pass.

- [ ] **Step 9: Commit the notification slice**

```bash
rtk git add electron/notifications.cjs electron/notifications.test.cjs electron/main.cjs electron/preload.cjs electron/preload.test.cjs src/lib/desktop.ts src/components/NotificationsSettings.tsx src/lib/desktopNotifications.test.ts package.json
rtk git commit -m "fix(notifications): request permission and confirm delivery"
```

### Task 3: In-app Mark all as read

**Files:**
- Modify: `src/hooks/useStore.tsx`
- Modify: `src/hooks/useStore.test.ts`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/Sidebar.test.ts`

**Interfaces:**
- Produces: reducer action `{ type: 'MARK_ALL_SESSIONS_READ'; seenAt: number }`.
- Produces: exported `UnreadFilterActions` presentation component with `unreadOnly`, `unreadCount`, `onToggleUnread`, and `onMarkAllRead` props.
- Consumes: canonical `state.sessions` and `state.sessionLastSeen` only.

- [ ] **Step 1: Write the failing reducer regression test**

Create two current sessions with different `updatedAt` values and one unrelated stale last-seen entry. Dispatch the new action with deterministic `seenAt: 5_000`. Assert current sessions are stamped to `Math.max(seenAt, updatedAt)` and unrelated state remains referentially unchanged.

```ts
const next = reducer(state, { type: 'MARK_ALL_SESSIONS_READ', seenAt: 5_000 });
assert.equal(next.sessionLastSeen['sess-a'], 5_000);
assert.equal(next.sessionLastSeen['sess-b'], 7_000);
assert.equal(next.sessionLastSeen['closed-session'], state.sessionLastSeen['closed-session']);
assert.equal(next.sessions, state.sessions);
```

- [ ] **Step 2: Run the store test and verify RED**

Run: `rtk mise x node@22 -- node --import tsx --test src/hooks/useStore.test.ts`

Expected: FAIL because the action is not part of the reducer.

- [ ] **Step 3: Implement the store operation**

Add the action to `Action`. In one reducer case, clone `sessionLastSeen`, iterate `state.sessionOrder`, skip missing sessions, and write `Math.max(action.seenAt, session.updatedAt)`. Return the unchanged state if no value changes; otherwise return `{ ...state, sessionLastSeen }`. Existing provider persistence remains the only write path.

- [ ] **Step 4: Write failing sidebar presentation tests**

Render `UnreadFilterActions` to static markup. Assert **Mark all as read** appears only when `unreadOnly && unreadCount > 0`, the existing bell label switches between `Show unread only` and `Show all sessions`, and the count remains capped at `9+`.

- [ ] **Step 5: Run sidebar tests and verify RED**

Run: `rtk mise x node@22 -- node --import tsx --test src/components/Sidebar.test.ts`

Expected: FAIL because `UnreadFilterActions` is not exported.

- [ ] **Step 6: Implement the compact in-app action**

Extract only the existing bell chrome into `UnreadFilterActions`. When unread mode is active, render a nearby compact ghost button with text `Mark all as read`. In `Sidebar`, dispatch `{ type: 'MARK_ALL_SESSIONS_READ', seenAt: Date.now() }`, then call `setUnreadOnly(false)`. Preserve all existing bell behavior, tooltip, badge, and colors.

- [ ] **Step 7: Run store/sidebar tests and verify GREEN**

Run: `rtk mise x node@22 -- node --import tsx --test src/hooks/useStore.test.ts src/components/Sidebar.test.ts`

Expected: reducer and discoverability tests pass.

- [ ] **Step 8: Commit the unread slice**

```bash
rtk git add src/hooks/useStore.tsx src/hooks/useStore.test.ts src/components/Sidebar.tsx src/components/Sidebar.test.ts
rtk git commit -m "feat(sidebar): mark all unread chats as read"
```

### Task 4: Verifiable, issue-producing Sentry reports

**Files:**
- Modify: `electron/diagnostics.cjs`
- Modify: `electron/diagnostics.test.cjs`
- Modify: `electron-builder.config.cjs`
- Modify: `electron/builderConfig.test.cjs`
- Modify: `docs/deployment-observability.md`

**Interfaces:**
- Produces: `deliverFeedbackEvent(event, options): Promise<{ eventId: string }>` only for matching Sentry acknowledgments.
- Produces: manual event payload with `level: 'error'` and `exception.values[0]` describing a handled `UserSubmittedReport`.
- Consumes: Sentry envelope response JSON `{ id: string }`, expected DSN host `o4511166732304384.ingest.de.sentry.io`, and project `4511850999185488` for release builds.

- [ ] **Step 1: Write failing acknowledgment and event-shape tests**

Update the success fake to return `{ ok: true, status: 200, json: async () => ({ id: eventId }) }`. Add missing, malformed, and mismatched response-ID cases that reject. Assert the envelope uses `level: 'error'` and:

```js
assert.deepEqual(event.exception, {
  values: [{
    type: 'UserSubmittedReport',
    value: 'update button froze',
    mechanism: { type: 'droidex.feedback', handled: true },
  }],
});
```

- [ ] **Step 2: Run diagnostics tests and verify RED**

Run: `rtk mise x node@22 -- node --test electron/diagnostics.test.cjs`

Expected: FAIL because the response body is ignored and payload remains `info`.

- [ ] **Step 3: Implement strict Sentry acknowledgment**

After `response.ok`, call `response.json()` and require a lowercase 32-hex `id` equal to `event.event_id`; otherwise throw `Sentry did not acknowledge this report. Try again.` Return `{ eventId: acknowledgment.id }`. Build the manual report as a handled error/exception event while retaining the scrubbed message, tags, user, attachments, and existing local `RPT-...` receipt.

- [ ] **Step 4: Write failing release DSN identity tests**

For release and unsigned-release configurations, assert a DSN with another host or project throws an error mentioning the expected public Sentry destination. Keep ordinary development builds able to omit the DSN.

- [ ] **Step 5: Run builder tests and verify RED**

Run: `rtk mise x node@22 -- node --test electron/builderConfig.test.cjs`

Expected: FAIL because release config validates presence only.

- [ ] **Step 6: Implement release DSN validation and truthful docs**

Parse `sentryDsn` with `new URL`. For release/unsigned-release builds require hostname `o4511166732304384.ingest.de.sentry.io` and pathname `/4511850999185488`; throw without printing the key or full DSN. Update deployment docs to say the receipt appears after a matching Sentry acceptance acknowledgment and is not a durable indexing guarantee.

- [ ] **Step 7: Run Sentry tests and verify GREEN**

Run: `rtk mise x node@22 -- node --test electron/diagnostics.test.cjs electron/builderConfig.test.cjs`

Expected: all report delivery and release destination tests pass.

- [ ] **Step 8: Commit the Sentry slice**

```bash
rtk git add electron/diagnostics.cjs electron/diagnostics.test.cjs electron-builder.config.cjs electron/builderConfig.test.cjs docs/deployment-observability.md
rtk git commit -m "fix(diagnostics): verify Sentry report acceptance"
```

### Task 5: Integrated validation and release-safety review

**Files:**
- Modify only files required to fix validation failures caused by Tasks 1-4.

**Interfaces:**
- Consumes: all four independently tested hotfix slices.
- Produces: a clean, locally committed branch with recorded automated and manual validation status.

- [ ] **Step 1: Run formatting and static checks**

Run:

```bash
rtk mise x node@22 -- npm run format:check
rtk mise x node@22 -- npm run typecheck
rtk mise x node@22 -- npm run sidecar:typecheck
rtk mise x node@22 -- npm run electron:check
rtk mise x node@22 -- npm run docs:check
```

Expected: all commands exit 0.

- [ ] **Step 2: Run complete automated tests**

Run:

```bash
rtk mise x node@22 -- npm run test
rtk mise x node@22 -- npm --prefix sidecar run test
```

Expected: all renderer, Electron, and sidecar tests pass.

- [ ] **Step 3: Build the renderer and inspect the diff**

Run:

```bash
rtk mise x node@22 -- npm run build
rtk git diff origin/main...HEAD --check
rtk git status --short --branch
```

Expected: build passes, diff check is clean, and no uncommitted files remain.

- [ ] **Step 4: Perform production-focused manual smoke checks**

Launch the packaged candidate from Finder with a minimal GUI PATH and verify: GitHub PR/check/comment panels use `/opt/homebrew/bin/gh`; first notification use triggers macOS permission and the test button reports the actual result; unread mode exposes and executes **Mark all as read**; feedback retry remains visible for a mismatched acknowledgment. Record DMG upgrade-over-v1.1.0 and updater metadata checks as passed or explicitly pending.

- [ ] **Step 5: Review release-sensitive invariants**

Confirm `appId === 'app.droidex'`, both DMG/ZIP artifact names remain `droidex-${arch}.${ext}`, Sparkle public key/feed remain unchanged, no persistence key changed, and no secrets or report payloads appear in the diff.

- [ ] **Step 6: Commit validation-only fixes if needed**

```bash
rtk git add electron/github.cjs electron/github.test.cjs electron/notifications.cjs electron/notifications.test.cjs electron/main.cjs electron/preload.cjs electron/preload.test.cjs src/lib/desktop.ts src/components/NotificationsSettings.tsx src/lib/desktopNotifications.test.ts src/hooks/useStore.tsx src/hooks/useStore.test.ts src/components/Sidebar.tsx src/components/Sidebar.test.ts electron/diagnostics.cjs electron/diagnostics.test.cjs electron-builder.config.cjs electron/builderConfig.test.cjs docs/deployment-observability.md package.json
rtk git commit -m "fix(hotfix): resolve validation findings"
```

Do not create an empty commit. Do not push, open a PR, tag, merge, or release until the user explicitly authorizes that external action.
