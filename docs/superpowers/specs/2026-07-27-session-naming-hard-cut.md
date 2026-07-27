# Refactor PR 2: Session Naming Hard Cut

## Scope

This PR changes repository vocabulary only. Runtime behavior remains covered by
the Refactor PR 1 characterization suites. It does not extract `SessionManager`,
change compaction behavior, redesign history, or add compatibility paths.

The canonical axes are independent:

- `sessionPurpose`: `chat | design | mission-control`
- `interactionMode`: `auto | spec | agi`
- `autonomy`: `off | low | medium | high`

`appSessionId` is the stable application identity. `providerSessionId` is the
replaceable Factory session identity. Workers and validators are child sessions
owned by a Mission Control mission.

## Exact mapping

### Core types and identities

| Old | New |
| --- | --- |
| `MissionManager` | `SessionManager` |
| internal `Mission` | `LiveSession` |
| `MissionSummary` | `SessionSummary` |
| `MissionPhase` | `SessionPhase` |
| `MissionQuestion` | `SessionQuestion` |
| `HistoryMission` | `SessionHistoryEntry` |
| `HistoricalMission` | `HistoricalSession` |
| `HydratedMissionHistory` | `HydratedSessionHistory` |
| `summary.id` | `summary.appSessionId` |
| `summary.sessionId` | `summary.providerSessionId` |
| `compactedFromSessionIds` | `compactedFromProviderSessionIds` |
| `parentSessionId` | `parentProviderSessionId` |
| generic parent role `orchestrator` | `primary` |
| `SessionKind` / `kind` | `SessionPurpose` / `sessionPurpose` plus `interactionMode` |
| `chat` kind | `sessionPurpose: chat`, `interactionMode: auto` |
| `spec` kind | `sessionPurpose: chat`, `interactionMode: spec` |
| `mission_orchestrator` kind | `sessionPurpose: mission-control`, `interactionMode: agi` |
| `mission_worker` / `mission_validator` kind | Mission Control child role plus `sessionPurpose: mission-control` |

Provider session objects and raw Factory transcript fields use
`providerSessionId`. Presentation-only transcript routing uses
`sourceSessionId`; it is not another application or provider identity.

### Commands and events

The bridge exposes one command/event path. Existing `session.*` and `mission.*`
duplicates collapse to the following canonical names:

| Old | New |
| --- | --- |
| `mission.create` | `session.create` |
| `mission.send` | `session.send` |
| `mission.sendNow` | `session.sendNow` |
| `mission.interrupt` | `session.interrupt` |
| `mission.compact` | `session.compact` |
| `mission.close` | `session.close` |
| `mission.resume` | `session.resume` |
| `mission.list` | `sessions.list` |
| `mission.loadHistory` | `session.loadHistory` |
| `mission.setAutonomy` | `session.updateSettings` with `autonomy` |
| `mission.setInteractionMode` | `session.updateSettings` with `interactionMode` |
| `mission.respondPermission` | `approval.respond` |
| `mission.respondQuestion` | `question.respond` |
| `mission.subscribeWorker` / `agent.open` | `child.open` |
| `agent.send` / `agent.sendNow` / `agent.interrupt` | `child.send` / `child.sendNow` / `child.interrupt` |
| `agent.updated` | `child.updated` |
| `agent.not_steerable` | `child.not_steerable` |
| generic `subagent` helpers and state | child-session helpers and state |
| `mission.created` | `session.created` |
| duplicate `mission.updated` | the single `session.updated` event |
| `mission.tokens` | existing `context.updated` |
| `mission.transcript` | existing `event.appended` |
| `mission.permission` | existing `approval.requested` |
| `mission.question` | existing `question.requested` |
| `mission.error` | existing `error` |
| `mission.history` / `mission.history.error` | `session.history` / `session.history.error` |
| generic `mission.worker` | `session.child` |
| `sessions.history` with payload `missions` | `history.list` with payload `sessions` |
| `models.list` command / event | `catalog.models` command / `catalog.updated` event |
| generic command/event `missionId` | `appSessionId` |
| generic `session.*` payload `sessionId` | `appSessionId` |
| raw history/backend `sessionId` | `providerSessionId` |
| catalog/history payload `sessionId` | `providerSessionId` |
| child backend `agentSessionId` / `workerSessionId` | `providerSessionId` / `workerProviderSessionId` |

