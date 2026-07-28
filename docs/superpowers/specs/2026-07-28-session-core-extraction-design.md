# Refactor PR 3: Session Core Extraction

## Status

Approved and implemented by PR 3.

## Verified baseline

- Repository source: latest fetched `origin/main`
- Baseline SHA: `eb9aff89948380743b8cea311f93a8eb55f30662`
- Branch: `refactor/session-core-extraction`
- Worktree: `/Users/anas/.codex/worktrees/71aa/droid-control`
- Primary checkout: out of scope and untouched
- Runtime for validation: Node 22
- Focused characterization baseline: 34 passed, 0 failed, 2 approved PR 5
  TODOs
- GitHub issue: #40, `Refactor MissionManager.ts into focused lifecycle
  modules`

The merged characterization suites are the behavioral contract. This PR changes
ownership and test seams, not product behavior.

## Outcome

After this PR:

- `SessionManager.handle()` remains the public protocol command coordinator.
- `DroidRuntime` is injected through one focused Factory runtime interface.
- `SessionRegistry` owns stable application identity, replaceable provider
  identity, live lookup, historical resolution, persisted summary mutation, and
  safe live-session snapshots.
- `SessionLifecycle` owns create, resume, lazy resume, queueing, steering,
  interrupt, close, and live-session construction.
- The temporary private-cast characterization harness is deleted.
- No test casts `SessionManager`, replaces private fields, calls private methods,
  or fabricates private manager state.
- The temporary 3,600-line `SessionManager.ts` exception is deleted.

## Non-goals

This PR does not extract or redesign:

- history, event, permission, or question behavior (PR 4);
- context, compaction, browser, tool, or terminal-event behavior (PR 5);
- either approved PR 5 race fix;
- Mission Control or child-session behavior (PR 6);
- protocols, compatibility aliases, providers, Studio, or product branding.

Calls from the extracted lifecycle into deferred PR owners remain explicit.
They are not compatibility paths and do not duplicate behavior.

## Decision 1: Factory runtime seam

Define the seam beside `DroidRuntime`:

```ts
export type FactorySession = Pick<
  DroidSession,
  | 'sessionId'
  | 'initResult'
  | 'stream'
  | 'interrupt'
  | 'updateSettings'
  | 'enterSpecMode'
  | 'compactSession'
  | 'close'
  | 'onNotification'
  | 'getContextStats'
  | 'forkSession'
  | 'renameSession'
  | 'getRewindInfo'
  | 'executeRewind'
  | 'listTools'
  | 'listSkills'
  | 'listMcpServers'
  | 'listMcpTools'
>;

