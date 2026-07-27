# Droid Control Frontend Specification

This document describes the current renderer-to-sidecar contract. The renderer
is a React application hosted by Electron. The sidecar owns Factory Droid SDK
sessions and exposes one canonical WebSocket protocol.

## Runtime vocabulary

Session is the generic application and UI concept.

- `appSessionId` is the stable application identity. Renderer state, history,
  browser ownership, permissions, and top-level commands use it.
- `providerSessionId` is the replaceable Factory backend identity. Compaction
  may replace it without changing `appSessionId`.
- `sourceSessionId` is presentation-only transcript routing. Primary transcript
  events use `primary`; child events use their provider identity.
- `missionId` exists only for an AGI Mission Control mission.

The three configuration axes are independent:

- `sessionPurpose`: `chat | design | mission-control`
- `interactionMode`: `auto | spec | agi`
- `autonomy`: `off | low | medium | high`

A standard AGI interaction mode does not imply Mission Control. Switching
interaction mode never changes session purpose, application identity, or
autonomy.

## Bridge contract

`src/types/bridge.ts` mirrors `sidecar/src/protocol.ts`. Update both sides
atomically.

### Session commands

- `session.create`
- `session.send`
- `session.sendNow`
- `session.interrupt`
- `session.compact`
- `session.close`
- `session.resume`
- `session.rename`
- `session.loadHistory`
- `sessions.list`
- `session.updateSettings`

`session.updateSettings` is the single update command for the primary model,
reasoning effort, autonomy, and interaction mode.

### Child-session commands

- `child.open`
- `child.send`
- `child.sendNow`
- `child.interrupt`

Workers and validators are child sessions. Mission Control owns workers and
validators as part of its mission. Standard chat/spec sessions may also expose
Factory Task children; they use the same child-session protocol.

### Approval, question, and settings commands

- `approval.respond`
- `question.respond`
- `settings.agent.update`
- `settings.compaction.update`
- `settings.defaults`

### Canonical events

- `session.created`
- `session.updated`
- `sessions.list`
- `session.history`
- `session.history.error`
- `session.child`
- `child.updated`
- `event.appended`
- `context.updated`
- `approval.requested`
- `question.requested`
- `error`

`mission.features` and `mission.progress` are reserved for Mission Control and
may include its `missionId`.

## Renderer state

The store in `src/hooks/useStore.tsx` owns:

- `sessions` and `sessionOrder`
- `activeAppSessionId`
- transcript, progress, and child-session maps keyed by `appSessionId`
- selected child `providerSessionId`
- per-session browser, context, history, and settings state

Reducers use `SESSION_*`, `CHILD_*`, and protocol-event names. There are no
mission aliases for generic session behavior.

## UI routing

`App.tsx` routes by `sessionPurpose`.

- `chat` and `design` use the standard conversation workspace.
- `mission-control` uses `MissionControl.tsx`.

Spec is an interaction mode within a standard session. Entering or leaving spec
does not create a different session kind. Mission Control terminology—mission,
orchestrator, worker, validator, features, and progress—stays inside the
Mission Control surface.

## History and identity

History restores the stable application row first, then resolves its current
provider session and compaction chain.

- Standard session history reads canonical Factory session transcripts.
- Mission Control history reads its Mission Control directory and child
  transcripts.
- Task children are never listed as standalone top-level sessions.
- Persisted child links map `appSessionId + toolUseId` to
  `providerSessionId`.

There are no compatibility aliases, schema migrations, or orphan-child
standalone fallbacks.

## Compaction

Compaction preserves `appSessionId` and may replace `providerSessionId`.
Renderer transcript, context, browser, permission, and child ownership remain
keyed by the stable application identity. Child-session compaction is tracked by
that child's provider identity and does not overwrite primary context.

## Browser routing

Browser ownership is keyed by `appSessionId`. A browser runtime may allocate its
own `browserSessionId`; that identity is independent of both application and
Factory provider identities.

Native requests and results carry:

- `appSessionId`
- `browserSessionId`
- `requestId`

Compaction does not replace browser ownership.

## Permissions and questions

Permission and question requests carry `appSessionId` plus a request identity.
Responses never target a provider session directly. Spec approval switches the
provider to auto interaction before resolving the approval callback, while
preserving `sessionPurpose`, `appSessionId`, and autonomy.

## Validation

For repository-wide changes run:

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