`mission.features` and `mission.progress` remain Mission Control events and use
`missionId`.

### Renderer state and helpers

| Old | New |
| --- | --- |
| `missions` / `missionOrder` | `sessions` / `sessionOrder` |
| generic `WorkerSummary` / `WorkerInfo` | `ChildSessionSummary` / `ChildSessionInfo` |
| generic `workers` state / history payload | `childSessions` |
| `activeMissionId` | `activeAppSessionId` |
| generic `activeMission` | `activeSession` |
| `missionLastSeen` | `sessionLastSeen` |
| `missionSettingOverrides` | `sessionSettingOverrides` |
| `missionSpecs` / `specWikiMissionId` | `sessionSpecs` / `specWikiAppSessionId` |
| `reviewOpenMissionId` | `reviewOpenAppSessionId` |
| `MISSION_CREATED` / `MISSION_UPDATED` | `SESSION_CREATED` / `SESSION_UPDATED` |
| other generic `MISSION_*` actions | corresponding `SESSION_*` actions |
| `SET_ACTIVE_MISSION` | `SET_ACTIVE_SESSION` |
| `MISSION_SET_MODEL` / `MISSION_SET_REASONING` | `SESSION_SET_MODEL` / `SESSION_SET_REASONING` |
| `createMission` / `resumeMission` / `closeMission` | `createSession` / `resumeSession` / `closeSession` |
| `sendToMission` / `sendToMissionNow` | `sendToSession` / `sendToSessionNow` |
| `interruptMission` | `interruptSession` |
| `listMissions` / `loadMissionHistory` | `listSessions` / `loadSessionHistory` |
| `missionIsLive` / `useMissionLive` | `sessionIsLive` / `useSessionLive` |
| `utilityPanelForMission` | `utilityPanelForSession` |
| generic `missionMode` | `missionControlMode` |

Mission Control component state keeps `mission`, `missionId`, workers,
validators, and orchestrator labels because that UI represents an actual AGI
Mission Control mission.

### Sidecar, history, browser, and Electron

| Old | New |
| --- | --- |
| `MissionManager.ts` and characterization test names | `SessionManager.ts` and matching test names |
| `missionHelpers.ts` | `sessionHelpers.ts` |
| `missionListFilter.ts` | `sessionListFilter.ts` |
| `missionAutoCompaction.ts` | `sessionAutoCompaction.ts` |
| generic `missions` map / `findMission` | `sessions` map / `findSession` |
| `createMission` / `resumeMission` / `closeMission` | `createSession` / `resumeSession` / `closeSession` |
| generic historical summary type `HistoricalMission` | `HistoricalSession` |
| `loadHistoricalMissions` | `loadMissionControlSessions` for actual Mission Control directories |
| generic transcript history loader | `loadHistoricalSessions` |
| `hydrateHistoricalMission` | `hydrateHistoricalSession` |
| `loadMissionTranscriptWindow` | `loadSessionTranscriptWindow` |
| browser routing `missionId` | `appSessionId` |
| `browserKeyForMission` | `browserKeyForSession` |
| native-browser `sessionId` | `browserSessionId` |
| git/review stable `sessionId` | `appSessionId` |
| terminal ownership `missionId` | `appSessionId` |
| `MAX_TERMINALS_PER_MISSION` / `maxPerMission` | `MAX_TERMINALS_PER_SESSION` / `maxPerSession` |
| persisted generic mission columns and keys | `app_session_*` / `provider_session_*` names |
| `subagent_links` | `child_session_links` |
| `DROID_CONTROL_MAX_OPEN_AGENTS` | `DROID_CONTROL_MAX_OPEN_CHILD_SESSIONS` |

There is no schema migration or fallback. Existing local development state is
outside the current-state contract and may be cleared explicitly.

## Reserved terminology

The following names stay because they are Mission Control-specific:

- `MissionControl`, `missionId`, Mission Control phases, features, progress,
  workers, validators, and orchestrator presentation.
- `mission.features`, `mission.progress`, `mission_plan`, `propose_mission`,
  `start_mission_run`, and other AGI tool/event names.
- `missionOrchestratorModelId` and
  `missionOrchestratorReasoningEffort`.
- Factory SDK names such as `DroidSession`, `Droid`,
  `DecompSessionType.Orchestrator`, and raw Factory metadata.

No compatibility alias, deprecated event, dual command, adapter, or fallback
survives this hard cut.