export interface FactoryRuntime {
  connect(apiKey?: string): void;
  status(): RuntimeStatus;
  startCliLogin(): Promise<void>;
  createSession(options: CreateRuntimeSessionOptions): Promise<FactorySession>;
  loadSession(
    providerSessionId: string,
    handlers?: RuntimeHandlers,
  ): Promise<FactorySession>;
}
```

`DroidRuntime` implements `FactoryRuntime` directly and remains the production
Factory adapter. The deterministic fake implements the same interface. Provider
calls continue directly on the returned session; there is no
`FactoryCoreAdapter`, forwarding class, method-by-method wrapper, or second
runtime implementation.

The structural session type is required because the SDK `DroidSession` class has
private fields that a deterministic fake cannot implement without an assertion.
Only public methods actually consumed by this repository belong to the type.

Runtime ordering remains unchanged: transport connect, handler installation,
initialize/load, and exactly-once transport cleanup on initialization failure.

## Decision 2: explicit composition

`SessionManager` becomes the composition root. Its existing options gain a
nested dependency record used by the production defaults and deterministic
tests:

- `FactoryRuntime`
- the existing history interface required by this PR
- the existing browser interface required by this PR
- local MCP resource creation

Production supplies `DroidRuntime`, `HistoryIndex`, `BrowserSessionManager`, and
the browser MCP server. Tests supply structural fakes. No constructor creates a
real dependency that a test later replaces.

History and browser use structural interfaces over their currently consumed
methods. Do not create pass-through repository or browser wrapper classes before
their planned extraction PRs.

Local MCP resources use a structural `start`/`close` interface. This replaces the
test harness's global `SdkMcpServer.prototype.close` patch with ordinary injected
fake resources.

## Decision 3: deep SessionRegistry

`SessionRegistry<TLive>` owns exactly one primary map keyed by stable
`appSessionId` and one private alias index from current or superseded
`providerSessionId` to `appSessionId`. It is generic only so the identity module
does not own queue, permission, compaction, MCP, or child-session state:

```ts
interface RegisteredSession {
  summary: SessionSummary;
}
```

Its domain interface is:

```ts
class SessionRegistry<TLive extends RegisteredSession> {
  register(liveSession: TLive): void;
  getLive(id: string): TLive | undefined;
  getCanonicalSummary(id: string): SessionSummary | undefined;
  resolveSummary(id: string): SessionSummary | undefined;
  listSummaries(options?: SessionListFilterOptions): SessionSummary[];
  updateSummary(id: string, patch: SessionSummaryPatch): SessionSummary | undefined;
  replaceProvider(
    id: string,
    providerSessionId: string,
    patch?: SessionSummaryPatch,
  ): SessionSummary | undefined;
  unregister(id: string): TLive | undefined;
  liveSessionsSnapshot(): readonly TLive[];
}
```

`LiveSession`, `LiveChildSession`, and their directly owned state types are
exported by `SessionLifecycle`; `SessionManager` constructs
`SessionRegistry<LiveSession>`. Registry never imports Lifecycle, so dependency
direction remains one-way.

Registry constructor dependencies are explicit and narrow:

- `Pick<HistoryIndex, 'syncSummaries' | 'summaryPatches' |
  'hiddenProviderSessionIds'>`;
- the existing ordinary-history and Mission Control summary loaders;
- read-only `projectSummary(summary)` supplied by `SessionManager`;
- `onSummaryUpdated(summary)` for exactly one `session.updated` publication;
- `now()` for deterministic timestamps.

`register()` performs exactly one history sync. Lifecycle does not sync the same
summary again.

### Registry invariants

1. `appSessionId` is the sole live-storage key and never changes.
2. Direct `appSessionId` lookup takes precedence over provider aliases, matching
   current behavior.
3. A current provider ID and every compacted provider alias resolve to one
   stable app ID.
4. Provider identities are assumed unique in valid current state. PR 3 does not
   add collision rejection or new registration failure behavior.
5. `replaceProvider()` is the only provider-identity mutator.
6. Replacement appends and de-duplicates the previous provider ID while
   retaining every older alias.
7. Ordinary summary patches cannot change `appSessionId`, provider identity,
   alias history, `missionId`, or parent identity.
8. `register()` persists the summary but does not emit `session.updated`; create
   and resume retain their different publication traces.
9. `updateSummary()` timestamps, persists, then publishes exactly one
   `session.updated` event.
10. Summaries are merged in this order: ordinary history, Mission Control
    history, then live sessions. Later sources overwrite earlier sources, so
    effective precedence is `live > Mission Control > ordinary history`.
11. Superseded raw provider rows remain hidden from lists.
12. `liveSessionsSnapshot()` returns a copied array so sequential close can
    remove entries without skipping any.

`SessionRegistry` stores and persists canonical summaries. Its constructor
receives a read-only `projectSummary(summary)` collaborator supplied by
`SessionManager`. `resolveSummary()` and `listSummaries()` return projected
copies. Pending-setting overlays are never persisted through `register()`,
`updateSummary()`, or `replaceProvider()` and cannot alter identity fields.
Existing volatile token/context mutations remain with their PR 5 owner, but
they may not write identity fields.

This module passes the deletion test: removing it would redistribute alias
resolution, replacement-chain construction, live/historical precedence,
persistence/event ordering, projection, and safe iteration across many callers.
A `Map` wrapper exposing only `get`, `set`, `delete`, and `values` is explicitly
rejected.

## Decision 4: one concrete SessionLifecycle

Use one concrete class, not an interface plus default implementation:

```ts
class SessionLifecycle {
  create(command: SessionCreateCommand): Promise<void>;
  resume(appSessionId: string): Promise<void>;
  send(appSessionId: string, text: string): Promise<void>;
  sendNow(appSessionId: string, text: string): Promise<void>;
  interrupt(appSessionId: string): Promise<void>;
  settleAfterCompaction(
    appSessionId: string,
    previousLiveSession?: LiveSession,
  ): Promise<void>;
  close(appSessionId: string): Promise<void>;
  closeAll(): Promise<void>;
}
```

`SessionManager.handle()` delegates these commands directly. It does not retain
private create/resume/send/send-now/interrupt/close forwarding methods.

`SessionLifecycle` never imports or receives `SessionManager`. Its dependency
record lists leaf collaborators individually; it is not a generic host object.
The complete dependency surface is:

- `FactoryRuntime` and `SessionRegistry<LiveSession>`;
- `ensureConnected()` for the existing implicit create/resume connection;
- `getFactoryDefaults()` and `maxContextTokensForModel()`;
- `startLocalMcpServers()`, `makePermissionHandler()`, and
  `makeAskUserHandler()`;
- `compactionLimit()`, `enableDaemonAutoCompaction()`, and
  `subscribeSessionCompaction()`;
- `childSessionLinks()` for cold-resume seeding;
- `applyPendingSettingsToSummary()` for ephemeral cold-resume compaction
  selection and publication; the canonical summary is registered unchanged;
- `applyPendingSessionSettings()` before send queue decisions;
- `runPrimaryTurn()` for one provider stream, design-tool policy, event
  normalization, and context start/stop/refresh;
- standalone `refreshContext()` for cold and already-live resume;
- `onTurnSettledWhileAutoCompacting()` for the current PR 5 watchdog behavior;
- `stopContextPolling()`, `clearAutoCompactionWatchdog()`,
  `clearSessionRuntimeCaches()`, and `closeBrowserSession()` for cleanup;
- `emit`, `emitError`, `emitStatus`, and `emitSessionList`.

These are named functions over existing owners, not a
`SessionManagerLifecycleHost`. Pure create/resume classification and default
selection (`createAutonomyForCommand`, model/agent default selection,
`classifySession`, and phase derivation) move to the existing
`sessionHelpers.ts`; no one-function helper modules are added.

Lifecycle owns streaming flags and queue drain around `runPrimaryTurn()`.
`runPrimaryTurn()` cannot inspect or mutate `pendingSends`, call another
lifecycle command, or retain a reference to Lifecycle.

The lifecycle owns:

- create/resume orchestration and live-session construction;
- lazy resume before send;
- pending-send state and FIFO ordinary sends;
- newest-first steering priority;
- streaming/compacting queue decisions;
- user interrupt semantics;
- close ordering and exactly-once registry removal;
- safe sequential close of every live session.

One-turn event normalization, context collection, design-tool policy, and
auto-compaction settlement remain named leaf callbacks to their current owners.
The lifecycle owns the surrounding streaming state and queue drain so the core
send state machine is not left in `SessionManager`.

### Required ordering

Create preserves:

1. implicit connect events when needed;
2. defaults and MCP startup;
3. Factory create;
4. best-effort daemon compaction arm;
5. live-session construction and notification subscription;
6. registry registration and history sync;
7. `session.created`;
8. fire-and-forget opening turn.

The opening turn must not become awaited. The create handlers continue to
capture a mutable reference whose app ID is assigned only after Factory returns.
Create failure closes every partially started MCP resource exactly once and
publishes no success or false summary.

Resume preserves:

1. stable app/current provider resolution;
2. MCP startup and Factory load;
3. classification and compaction arm;
4. live construction and subscription;
5. persisted child-link seeding;
6. registry registration and history sync;
7. `session.created`;
8. `session.updated`;
9. optional `mission.features`;
10. asynchronous context refresh.

The already-live fast path remains distinct: emit one `session.created` using
the existing summary, schedule one context refresh, and return. It does not
start MCP resources, call Factory load, persist again, emit `session.updated`,
or emit `mission.features`.

Send preserves:

- pending settings apply before the queue decision;
- streaming remains true through post-turn context refresh;
- ordinary sends append FIFO;
- one queued send drains after settlement and recursively chains the rest;
- lazy resume loads once and delivers the prompt once.

Send-now preserves:

- the prompt is unshifted before status/interrupt;
- a live streaming turn is interrupted once;
- manual or automatic compaction is never interrupted;
- an interrupt failure leaves the steering prompt queued;
- multiple steering prompts remain newest-first.

Interrupt preserves:

- queued sends clear first;
- manual compaction is never interrupted;
- idle Stop still calls the provider interrupt;
- the auto-compaction flag/watchdog clear only after interrupt succeeds;
- current interrupt errors continue to propagate.

Close preserves:

- poller, watchdog, subscription, child, MCP, provider, and browser cleanup
  occurs while the registry entry still exists;
- cleanup errors remain best-effort;
- registry removal occurs after resource cleanup;
- `sessions.list` emits after removal.

`closeAll()` snapshots live sessions and closes them sequentially. Manager
shutdown then calls browser `closeAll`, followed by history `close`.

Primary close coordination now joins overlapping closes, lets an explicit close
discard a recovery-preserved queue, and suppresses late primary-turn effects.
The separate late child-turn watchdog/poller unwind remains an explicit PR 5
TODO.

## Decision 5: compaction and child integration

Manual and automatic compaction orchestration stays with its current PR 5
owner. Child-session orchestration stays with its PR 6 owner.

Those paths use `SessionRegistry.getLive()`, `replaceProvider()`, and
`liveSessionsSnapshot()` directly. There is no second session map and no
`findSession`/`findSessionKey` forwarding wrapper.

Both primary compaction paths hand queue settlement to
`SessionLifecycle.settleAfterCompaction()`:

- the manual command passes the pre-compaction live object so Lifecycle can
  recover prompts if permanent provider-adoption failure removed it;
- the automatic-compaction host invokes the same method after its existing
  primary state transition;
- Lifecycle alone shifts the primary queue, patches its count, starts the next
  turn, or sequentially re-delivers orphaned prompts through lazy resume.

Primary queue mutation and driving therefore exist in one module. The automatic
compaction module retains compaction state transitions; child queue settlement
remains with the current PR 6 owner and does not move into Registry.

Successful provider adoption retains its current order: load replacement,
subscribe, re-arm settings, reset design-tool state, close old provider, record
carryover, then replace/persist/publish provider identity. The registry does not
publish a successfully adopted provider identity before the replacement is
usable.

Permanent adoption failure is a separate, required path because the daemon has
already invalidated the old provider:

1. retry replacement load once;
2. persist/publish the daemon's authoritative new provider ID and alias chain;
3. clean and unregister the stale live session;
4. restore the usage carryover after cleanup;
5. emit the current recoverable reload error;
6. let `settleAfterCompaction()` sequentially re-deliver detached queued prompts,
   causing one lazy resume and one delivery per prompt.

Do not collapse this exceptional path into the successful-adoption ordering.

## Test migration

Delete:

- `sidecar/src/testing/sessionCharacterizationHarness.ts`;
- its private `SessionManager` cast and dependency replacement;
- its SDK prototype patch;
- duplicate tests whose observable behavior is already covered by the merged
  characterization contract.

Keep the characterization suites exercising only `handle()`, `shutdown()`,
events, provider/history/browser calls, persisted effects, and resource cleanup.
Replace fixture assembly with one thin public-dependency test context backed by
focused reusable fakes:

- `FakeFactoryRuntime` and `FakeFactorySession`;
- existing fake history and browser implementations;
- deterministic local MCP resources;
- deterministic time/stream gates where behavior requires them.

Do not create another 400-line all-purpose harness. Test helpers expose
observable calls, events, gates, and cleanup records, not manager state.

Add focused public-interface tests:

### SessionRegistry

- app/current/old-provider lookup;
- multiple provider replacements with stable app identity;
- same-provider no-op;
- historical resolution and live-over-historical precedence;
- ordinary summary updates preserving identity;
- historical provider replacement;
- unregister through any identity;
- mutation-safe live snapshots and list ordering/filtering.

### SessionLifecycle

- create/resume publication traces;
- create-failure resource cleanup;
- lazy resume delivers once;
- FIFO sends and newest-first steering;
- no steering interrupt during either compaction state;
- send-now interrupt rejection leaves the steering prompt queued and emits the
  existing failure;
- idle/streaming/compacting Stop behavior;
- ordinary interrupt rejection leaves auto-compaction/watchdog state intact;
- already-live resume takes its resource-free fast path;
- close cleanup before registry removal/list publication;
- close-all snapshot behavior.

Migrate the existing private-cast test clusters as follows:

- identity and historical precedence to Registry tests;
- child membership and link status only through public history/child commands;
- send, abort, idle Stop, design policy, and terminal cases through public
  lifecycle or command paths;
- shared compaction-policy cases to `compaction.test.ts`;
- exported automatic-compaction transitions to
  `sessionAutoCompaction.test.ts`;
- provider swap, recovery, redelivery, worker-key, and token-routing integration
  to the public characterization suites.

Do not make private manager methods public to save old tests. Repository-wide
search, not just deletion of the temporary harness, is the acceptance proof.

## Production module and line budgets

- `DroidRuntime.ts`: interface plus existing adapter; no wrapper file.
- `SessionRegistry.ts`: one deep identity/summary module, target under 400 lines.
- `SessionLifecycle.ts`: one concrete lifecycle module, target at or below 500
  lines. If readable orchestration remains above 500 after pure helpers move to
  `sessionHelpers.ts`, the same diff must contain an explicit justification and
  pass an additional adversarial review; compressed code or shallow helper
  fragments are not acceptable.
  - Implementation exception: the final module is 543 lines after review fixes.
    The 43-line overage keeps post-open resource ownership, overlapping-close
    coordination, and queued-send disposition in the lifecycle that owns those
    transitions. Moving them would split one state machine or create shallow
    cleanup fragments. Additional adversarial reviews found and drove fixes for
    compaction-recovery redelivery, failed-registration ownership, overlapping
    closes, post-close turn effects, and failed turn-setup recovery; each
    corrected path has regression coverage.
- `SessionManager.ts`: below the repository's default 3,500-line limit.
- No other new production file above 500 lines.
- Prefer existing helpers over new one-function modules.

The dependency direction is:

```text
SessionManager
  -> FactoryRuntime
  -> SessionRegistry<LiveSession>
  -> SessionLifecycle
  -> existing deferred PR owners

