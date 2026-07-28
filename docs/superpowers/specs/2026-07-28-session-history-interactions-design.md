# Refactor PR 4: Session History and Interactions

## Status

Draft for approval. This is an uncommitted, documentation-only specification.
Implementation must not begin until this document is approved.

## Verified baseline

- Repository source: fetched `origin/main`
- Baseline and merge SHA:
  `3ece34c91f86539436f34582a371b89a0620ce22`
- Merged prerequisite: PR #61, Refactor PR 3 session-core extraction
- Completed sequence: PRs #58, #60, and #61
- Branch: `refactor/session-history-interactions`
- Dedicated worktree: `/Users/anas/.codex/worktrees/8de3/droid-control`
- Primary checkout: out of scope and untouched
- Runtime for implementation validation: Node 22
- Authenticated Factory/Droid smoke: opt-in only and excluded without explicit
  approval

The merged characterization suites remain the behavioral contract. PR 4 changes
ownership without defining new shutdown semantics, renaming protocol messages,
or otherwise redesigning application-visible behavior.

## Outcome

PR 4 extracts three concrete modules:

1. `SessionTimeline` owns high-level transcript recording, outward live
   transcript emission, history listing, stable-identity restore, initial
   replacement, older-page prepend, legacy provider-page loading, child
   transcript replay, restore telemetry, and recoverable history failures.
2. `SessionInteractions` owns Factory permission and structured-question
   callbacks, request correlation, outcome normalization, equivalent-signature
   grants, Spec-to-Auto transition ordering, at-most-once response settlement,
   and interaction-state forgetting at the existing Registry unregister
   boundary.
3. `SessionEventFlow` owns stream and notification normalization, per-source
   terminal gating, post-terminal transcript quarantine, transcript-before-
   side-effect ordering, and forwarding of the remaining non-transcript side
   effects to their current owners.

`SessionManager.handle()` remains the public command coordinator.
`SessionRegistry` remains the only owner of top-level live identity and summary
resolution. `SessionLifecycle` remains the owner of create, resume, send,
interrupt, and close orchestration.

## Non-goals

PR 4 does not:

- extract, redesign, or fix compaction behavior;
- fix the deferred active-child model retune race;
- fix the deferred late child-turn watchdog/poller unwind race;
- extract context meters, context polling, browser or native-browser behavior,
  tool catalogs, MCP catalogs, or related cleanup;
- extract Mission Control lifecycle, child-session lifecycle, child membership,
  child navigation, or child presentation;
- register child sessions in `SessionRegistry`;
- define shutdown semantics for unresolved permission or question callbacks;
- settle, cancel, or emit new events for unresolved interactions because a
  top-level or child session is closing;
- special-case permission or question callbacks that arrive while close is in
  progress;
- rename commands, events, identities, or protocol fields;
- change renderer code;
- add DROIDEX rebranding, Design Studio work, or T3 Core integration;
- add compatibility layers, migration shims, forwarding Manager wrappers,
  legacy aliases, or dual implementations; or
- run the authenticated Electron/Droid smoke or otherwise consume Factory/Droid
  usage without explicit approval.

`appSessionId` remains the stable outward identity. `providerSessionId` remains
the replaceable Factory identity. “Mission” remains reserved for real AGI
Mission Control.

## Current ownership map

### SessionManager

`SessionManager` currently owns all three PR 4 areas:

| Current member | Current responsibility | PR 4 destination |
| --- | --- | --- |
| `statusSeq` | Unique live status transcript IDs | `SessionTimeline` |
| `listHistory()` | Raw provider history listing and list error | `SessionTimeline.list()` |
| `emitSessionHistory()` | `session.history` shape and restore telemetry | `SessionTimeline` private emit |
| `loadSessionHistory()` | Stable identity resolution, restore, paging, empty/failure behavior | `SessionTimeline.load()` |
| `loadStandardSessionHistory()` | Plain chat/spec compaction-chain restore | `SessionTimeline` private loader |
| `loadHistoryPage()` | Legacy provider-page loading | `SessionTimeline.loadProviderPage()` |
| `emitChildSessionHistory()` | Best-effort child transcript replay | `SessionTimeline.replayChild()` |
| `emitTranscript()` | Persist then emit one live transcript | `SessionTimeline.append()` |
| `emitStatus()` | Build and append a status transcript | `SessionTimeline.appendStatus()` |
| `makePermissionHandler()` | Factory permission callback | `SessionInteractions.makePermissionHandler()` |
| `makeAskUserHandler()` | Factory structured-question callback | `SessionInteractions.makeAskUserHandler()` |
| `resolvePermission()` | Approval correlation and settlement | `SessionInteractions.respondToApproval()` |
| `prepareSpecExitForRun()` | Spec-to-Auto transition | `SessionInteractions` private transition |
| `resolveQuestion()` | Question correlation and settlement | `SessionInteractions.respondToQuestion()` |
| `applyEvent()` | Stream normalization entry | `SessionEventFlow.applyStreamEvent()` |
| `applyNormalizedForSource()` | Terminal gating and side-effect preservation | `SessionEventFlow` |
| `applyNormalized()` transcript branch | Live transcript application | `SessionEventFlow` + `SessionTimeline` |
| `applyNormalized()` remaining branches | Mission, child, token, and context effects | Remains in `SessionManager` as `applyEventSideEffects()` |
| post-terminal helper constants/functions | Generated-transcript quarantine policy | `SessionEventFlow` |

