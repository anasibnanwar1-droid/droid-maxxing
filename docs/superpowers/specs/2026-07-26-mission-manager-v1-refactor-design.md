# Refactor PR 1: SessionManager Characterization Baseline

## Status and scope

This document specifies Refactor PR 1 only: a behavior-preserving characterization baseline for the current `SessionManager` boundary. It does not extract production services, rename the wire protocol, or change runtime behavior.

The canonical `Session*` naming contract is mandatory for Refactor PR 2. Refactor PR 1 tests the current protocol exactly as it exists at the verified baseline so the later hard cut can be reviewed against observable behavior.

The previous title-based Design Studio characterization is excluded. The verified baseline contains no behavior that infers session purpose, mode, or permissions from a `"Design"` title.

## Verified baseline

- Baseline SHA: `14866e759104970b0f39a42d33941c97704c8268`
- Remote: `origin/main` at the same SHA
- Branch: `refactor/mission-manager-baseline`
- Dedicated worktree: `/Users/anas/Documents/droid-control/.worktrees/refactor-mission-manager-baseline`
- Baseline working tree: clean
- Validation runtime: Node 22
- Frontend tests: 292 passed, 0 failed
- Sidecar tests: 167 passed, 0 failed
- Playwright integration: 1 passed, 0 failed
- Frontend coverage: 75.42% lines, 83.96% branches, 71.21% functions
- Sidecar coverage: 85.93% lines, 77.70% branches, 76.33% functions
- Production build, regular typechecks, Electron syntax, formatting, documentation, dependency boundaries, dependency analysis, dead-code budget, duplicate budget, file-size guard, tech-debt guard, flaky reruns, and the security audit command pass.
- Existing non-blocking baseline debt: 1,287 ESLint errors, 212 ESLint warnings, 494 frontend strict-TypeScript diagnostics, and 531 sidecar strict-TypeScript diagnostics.

New and touched files must be locally lint-clean, use strict-friendly TypeScript, and introduce no additional repository diagnostics.

## Assertion boundary

Characterization assertions are limited to:

- emitted protocol events;
- provider/runtime calls and arguments;
- history and browser calls and arguments;
- provider callbacks and their externally observed results;
- persisted mappings visible through history calls;
- resource closure, cancellation, and unsubscription calls; and
- ordering only when it changes emitted events, provider behavior, prompt delivery, or application-visible state.

Tests must not assert private maps, flags, helper selection, method decomposition, or other incidental implementation details.

## A. Session lifecycle, modes, and autonomy

### Target files

- `sidecar/src/testing/sessionCharacterizationHarness.ts`
- `sidecar/src/SessionManager.sessionLifecycle.test.ts`

### Temporary harness contract

`sessionCharacterizationHarness.ts` is the only location permitted to replace private `SessionManager` dependencies. It contains the single private-property cast required to install deterministic fakes and exposes a public test interface for commands, emitted events, provider calls, history calls, browser calls, deferred provider responses, deterministic time, and cleanup records.

All sidecar suites in Sections A through E consume this harness. No individual test may cast `SessionManager`, read private properties, invoke private methods, or construct fabricated private session state. No second dependency-replacement harness is permitted.

The harness is temporary because `SessionManager` has no dependency-injection seam. Its deletion criterion is Refactor PR 3, when `FactoryCoreAdapter`, `SessionService`, `SessionRegistry`, and related session modules expose proper test interfaces.

| ID | Characterization | Observable evidence |
| --- | --- | --- |
| L1 | Ordinary create | The current create command produces one provider-session creation call with `auto`, regular model/reasoning defaults, default autonomy, MCP configuration, and provider handlers. Existing creation/update events use the stable application identity, and the opening prompt reaches the provider once. |
| L2 | Spec create | Provider creation receives `spec` and the current spec model/reasoning fields without AGI worker/validator configuration. Emitted state reports the current spec mode. |
| L3 | Mission Control create | Provider creation receives `agi`, Factory orchestrator classification, and current worker/validator configuration. Existing Mission Control events and summary fields remain unchanged. |
| L4 | Create failure cleanup | When provider creation fails after MCP startup, the MCP resource closes exactly once, no successful creation event is emitted, no false history summary is persisted, and the current error event is emitted. |
| L5 | Resume with split identities | A stable application identity resolves to its persisted provider identity. The provider load call uses the provider identity, subsequent provider calls use the loaded session, and outward events retain the stable application identity. Provider handlers, MCP settings, notification registration, and persisted child links are verified through recorded calls. |
| L6 | Lazy resume then send | Sending to a persisted non-live session performs one provider load and delivers the prompt once to the restored provider session. No stale provider session receives it. |
| L7 | Queue and steering order | Recorded provider prompt calls preserve FIFO ordering for ordinary queued messages. A steering prompt moves ahead of queued ordinary work and interrupts only when a provider turn is actively streaming. |
| L8 | Stop state matrix | Public stop commands characterize idle, streaming, and compacting states. Idle stop leaves the next prompt deliverable, streaming stop calls provider interrupt once, and compacting stop does not interrupt compaction while preventing queued prompts from being delivered. |
| L9 | Interaction-mode mutation | Public mode changes produce the correct provider settings calls and current update events. Autonomy remains unchanged. Provider rejection emits the current error without a false successful mode update. |
| L10 | Autonomy mutation | Supported values and defaults produce the correct provider settings call. Success emits the current update event; provider rejection emits the current error and no false autonomy update. |