SessionLifecycle
  -> FactoryRuntime
  -> SessionRegistry<LiveSession>
  -> named leaf collaborators

SessionRegistry
  -> history summary source/sink
  -> session.updated sink
  -> deterministic clock
```

`SessionRegistry` never imports `SessionLifecycle`; neither extracted module
imports `SessionManager`; circular dependencies are forbidden.

## Commit sequence

1. `docs(refactor): design session core extraction`
2. `refactor(sidecar): introduce the Factory runtime seam`
3. `refactor(sidecar): extract the session registry`
4. `refactor(sidecar): extract the session lifecycle`
5. `test(sidecar): replace private SessionManager test seams`
6. `refactor(sidecar): remove SessionManager size exception`
7. `docs(refactor): document session core modules`

Each implementation commit gets its focused typecheck and tests before the next
commit. Adjusting file movement inside a commit is allowed only when TypeScript
dependency order requires it; do not combine unrelated purposes.

The approved design commit also updates the PR 1 deletion criterion from
`FactoryCoreAdapter`/`SessionService` to
`DroidRuntime`/`FactoryRuntime`/`SessionLifecycle`.

## Review gates

Reject the implementation if any review finds:

- a second live-session map;
- surviving manager `findSession` or `findSessionKey` forwarding wrappers;
- manager lifecycle forwarding methods outside `handle()`;
- a forwarding Factory adapter;
- `ISessionLifecycle` plus a default implementation;
- a registry that is only a `Map` wrapper;
- lifecycle importing or receiving `SessionManager`;
- compatibility aliases, fallbacks, or dual behavior;
- type assertions used to satisfy the new seams;
- private manager access from tests;
- PR 4/5/6 behavior changes mixed into this PR;
- a new production file above 500 lines without the explicit Lifecycle
  justification and extra review defined above;
- duplicated behavior introduced only to make extraction easier.

Run an independent simplicity/architecture review after Registry, after
Lifecycle, and against the final diff. Actionable findings are fixed before the
next gate.

## Validation

Run every command under Node 22. The login shell currently resolves Node 26, so
bare `node` or `npm` commands are not accepted. Assert the pinned runtime first:

```bash
mise x node@22 -- node -e \
  "if (Number(process.versions.node.split('.')[0]) !== 22) process.exit(1)"