`withLiveChildSessionStatus()` remains in `SessionManager`. It is parent/child
run-state projection, not generic history policy. `SessionTimeline` receives
one named `getChildSessionLinks(appSessionId)` collaborator that returns the
already-projected links.

### SessionLifecycle

`SessionLifecycle` currently:

- receives Manager callbacks that create permission and ask-user handlers;
- clears `terminalSources` before a primary turn;
- closes resources without explicitly settling unresolved interactions, which
  PR 4 preserves; and
- constructs `LiveSession` with permission, question, grant, and terminal
  collections.

PR 4 preserves Lifecycle orchestration. It adds narrow interaction and
event-state forgetting collaborators at successful Registry unregister and
removes state that moves to the new owners.

### SessionRegistry

`SessionRegistry` already owns:

- direct app identity lookup before provider-alias lookup;
- current and superseded provider identity resolution;
- canonical live/historical summary resolution;
- live-over-Mission-Control-over-ordinary summary precedence; and
- persisted summary mutation and publication.

PR 4 uses these public operations directly. It does not add another identity
map, change alias precedence, or add forwarding lookup methods.

### Low-level history

`history.ts` and `HistoryIndex` continue to own file/SQLite mechanics:

- Factory session discovery and transcript parsing;
- Mission Control hydration;
- compaction-chain resolution and windowing;
- raw page loading;
- summary, child-link, and transcript-index persistence; and
- the SQLite resource lifetime.

`SessionTimeline` is the high-level application policy above those mechanics.
It does not duplicate parsers, cursors, SQL, or chain construction.

## Decision 1: one deep SessionTimeline

Use one concrete class:

```ts
class SessionTimeline {
  list(): void;
  load(appSessionIdOrProviderSessionId: string, cursor?: string): void;
  loadProviderPage(providerSessionId: string, cursor?: string, limit?: number): void;
  replayChild(appSessionId: string, childProviderSessionId: string): void;
  append(event: TranscriptEvent): void;
  appendStatus(
    appSessionId: string,
    text: string,
    compactType?: CompactType,
    sourceSessionId?: string,
    role?: SessionRole,
  ): void;
}
```

Its dependencies are explicit:

- a read-only Registry view with `resolveSummary()` and `getLive()`;
- `HistoryIndex.recordEvent()`;
- the existing leaf loaders `loadSessionHistory()`, `loadSessionPage()`,
  `hydrateHistoricalSession()`, `resolveSessionChain()`, and
  `loadSessionTranscriptWindow()`;
- `getChildSessionLinks(appSessionId)` for Manager-owned live child status
  projection;
- `emit(event)`; and
- `emitError(error)`.

It never imports or receives `SessionManager`.

### Canonical transcript path

`SessionTimeline.append()` is the only live transcript append path:

1. call `HistoryIndex.recordEvent(event)`;
2. after persistence returns, emit exactly one
   `{ type: 'event.appended', event }`.

Every live transcript producer uses it: stream/notification events, manual and
automatic compaction statuses, Lifecycle statuses, child task statuses, and
best-effort child transcript replay.

History-page restore intentionally has different outward semantics. It records
every replayed event through the Timeline's single private `record()` primitive,
then emits one `session.history` page. It must not emit one `event.appended` per
parent restore event. This preserves replace/prepend behavior and prevents a
restored transcript from being appended twice in the renderer.

`replayChild()` retains its current live-append semantics: load the newest raw
child page, then call `append()` for each event in order. A child whose provider
file is not yet flushed remains a silent best-effort miss.

### Restore identity and ordering

`load(requestedId, cursor)`:

1. resolves the requested app/current/old provider identity through
   `SessionRegistry.resolveSummary()`;
2. uses the canonical `appSessionId` outward and the current
   `providerSessionId` for plain history reads;
3. uses Mission Control hydration only when
   `summary.sessionPurpose === 'mission-control'`;
