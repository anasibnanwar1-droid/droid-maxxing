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
| `mission.setAutonomy` | `session.setAutonomy` |
| `mission.setInteractionMode` | `session.setInteractionMode` |
| `mission.respondPermission` | `permission.respond` |
| `mission.respondQuestion` | `question.respond` |
| `mission.subscribeWorker` / `agent.open` | `child.open` |
| `agent.send` / `agent.sendNow` / `agent.interrupt` | `child.send` / `child.sendNow` / `child.interrupt` |
| `mission.created` | `session.created` |
| duplicate `mission.updated` | the single `session.updated` event |
| `mission.tokens` | existing `context.updated` |
| `mission.transcript` | existing `event.appended` |
| `mission.permission` | existing `approval.requested` |
| `mission.question` | existing `question.requested` |
| `mission.error` | existing `error` |
| `mission.history` / `mission.history.error` | `session.history` / `session.history.error` |
| generic `mission.worker` | `session.child` |
| `sessions.history` payload `missions` | `sessions.history` payload `sessions` |
| generic command/event `missionId` | `appSessionId` |
| raw history/backend `sessionId` | `providerSessionId` |
| child backend `agentSessionId` / `workerSessionId` | `providerSessionId` / `workerProviderSessionId` |

`mission.features` and `mission.progress` remain Mission Control events and use
`missionId`.

### Renderer state and helpers

| Old | New |
| --- | --- |
| `missions` / `missionOrder` | `sessions` / `sessionOrder` |
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
| `loadHistoricalMissions` / `hydrateHistoricalMission` | `loadHistoricalSessions` / `hydrateHistoricalSession` |
| `loadMissionTranscriptWindow` | `loadSessionTranscriptWindow` |
| browser routing `missionId` | `appSessionId` |
| `browserKeyForMission` | `browserKeyForSession` |
| terminal ownership `missionId` | `appSessionId` |
| `MAX_TERMINALS_PER_MISSION` / `maxPerMission` | `MAX_TERMINALS_PER_SESSION` / `maxPerSession` |
| persisted `mission_*` columns and generic mission storage keys | canonical `session_*` names |

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