mise x node@22 -- node --version
```

Before the first production commit, capture the full lint and strict-TypeScript
outputs and counts as the live baseline. Keep those artifacts uncommitted. Every
touched/new TypeScript file must also pass targeted ESLint as a blocking check.

Focused:

```bash
mise x node@22 -- node --import tsx --test sidecar/src/DroidRuntime.test.ts
mise x node@22 -- node --import tsx --test sidecar/src/SessionRegistry.test.ts
mise x node@22 -- node --import tsx --test \
  sidecar/src/SessionLifecycle.test.ts \
  sidecar/src/SessionManager.sessionLifecycle.test.ts
mise x node@22 -- node --import tsx --test \
  sidecar/src/compaction.test.ts \
  sidecar/src/sessionAutoCompaction.test.ts \
  sidecar/src/SessionManager.compactionLifecycle.test.ts
mise x node@22 -- npm --prefix sidecar run test
```

Required full gate:

```bash
mise x node@22 -- npm run format:check
mise x node@22 -- npm run typecheck
mise x node@22 -- npm run sidecar:typecheck
mise x node@22 -- npm run electron:check
mise x node@22 -- npm run test
mise x node@22 -- npm --prefix sidecar run test
mise x node@22 -- npm run docs:check
mise x node@22 -- npm run build
```

Additional PR 3 gates:

```bash
mise x node@22 -- npm run test:coverage
mise x node@22 -- npm --prefix sidecar run test:coverage
mise x node@22 -- npm run test:integration
mise x node@22 -- npm run quality:file-size
mise x node@22 -- npm run quality:tech-debt
mise x node@22 -- npm run quality:boundaries
mise x node@22 -- npm run quality:deps
mise x node@22 -- npm run quality:deadcode
mise x node@22 -- npm run quality:duplicates
mise x node@22 -- npm run security:audit-report
mise x node@22 -- npm run lint
mise x node@22 -- npm run typecheck:strict
mise x node@22 -- npm run sidecar:typecheck:strict
git diff --name-only --diff-filter=ACMR origin/main -- "*.ts" "*.tsx" |
  xargs mise x node@22 -- npx eslint