4. rebinds every restored transcript to the stable `appSessionId`;
5. records the restored transcripts in chronological page order;
6. emits an older cursor request as `mode: 'prepend'` with empty progress and
   without replacing child links;
7. emits an initial request as `mode: 'replace'` with progress and projected
   child links; and
8. derives `loadedCount` from that page's transcript length and `hasMore` from
   `Boolean(olderCursor)`.

Plain chat/spec restore retains the exact chain:

```text
resolveSessionChain(appSessionId, currentProviderSessionId)
  -> loadSessionTranscriptWindow(appSessionId, chain, { cursor })
```

No cursor translation, alternative page store, or second chain resolver is
introduced.

### Failure behavior

The current three failure paths remain distinct:

- An older-page failure emits an empty `prepend` page with no next cursor so the
  renderer clears its loading flag. It emits no additional history error.
- An initial restore failure for a currently live top-level session emits an
  authoritative empty `replace` page, including current child links, with
  `loadedCount: 0` and `hasMore: false`.
- An initial restore failure for a non-live session emits one
  `session.history.error` and one recoverable generic error carrying the stable
  app identity and resolved provider identity. A later retry remains allowed.

Registry identity resolution remains outside the restore/page loader `try`
boundary, exactly as it is today. PR 4 does not silently convert a Registry
summary-loading failure into one of the three history-loader outcomes. A
`recordEvent()` failure remains inside the loader boundary and prevents the page
from being emitted after a partial recording attempt.

The legacy `history.page` command retains its current event shape: it resolves
identity, records the raw page events, and emits `session.history` without
inventing `mode`, restore telemetry, or child links. Its failure remains the
current non-recoverable generic error.

This module is deep: deleting it would redistribute identity resolution,
chain/page selection, replace/prepend policy, replay recording, restore
telemetry, failure settlement, child replay, and record-before-emit ordering.

## Decision 2: one deep SessionInteractions

Use one concrete class:

```ts
class SessionInteractions {
  makePermissionHandler(ref: { id: string }): PermissionHandler;
  makeAskUserHandler(ref: { id: string }): AskUserHandler;
  respondToApproval(
    appSessionId: string,
    requestId: string,
    outcome: string,
  ): Promise<void>;
  respondToQuestion(
    appSessionId: string,
    requestId: string,
    cancelled: boolean,
    answers: { index: number; question: string; answer: string }[],
  ): void;
  forgetSession(appSessionId: string): void;
}
```

Its dependencies are:

- `getLiveSession(id)` returning the current summary and Factory session;
- `updateSummary(id, patch)` through `SessionRegistry`;
- `emit(event)`; and
- `emitError(error)`.

It never receives `SessionManager`, `SessionLifecycle`, or a generic host
object.

### State ownership

Move these collections out of `LiveSession` and into `SessionInteractions`,
keyed first by stable `appSessionId`:

- pending permission requests;
- pending structured questions; and
- equivalent permission-signature grants.

Each pending approval stores its resolver, classified permission kind, and
optional signature. Each pending question stores only its resolver. The module
deletes a request from its map before any async transition or callback
settlement. Deletion is the ownership claim that makes duplicate and concurrent
responses at-most-once.

Grants live only for the lifetime of the top-level live session, as they do
today. `forgetSession()` discards them only after Lifecycle unregisters the live
session. Resume creates a fresh interaction scope; no new persistence is added.

### Permission callback

The Factory callback preserves this order:

1. create the current request identity;
2. classify the request and compute its permission signature;
3. if the live scope already grants the equivalent signature, resolve
   immediately with normalized `ProceedAlways` and emit no request;
4. otherwise store the pending resolver when the top-level session is live;
5. for proposal/run-start permission kinds, publish the current summary phase
   and proposal update; and
6. emit exactly one `approval.requested`.

Signature grants apply only when:

- the pending request has a non-empty signature; and
- the submitted outcome normalizes to the SDK's exact `ProceedAlways`.

No broader tool-name, permission-kind, or session-wide grant is introduced.

### Approval response

`respondToApproval()`:

1. resolves the live interaction scope and exact request identity;
2. does nothing for an unknown, duplicate, late, or wrong-session response;
3. removes the request before normalization;
4. normalizes the outcome;
5. on an invalid outcome, emits `permission.invalid_outcome` and substitutes
   canonical Cancel;
6. records an equivalent-signature grant only for valid ProceedAlways;
7. for an approved Spec exit, performs the exact transition below; and
8. resolves the Factory callback once.

The Spec transition preserves the current trace:

1. Registry update to `interactionMode: 'auto'`, `phase: 'running'`;
2. resulting outward `session.updated`;
3. Factory `updateSettings({ interactionMode: DroidInteractionMode.Auto })`;
4. on provider rejection, `spec.exit_failed`;
5. Factory permission callback settlement.

Provider rejection does not convert an approved permission to cancellation and
does not reorder callback settlement ahead of the provider update attempt.

### Structured questions

The ask-user callback:

- normalizes omitted `questions` to `[]`;
- normalizes omitted options on each question to `[]`;
- stores the resolver only for a live top-level session;
- preserves each question index and text; and
- emits exactly one `question.requested`.

`respondToQuestion()` removes the exact pending request before resolving it.
Unknown, duplicate, late, wrong-session, answer-after-cancel, and
cancel-after-answer responses do nothing.

### Unregister forgetting

`SessionLifecycle` calls `SessionInteractions.forgetSession(appSessionId)` only
after `SessionRegistry.unregister(appSessionId)` successfully removes the live
session.

`forgetSession()` deletes the module-owned pending-permission,
pending-question, and signature-grant collections for that stable app identity.
It does not:

- invoke a pending permission resolver;
- invoke a pending question resolver;
- normalize or synthesize a cancellation outcome;
- emit a protocol event; or
- run before or during provider-resource close.

This matches the current observable interaction lifetime. While the live
session remains registered, callbacks and responses follow the existing paths
even if close is in progress. Once Registry unregisters the session, public
responses can no longer resolve it; the extracted module forgets the now-
unreachable state at that same boundary.

Failed-open cleanup forgets interaction state only if it actually unregisters a
previously registered live session. Shutdown inherits the same behavior through
`SessionLifecycle.closeAll()`.

### Explicitly deferred shutdown semantics

PR 1 states: “This PR does not define new shutdown semantics for unresolved
permission or question callbacks.”

PR 4 preserves that boundary. It neither resolves nor cancels unresolved
provider callbacks during close, and it does not special-case callbacks arriving
while close is in progress. Any future deterministic settlement policy requires
its own behavioral design, characterization, and approval; it is not silently
introduced by this ownership extraction.

This module is deep: deleting it would redistribute request creation,
normalization, correlation, grants, Spec transition ordering, race ownership,
and state lifetime across provider setup, command handling, and Registry
unregister.

## Decision 3: one focused SessionEventFlow

Use one concrete class:

```ts
class SessionEventFlow {
  beginTurn(appSessionId: string, sourceProviderSessionId: string): void;
  applyStreamEvent(
    appSessionId: string,
    sourceProviderSessionId: string,
    role: SessionRole,
    event: DroidStreamEvent,
  ): void;
  applyNotification(
    appSessionId: string,
    sourceProviderSessionId: string,
    role: SessionRole,
    notification: Record<string, unknown>,
  ): void;
  forgetSession(appSessionId: string): void;
}
```

Its dependencies are only:

- `SessionTimeline.append()`; and
- `applySideEffects(appSessionId, sourceProviderSessionId, sideEffects)`.

It never receives `SessionManager`, Registry, Lifecycle, or a broad callback
record. `applySideEffects` is one explicit boundary for the coupled PR 5/6
behavior described below.

### State and flow

Move `terminalSources` out of `LiveSession` into a
`Map<appSessionId, Set<sourceProviderSessionId>>` owned by EventFlow.

`beginTurn()` clears only the producing source's terminal marker. Primary and
child turn drivers call it before consuming their new stream.
`forgetSession()` deletes the top-level set only at the same successful Registry
unregister boundary as interaction-state forgetting.

Both stream events and non-compaction child notifications converge on one
private normalized-event path:

1. normalize the input with the existing functions in `normalize.ts`;
2. ignore `null` normalized events;
3. when `done` is first observed, mark only that source terminal and return;
4. after terminal, remove only non-error `text`, `thinking`, `tool_call`, and
   `tool_result` transcripts;
5. continue applying child, Mission Control, token, and other non-transcript
   side effects from the same normalized event;
6. for an accepted transcript, call `SessionTimeline.append()` before any other
   side effect from that normalized event; and
7. pass only the remaining non-transcript fields to `applySideEffects()`.

Error transcripts are never quarantined. Terminal state is scoped by stable app
identity plus producing source, so one primary or worker result cannot suppress
another worker. The next turn for that same source is accepted after
`beginTurn()`.

### Deliberately retained Manager ownership

`SessionManager.applyEventSideEffects()` retains:

- Mission Control feature and progress events;
- Mission Control state-to-phase projection;
- Mission Control child lifecycle events;
- generic Factory Task child discovery/completion and child-link persistence;
- token offsets and primary-versus-worker context rules;
- context estimate emission;
- child close-when-idle behavior; and
- any compaction-specific notification handling.