## B. Permission and structured-question lifecycle

### Target file

- `sidecar/src/SessionManager.interactions.test.ts`

| ID | Characterization | Observable evidence |
| --- | --- | --- |
| P1 | Permission request and response | Invoking the provider permission callback emits the current permission events with stable application identity and request correlation. A valid allow-once command resolves the provider callback exactly once with the current normalized outcome. |
| P2 | Always-grant scope | An always-grant response resolves the provider callback and records the current permission signature. A later equivalent request resolves without another user-facing permission event. |
| P3 | Invalid, duplicate, and late permission responses | Invalid responses resolve to the canonical cancel result. Duplicate and unknown request identities do not resolve another provider callback or emit false session updates. |
| P4 | Spec approval transition | Approving the current spec-exit permission produces the required provider mode/settings call before the provider continues. Existing mode and phase events retain their current application-visible order. |
| Q1 | Question answer and cancellation | The provider question callback emits the current question events. Answers preserve question identities and selected values. Cancellation, duplicate responses, and unknown request identities settle a provider callback at most once. |

This PR does not define new shutdown semantics for unresolved permission or question callbacks.

## C. History and child-session behavior

### Target file

- `sidecar/src/SessionManager.historyAndChildren.test.ts`

| ID | Characterization | Observable evidence |
| --- | --- | --- |
| H1 | Initial history restore | A public history command produces the expected history-provider calls and emits the ordered page, cursor, stable application identity, and current replace behavior. |
| H2 | Paging and failure | Table-driven cases characterize older-page loading across an existing compacted provider-session chain, empty history, and restore failure/retry through history calls and emitted history/error events. |
| A1 | Child-session link persistence | Task metadata followed by provider child-session discovery produces the exact `(stable application identity, tool-use identity) -> worker session identity` history write. Duplicate labels and out-of-order discoveries do not change the recorded mapping. |
| A2 | Open and replay a linked child session | Public child-open produces the expected provider load, handler registration, settings calls, compaction configuration, history reads, and opened/history events. Non-member and capacity failures emit current errors without loading an unrelated provider session. |
| A3 | Child send, steer, and interrupt | Public child commands call the intended worker provider session. Failures emit child-scoped errors and do not send, interrupt, or update the parent provider session. |

## D. Compaction invariants

### Target file

- `sidecar/src/SessionManager.compactionLifecycle.test.ts`

| ID | Characterization | Observable evidence |
| --- | --- | --- |
| C1 | Manual in-place compaction | The public compact command calls the provider compaction operation, emits the existing ordered status/context events, retains the provider identity, and delivers queued work once after settlement. |
| C2 | Provider-session swap | Compaction that returns a replacement provider identity preserves the stable application identity in outward events. Subsequent provider calls use the replacement identity. Handler, MCP, notification, model/tool/compaction-setting, usage, and history-chain effects are verified through calls; the old provider session closes once. |
| C3 | Failed swap recovery | Failed replacement adoption produces the current retry/recovery calls and events. Prompts queued during compaction are eventually delivered once through the recovered provider session, with stale resources closed according to current behavior. |
| C4 | Automatic compaction across parent and child sessions | Provider notifications produce the current parent and worker compaction events and calls. During automatic compaction, explicit public interrupt commands invoke the current one-shot parent/worker escape hatch once; `sendNow` steering queues ahead without adding another provider interrupt while compaction remains active. Parent and child context events remain scoped correctly, and deferred worker closure occurs only after provider compaction settles. |
| C5 | Compaction retuning reaches every live provider session | Public `settings.compaction.update` retunes every live parent, worker, and validator session. Per-model limits use each loaded session model ahead of role fallbacks and global settings. |
|  | PR 5 TODO (approved) | An active child model change can leave that child armed with its prior compaction threshold. This known production defect is not asserted as desired current behavior in PR 1. |
| C6 | Close and shutdown resource cleanup | Immediate public close and shutdown cleanup cause each provider session, child session, MCP handle, context poller, watchdog, notification subscription, browser session, and history resource to close or unsubscribe at most once. |
|  | PR 5 TODO (approved) | A late active-worker stream unwind can re-arm a poller or watchdog after close or shutdown. This known production defect is not asserted as desired current behavior in PR 1. |

Pending native-browser request settlement is excluded because current intended semantics are not established. No behavior change is introduced to make this suite pass.

## E. Browser routing

### Target file

- `sidecar/src/SessionManager.browserRouting.test.ts`