```

Full strict/lint outputs and diagnostic counts are diffed against the captured
live baseline because repository debt is non-blocking. Targeted ESLint on
touched/new files must run with their explicit paths and return zero findings.

Proof searches:

```bash
rg -n \
  "sessionCharacterizationHarness|createSessionCharacterizationHarness|SessionCharacterizationHarness|privateManager" \
  sidecar/src
rg -n \
  "(manager|readyManager|privateManager)[[:space:]]+as[[:space:]]+unknown[[:space:]]+as|internals[[:space:]]*=[[:space:]]*manager|Reflect\\.(get|set)\\([[:space:]]*manager|Object\\.(assign|defineProperty)\\([[:space:]]*manager|manager\\[['\\\"](runtime|history|sessions|browsers|cachedModels)" \
  sidecar/src \
  -g "*.test.ts" \
  -g "testing/**/*.ts"
rg -n "as unknown as" \
  sidecar/src \
  -g "SessionManager*.test.ts" \
  -g "SessionLifecycle*.test.ts" \
  -g "SessionRegistry*.test.ts" \
  -g "testing/**/*.ts"
rg -n "sidecar/src/SessionManager\\.ts" \
  tools/check-file-size.mjs
wc -l \
  sidecar/src/SessionManager.ts \
  sidecar/src/SessionRegistry.ts \
  sidecar/src/SessionLifecycle.ts
```

The four searches must return no matches. Review any unrelated private-access
pattern found by broader test searches rather than suppressing it. The
authenticated Droid smoke remains opt-in and is not run because it consumes
provider usage.

## Handoff

Before handoff:

- run the complete validation above;
- perform an adversarial final review and fix actionable findings;
- report every created module and its responsibility;
- report final line counts;
- report harness/private-cast and size-exception deletion proofs;
- push `refactor/session-core-extraction`;
- open a pull request against `main`;
- preserve this worktree for review fixes;
- do not merge.