Those branches share Mission Control/child policy with PR 6 or
context/compaction policy with PR 5. Moving them now would require a wide
callback interface or would violate the exclusions.

`SessionEventFlow` is not an EventEmitter wrapper. It owns normalization ingress,
two-channel convergence, terminal state, source gating, transcript quarantine,
and transcript-before-side-effect ordering. The one side-effect callback is the
explicit boundary that keeps coupled later-PR behavior out of this PR.

## Composition and call flow

`SessionManager` constructs modules in this order:

```text
SessionRegistry
  -> SessionTimeline
  -> SessionInteractions
  -> SessionEventFlow
  -> SessionLifecycle
```

The dependency direction is:

```text
SessionManager
  -> SessionRegistry
  -> SessionTimeline
  -> SessionInteractions
  -> SessionEventFlow
  -> SessionLifecycle

SessionTimeline
  -> read-only Registry identity view
  -> low-level history loaders/index
  -> protocol sink

SessionInteractions
  -> Registry lookup/update functions
  -> Factory session updateSettings
  -> protocol sink

SessionEventFlow
  -> SessionTimeline.append
  -> Manager-owned non-transcript side-effect function

SessionLifecycle
  -> existing dependencies
  -> interaction handler factories
  -> interaction/event-flow unregister-forgetting callbacks
```

No extracted module imports another module that depends on it. No extracted
module imports `SessionManager`. No second top-level live-session map is added.

### Public command flow

`SessionManager.handle()` delegates directly:

| Command | Direct owner |
| --- | --- |
| `approval.respond` | `SessionInteractions.respondToApproval()` |
| `question.respond` | `SessionInteractions.respondToQuestion()` |
| `history.list` | `SessionTimeline.list()` |
| `history.page` | `SessionTimeline.loadProviderPage()` |
| `session.loadHistory` | `SessionTimeline.load()` |

There are no surviving private Manager methods with those behaviors.

### Provider setup flow

Lifecycle create/resume and Manager child-open receive handlers directly from
`SessionInteractions`. The existing mutable create reference is retained so the
stable app ID is assigned only after Factory create succeeds.

### Turn flow

Primary:

```text
SessionLifecycle drive
  -> SessionManager.runPrimaryTurn
  -> SessionEventFlow.beginTurn(app, app)
  -> stream
  -> SessionEventFlow.applyStreamEvent
  -> SessionTimeline.append accepted transcript
  -> SessionManager.applyEventSideEffects
```

Child:

```text
SessionManager.driveChildSession
  -> SessionEventFlow.beginTurn(app, child runtime provider)
  -> stream or notification
  -> SessionEventFlow
  -> same transcript and side-effect path
```

Compaction notifications remain intercepted before general notification
normalization.

### Close flow

Top-level close preserves the existing cleanup order. Neither extracted state
owner runs before or during provider-resource close:

1. mark close mode and pending-send disposition in Lifecycle;
2. stop pollers and watchdogs;
3. unsubscribe and close child resources;
4. close MCP resources and the primary provider;
5. close browser resources and clear runtime caches;
6. call `SessionRegistry.unregister(appSessionId)`;
7. only when unregister returns the removed live session, call
   `SessionInteractions.forgetSession(appSessionId)` and
   `SessionEventFlow.forgetSession(appSessionId)`; and
8. emit the refreshed session list.

Forgetting is synchronous, idempotent, protocol-silent, and does not invoke
provider callbacks. Existing best-effort resource cleanup and overlapping-close
joining remain unchanged.

## Exact state movement

| State | Before PR 4 | After PR 4 |
| --- | --- | --- |
| Top-level live identity and summaries | `SessionRegistry` | Unchanged |
| Pending sends/streaming/close coordination | `LiveSession` + `SessionLifecycle` | Unchanged |
| Pending permissions | `LiveSession.pendingPermissions` | `SessionInteractions` |
| Pending questions | `LiveSession.pendingQuestions` | `SessionInteractions` |
| Always-grant signatures | `LiveSession.permissionGrants` | `SessionInteractions` |
| Per-source terminal markers | `LiveSession.terminalSources` | `SessionEventFlow` |
| Status transcript sequence | `SessionManager.statusSeq` | `SessionTimeline` |
| Compaction/watchdog/context/browser state | `SessionManager` | Unchanged for PR 5 |
| Child membership/runtime state | `LiveSession` + `SessionManager` | Unchanged for PR 6 |

`LiveSession` loses only the four PR 4 collections. It remains the Lifecycle
runtime object; PR 4 does not split or relocate the remaining child, queue,
compaction, MCP, or provider resource fields.