| ID | Characterization | Observable evidence |
| --- | --- | --- |
| B1 | Browser command routing | A representative public browser command produces the expected browser-manager call using the stable application identity. Missing-session failures emit the current error contract. |
| B2 | Native request and result correlation | A native-browser result resolves only the matching pending request. Unknown and late correlation identities do not resolve another request. Deterministic fake time verifies the current timeout result without arbitrary sleeps. |
| B3 | Browser continuity across compaction | After a provider-session swap, subsequent browser calls and browser events retain the stable application identity. Public close and shutdown close the associated browser session exactly once. |

No test is added for title-based Design behavior because it does not exist at the baseline.

## F. Renderer-to-bridge smoke

### Target file

- `src/lib/bridge.integration.test.ts`

| ID | Characterization | Observable evidence |
| --- | --- | --- |
| R1 | Renderer command round trip | A real renderer command helper queues the current create command before WebSocket open and sends it exactly once after connection. An incoming current creation/update event is parsed and delivered once to a real bridge subscriber. Unsubscribe suppresses later delivery, and the baseline creates one socket before any close. |

The current bridge has no public stop/reset API, and closing it schedules reconnect. Stop and post-close semantics are outside PR 1, so this characterization does not require a production stop API. The transport is deterministic, but the actual renderer command and bridge modules are used.

## G. Authenticated Electron/Droid smoke

### Target files

- `tests/smoke/electronDroid.smoke.spec.ts`
- `playwright.droid-smoke.config.ts`
- `package.json`

| ID | Characterization | Observable evidence |
| --- | --- | --- |
| E1 | Authenticated desktop round trip | The manually invoked smoke launches the built Electron application and real sidecar, verifies authenticated Factory/Droid readiness, creates one ordinary `auto` session with low or no tool freedom, sends a minimal prompt, observes a non-empty assistant response, closes the session, and exits cleanly. |

### Mandatory opt-in isolation

- Existing `playwright.config.ts` selects only `tests/integration`, so it cannot select `tests/smoke`.
- `npm test`, `npm run sidecar:test`, and `npm run test:integration` remain unchanged.
- `.github/workflows/ci.yml` remains unchanged and does not call the authenticated smoke.
- `playwright.droid-smoke.config.ts` selects only the smoke file.
- `package.json` adds only `test:smoke:electron-droid`, which sets `RUN_AUTHENTICATED_DROID_SMOKE=1` and invokes Playwright with the dedicated smoke configuration.
- The smoke fails before launching a provider turn when the explicit opt-in flag, Factory/Droid authentication, or built Electron/sidecar artifacts are unavailable.
- The smoke never falls back to a mocked provider, automatically authenticates, runs in ordinary CI, or consumes provider usage from standard test commands.

## Exact small-commit sequence

Every commit has one reviewable purpose. Its targeted tests and regular typecheck must pass before the next commit begins.

1. `docs(refactor): record PR 1 characterization baseline`
   - Add this approved specification and baseline evidence only.
   - Make no production or test changes.

2. `test(sidecar): characterize session creation modes`
   - Add the sole temporary harness.
   - Add ordinary, spec, and Mission Control creation plus creation-failure cleanup.
   - Consume the harness immediately so no orphan infrastructure commit exists.

3. `test(sidecar): characterize live session lifecycle`
   - Add resume, lazy send, queue/steering, stop-state, mode mutation, and autonomy mutation coverage.

4. `test(sidecar): characterize permissions and questions`
   - Add permission request/response, always-grant, invalid/duplicate handling, spec approval, and structured-question coverage.

5. `test(sidecar): characterize history and child sessions`
   - Add history restore/paging/failure and child-session link/open/replay/command coverage.

6. `test(sidecar): characterize manual compaction and swaps`
   - Add manual in-place compaction, provider-session replacement, and failed-swap recovery coverage.

7. `test(sidecar): characterize automatic compaction and cleanup`
   - Add automatic parent/worker compaction, all-live-session retuning, and close/shutdown cleanup coverage.

8. `test(sidecar): characterize browser routing`
   - Add browser routing, native request/result correlation, timeout handling, and browser continuity through provider-session replacement.
   - Add no title-based Design test.

9. `test(renderer): cover the bridge session round trip`
   - Add the renderer command-to-WebSocket-to-event-subscriber smoke.

10. `test(smoke): add the opt-in Electron Droid round trip`
    - Add the isolated smoke test, dedicated Playwright configuration, and manually invoked package script.
    - Do not alter ordinary CI or standard test selection.

## Validation requirements

Before this specification is committed:

1. Compute section-heading counts from this file and prove exactly one A-through-G sequence.
2. Compute every test-ID occurrence from this file and prove each retained ID occurs exactly once.
3. Verify the dedicated worktree remains clean except for this uncommitted specification.
4. Verify `HEAD` and `origin/main` remain pinned to the recorded baseline SHA.

Before implementation completion:

1. Run every targeted suite after its corresponding commit.
2. Run the full frontend, sidecar, coverage, integration, quality, build, formatting, and documentation gates.
3. Compare lint and strict-TypeScript diagnostics with the recorded baseline and introduce no new findings.
4. Confirm ordinary CI does not select or execute the authenticated Electron/Droid smoke.
5. Audit new files for focused responsibilities, clear naming, deterministic behavior, and the project file-size standard.