## Exact method movement

Implementation is rejected if movement leaves forwarding duplicates.

| From `SessionManager` | To |
| --- | --- |
| `listHistory` | `SessionTimeline.list` |
| `emitSessionHistory` | private `SessionTimeline.emitHistory` |
| `loadSessionHistory` | `SessionTimeline.load` |
| `loadStandardSessionHistory` | private `SessionTimeline.loadStandard` |
| `loadHistoryPage` | `SessionTimeline.loadProviderPage` |
| `emitChildSessionHistory` | `SessionTimeline.replayChild` |
| `emitTranscript` | `SessionTimeline.append` |
| `emitStatus` | `SessionTimeline.appendStatus` |
| `makePermissionHandler` | `SessionInteractions.makePermissionHandler` |
| `makeAskUserHandler` | `SessionInteractions.makeAskUserHandler` |
| `resolvePermission` | `SessionInteractions.respondToApproval` |
| `prepareSpecExitForRun` | private `SessionInteractions.prepareSpecExitForRun` |
| `resolveQuestion` | `SessionInteractions.respondToQuestion` |
| `applyEvent` | `SessionEventFlow.applyStreamEvent` |
| `applyNormalizedForSource` | private `SessionEventFlow.applyNormalized` |
| live transcript branch of `applyNormalized` | `SessionEventFlow` -> `SessionTimeline.append` |
| remaining `applyNormalized` branches | renamed Manager `applyEventSideEffects` |
| `isPostTerminalGeneration` | private `SessionEventFlow` helper |
| `hasNormalizedSideEffects` | private `SessionEventFlow` helper |

The existing `normalize.ts`, `permissionOutcomes.ts`, and low-level `history.ts`
remain focused leaf modules. PR 4 reuses them rather than duplicating their pure
logic.

## Test matrix

All assertions remain observable: protocol events, provider calls/results,
history calls, Registry publication, and cleanup. Tests do not inspect private
maps or cast Manager internals.

### SessionTimeline focused tests

| ID | Required proof |
| --- | --- |
| T1 | `append()` records before emitting exactly one `event.appended`. |
| T2 | Initial plain restore resolves an old/current provider alias to one stable app identity, records events in page order, and emits exact replace telemetry. |
| T3 | Initial Mission Control restore selects Mission hydration and preserves progress, child links, cursor, stable identity, and chronology. |
| T4 | Older restore emits prepend, excludes initial-only progress/child links, and preserves cursor, loadedCount, and hasMore. |
| T5 | Older failure emits an empty terminal prepend page and no false error. |
| T6 | Empty live restore emits an empty replace page and no false error. |
| T7 | Non-live failure emits one history error plus one recoverable stable/provider error, and retry can later succeed. |
| T8 | Legacy provider-page loading preserves its current shape, limit, identity, recording order, and error behavior. |
| T9 | Child replay appends each event through the canonical live path and silently tolerates an unflushed provider file. |
| T10 | Status appends have unique IDs and preserve compact type, source, and role. |
| T11 | History listing preserves ordering from the loader and emits the current generic error on failure. |

### SessionInteractions focused tests

| ID | Required proof |
| --- | --- |
| I1 | Permission request uses stable app identity, exact correlation, and one request event. |
| I2 | Equivalent ProceedAlways bypasses only an identical later signature; non-equivalent signatures still request approval. |
| I3 | Invalid outcome emits `permission.invalid_outcome`, settles Cancel once, and creates no grant. |
| I4 | Unknown, duplicate, late, and wrong-session approval responses do nothing. |
| I5 | Spec approval trace is Registry publish, provider mode update attempt, then callback settlement; provider failure emits the current error before settlement. |
| I6 | Ask-user normalizes omitted questions/options while preserving question identities and answers. |
| I7 | Answer/cancel, duplicate, late, and wrong-session question responses settle at most once. |
| I8 | `forgetSession()` is protocol-silent, invokes no pending resolver, and discards module-owned state only after the live session is unregistered. |

### SessionEventFlow focused tests

| ID | Required proof |
| --- | --- |
| F1 | Stream normalization records/emits an accepted transcript before applying its non-transcript side effects. |
| F2 | Notification normalization converges on the same ordering and gating path. |
| F3 | A terminal result drops later non-error generated transcript from only that source. |
| F4 | Post-terminal error transcripts and non-transcript child/Mission/token side effects still flow. |
| F5 | A terminal primary does not gate a worker; a terminal worker does not gate another worker. |
| F6 | `beginTurn()` reopens only the requested source for its next turn. |
| F7 | Forgetting an unregistered app session clears only its terminal state and leaves another app session unchanged. |

### Retained characterization and integration tests

| Existing ID/suite | Required proof |
| --- | --- |
| P1-P4 | Permission identity, grants, invalid/duplicate handling, and Spec transition remain unchanged. |
| Q1 | Answer and cancellation correlation remains unchanged. |
| H1-H2 | Initial restore, pagination, empty live restore, failure, and retry remain unchanged. |
| `SessionManager.eventFlow.test.ts` | Design policy, source-scoped terminal behavior, child notifications, token/context scoping, and loaded-child runtime identity remain unchanged. |
| `SessionLifecycle.test.ts` | Create/resume handler wiring and close ownership ordering remain unchanged; interaction/event state is forgotten only after successful Registry unregister, with no callback settlement or added event. |
| `SessionManager.historyAndChildren.test.ts` A1-A3 | Child link, open/replay, send/steer/interrupt behavior remains unchanged. |
| Compaction characterization | Every status transcript and event ordering remains unchanged; neither deferred race is fixed. |

P1-P4, Q1, H1-H2, and the relevant event-flow cases remain public
`SessionManager.handle()` characterizations. Focused module tests supplement
them; they do not replace the application-boundary contract.

## Temporary seams and deletion criteria

No temporary compatibility seam, adapter, forwarding method, duplicate state,
or dual path is planned or permitted.

TypeScript movement may require a forwarding call while a single implementation
commit is being edited locally, but no such forwarding symbol may survive that
commit. The deletion proof is:

- no moved private Manager method remains;
- no Manager `make*`, `resolve*`, `load*`, `emitTranscript`, or `applyEvent`
  wrapper merely delegates to a new module;
- no interaction or terminal collection remains on `LiveSession`;
- `HistoryIndex.recordEvent` has no production caller outside
  `SessionTimeline`; and
- every live `event.appended` transcript is emitted only by
  `SessionTimeline.append`.

If implementation discovers that `SessionEventFlow` needs more than the one
non-transcript side-effect callback, stop and revise this specification. Do not
introduce a generic host object. If the module cannot stay deep under that
constraint, keep the coupled event application in Manager and extract only
Timeline and Interactions after renewed approval.

## Production module and line budgets

- `SessionTimeline.ts`: target at or below 300 lines.
- `SessionInteractions.ts`: target at or below 260 lines.
- `SessionEventFlow.ts`: target at or below 220 lines.
- No new production file above 350 lines.
- `SessionManager.ts` must shrink materially from the 2,923-line baseline.
- `SessionLifecycle.ts` must not grow except for the narrow unregister-
  forgetting collaborators and removal of moved state.

Line targets are review heuristics, not invitations to compress readable code.
Prefer direct control flow and existing helpers. Do not create interface/default
class pairs, one-function files, or a shared “services” bag.

## Small commit sequence

1. `docs(refactor): design session history and interactions`
   - Commit this approved specification only.

2. `refactor(sidecar): extract the session timeline`
   - Add `SessionTimeline` and its focused tests.
   - Move all history commands, replay, live transcript append, and status
     append ownership in the same commit.
   - Keep P1/H1-H2, child replay, compaction status, and sidecar typecheck green.

3. `refactor(sidecar): extract session interactions`
   - Add `SessionInteractions` and focused tests.
   - Move interaction state out of `LiveSession`.
   - Delegate public approval/question commands and provider handlers directly.
   - Forget module-owned state only after successful Registry unregister,
     without settling callbacks or emitting events.

4. `refactor(sidecar): extract generic session event flow`
   - Add `SessionEventFlow` and focused tests.
   - Move terminal state out of `LiveSession`.
   - Converge primary stream, child stream, and non-compaction notification
     ingress without moving PR 5/6 side effects.

5. `test(sidecar): lock PR 4 integration boundaries`
   - Strengthen record-before-emit, Spec transition trace, unregister
     forgetting, and source-scoped terminal characterizations where focused
     tests alone do not prove Manager composition.
   - Remove any redundant structural tests, not behavioral coverage.

6. `docs(refactor): document timeline and interaction ownership`
   - Update `docs/architecture.md` and any directly stale ownership wording.
   - Do not edit renderer/product documentation unrelated to the extraction.

Each implementation commit runs its focused tests, targeted ESLint, and regular
sidecar typecheck before the next commit.

## Adversarial review gates

Reject implementation if any review finds:

- a second top-level live-session or summary map;
- a second transcript persistence/emission path;
- parent restore replayed as both `session.history` and `event.appended`;
- changed replace/prepend, cursor, loadedCount, hasMore, or failure behavior;
- direct app/provider identity resolution outside Registry;
- permission grants broader than an equivalent signature;
- a pending request deleted after rather than before async settlement work;
- a response path capable of settling one callback twice;
- Spec callback settlement before the provider mode update attempt;
- interaction state forgotten before Registry successfully unregisters the live
  session;
- `forgetSession()` invoking a pending resolver, synthesizing cancellation, or
  emitting a protocol event;
- any new permission/question behavior based on close being in progress;
- any deterministic shutdown settlement policy for unresolved interactions;
- terminal gating shared across sources or app sessions;
- terminal state cleared before provider ingress is shut down;
- post-terminal gating that drops non-transcript side effects or error
  transcripts;
- Mission Control/child lifecycle, token/context, compaction, browser, or tool
  policy moved into a generic host interface;
- `SessionEventFlow` reduced to an EventEmitter wrapper;
- a moved Manager forwarding method;
- an extracted module importing or receiving `SessionManager`;
- compatibility aliases, fallback paths, adapters, or dual behavior;
- private Manager casts or replacement test harnesses;
- protocol or renderer changes not required to preserve the verified contract;
  or
- either deferred PR 5 race changed or “fixed”.

Perform an adversarial simplicity/architecture review after Timeline, after
Interactions/unregister forgetting, after EventFlow, and against the final diff.
Actionable findings are fixed before the next gate.

## Validation

Run every implementation command under Node 22:

```bash
mise x node@22 -- node -e \
  "if (Number(process.versions.node.split('.')[0]) !== 22) process.exit(1)"
mise x node@22 -- node --version
```

Focused PR 4 suites:

```bash
mise x node@22 -- node --import tsx --test \
  sidecar/src/SessionTimeline.test.ts \
  sidecar/src/SessionManager.historyAndChildren.test.ts
mise x node@22 -- node --import tsx --test \
  sidecar/src/SessionInteractions.test.ts \
  sidecar/src/SessionManager.interactions.test.ts \
  sidecar/src/SessionLifecycle.test.ts
mise x node@22 -- node --import tsx --test \
  sidecar/src/SessionEventFlow.test.ts \
  sidecar/src/SessionManager.eventFlow.test.ts
mise x node@22 -- node --import tsx --test \
  sidecar/src/SessionManager.compactionLifecycle.test.ts \
  sidecar/src/SessionManager.sessionLifecycle.test.ts
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

Additional refactor gates:

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
```

Capture live lint and strict-TypeScript outputs before the first production
commit. Existing repository debt remains non-blocking, but touched/new
TypeScript files must pass targeted ESLint with zero findings and introduce no
new strict diagnostics.

Proof searches:

```bash
rg -n \
  "\\b(listHistory|emitSessionHistory|loadSessionHistory|loadStandardSessionHistory|loadHistoryPage|emitChildSessionHistory|emitTranscript|emitStatus|makePermissionHandler|makeAskUserHandler|resolvePermission|prepareSpecExitForRun|resolveQuestion|applyEvent|applyNormalizedForSource)\\(" \
  sidecar/src/SessionManager.ts
rg -n \
  "pendingPermissions|pendingQuestions|permissionGrants|terminalSources" \
  sidecar/src/SessionLifecycle.ts
rg -n "\\.recordEvent\\(" sidecar/src -g "*.ts" -g "!*.test.ts"
rg -n "emit\\(\\{ type: 'event.appended'" sidecar/src -g "*.ts" -g "!*.test.ts"
rg -n \
  "as unknown as|Reflect\\.(get|set)\\([[:space:]]*manager|Object\\.(assign|defineProperty)\\([[:space:]]*manager" \
  sidecar/src \
  -g "*.test.ts" \
  -g "testing/**/*.ts"
wc -l \
  sidecar/src/SessionManager.ts \
  sidecar/src/SessionLifecycle.ts \
  sidecar/src/SessionTimeline.ts \
  sidecar/src/SessionInteractions.ts \
  sidecar/src/SessionEventFlow.ts
```

The first, second, and private-access searches return no matches. The transcript
recording and outward-emission call-site searches each identify only
`SessionTimeline`. Review broader results rather than suppressing them.

Do not run the authenticated Droid smoke without explicit approval.

## Handoff

Before implementation handoff:

- run the complete validation above under Node 22;
- perform the final adversarial review and fix every actionable finding;
- report module responsibilities and final line counts;
- report transcript-path, moved-method, state-movement, and private-access proof
  searches;
- report P1-P4, Q1, H1-H2, event-flow, child, compaction, and full-gate results;
- push `refactor/session-history-interactions`;
- open a pull request against `main`;
- preserve this worktree for review fixes; and
- do not merge.
