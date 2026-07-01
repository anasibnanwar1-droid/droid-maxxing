// Compaction subsystem extracted from MissionManager. This controller owns the
// auto/manual compaction lifecycle for the orchestrator and workers; it holds
// the MissionManager as `host` so it can drive sessions, history, and emits.
import type { DroidSession } from '@factory/droid-sdk';
import { runCompaction, type CompactionOutcome, type CompactType } from './compaction.js';
import {
  autoCompactionDueAtTrigger,
  compactionStillOverTrigger,
  shouldInterruptForCompaction,
  type InterruptForCompactionState,
} from './autoCompaction.js';
import { normalizeNotification } from './normalize.js';
import {
  createSessionSettingsForAgent,
  errMsg,
  uniqueStrings,
  type LiveAgent,
  type Mission,
  type MissionManager,
  type UsageOffset,
} from './MissionManager.js';

export class MissionCompaction {
  constructor(private readonly host: MissionManager) {}

  // The SDK exposes manual compaction only; deciding when to compact is the
  // client's job. We interrupt an in-flight turn at a safe boundary (after the
  // current step's result, before the next model request) once usage crosses the
  // internal trigger, so a long-horizon turn compacts mid-task instead of dying
  // at the window. Never interrupts an idle, already-interrupting, or compacting
  // target. Works for both the orchestrator and workers (shared shape).
  //
  // The caller MUST only invoke this at a safe step boundary (see
  // isSafeCompactionBoundary): interrupting anywhere else cancels in-flight work
  // and corrupts the history that compaction then summarizes (a half-written tool
  // call, a truncated reasoning block, or a partial response message).
  interruptForCompactionIfDue(
    target: { session: DroidSession } & InterruptForCompactionState,
    usedTokens: number | undefined,
    windowTokens?: number,
  ): void {
    if (!shouldInterruptForCompaction(target, usedTokens, windowTokens)) return;
    target.interruptingForCompaction = true;
    void target.session.interrupt().catch(() => {
      // Interrupt failed; let the turn finish naturally and clear the flag so
      // `finally` does not compact/resume a turn we did not actually stop.
      target.interruptingForCompaction = false;
    });
  }

  // Pre-turn compaction: when a new user prompt arrives while the session is
  // already over the internal trigger (e.g. the previous turn ended near the
  // window and there was no post-turn compaction), compact first so the prompt
  // runs against a compacted session. The prompt is queued first so the session
  // swap (or stale-swap recovery) routes it through the normal drain and it is
  // never dropped. Returns true if it took ownership of delivering `text`.
  async compactBeforeTurnIfDue(
    mission: Mission,
    appSessionId: string,
    text: string,
  ): Promise<boolean> {
    const snap = this.host.contextSnapshots.get(appSessionId);
    if (!autoCompactionDueAtTrigger(mission, snap?.used, snap?.limit)) return false;
    mission.pendingSends.push(text);
    this.host.patch(appSessionId, { queuedSends: mission.pendingSends.length });
    await this.compactMission(mission, undefined, 'auto');
    this.drainAfterCompaction(appSessionId, mission);
    return true;
  }

  // Shared post-compaction drain for the idle pre-turn path: run the next queued
  // (always real user) prompt against the live, compacted mission, or re-deliver
  // through resume if stale-swap recovery dropped the live mission.
  drainAfterCompaction(appSessionId: string, detached: Mission): void {
    const live = this.host.findMission(appSessionId);
    if (!live) {
      const queued = detached.pendingSends.splice(0);
      if (queued.length > 0) void this.host.redeliverQueuedSends(appSessionId, queued);
      return;
    }
    if (live.streaming || live.compacting) return;
    const next = live.pendingSends.shift();
    this.host.patch(appSessionId, { queuedSends: live.pendingSends.length });
    if (next !== undefined) void this.host.drive(appSessionId, next);
  }

  // Orchestrator (live chat) compaction. Runs the shared in-place path; if the
  // daemon returns a new backing id the `reload` hook swaps the session while
  // keeping the stable app id (summary.id) so the visible chat is unchanged.
  async compactMission(
    mission: Mission,
    customInstructions: string | undefined,
    compactType: CompactType,
  ): Promise<CompactionOutcome> {
    const appSessionId = mission.summary.id;
    const carryover: UsageOffset = {
      tokensIn: mission.summary.tokensIn ?? 0,
      tokensOut: mission.summary.tokensOut ?? 0,
    };
    mission.compacting = true;
    // Remembers the daemon's new backing id so a reload failure can be recovered
    // after runCompaction returns 'stale' (the hook sets it before adopting).
    let swapTarget: string | undefined;
    try {
      const outcome = await runCompaction(
        mission.session,
        {
          status: (text, ct) => this.host.emitStatus(appSessionId, text, ct),
          error: (message) =>
            this.host.emitError({
              sessionId: mission.summary.sessionId,
              missionId: appSessionId,
              message: `Could not compact session: ${message}`,
              recoverable: true,
            }),
          refresh: () => this.host.refreshContext(appSessionId, mission.session),
          reload: async (newSessionId) => {
            swapTarget = newSessionId;
            await this.swapMissionSession(mission, newSessionId, carryover);
          },
        },
        { customInstructions, compactType },
      );
      // The daemon swapped to a new backing id but adopting it threw, so
      // mission.session still points at the swapped-away (now-dead) old id.
      // Recover before later sends stream into that stale session, and report
      // 'stale' so callers never auto-resume into a possibly-dead session.
      if (outcome === 'stale' && swapTarget) {
        const recovered = await this.recoverStaleMissionSwap(mission, swapTarget, carryover);
        // A retry that adopts the swap in place is a real completed compaction,
        // so latch saturation just like the normal completed path; otherwise a
        // still-over-trigger compacted session would trigger one redundant
        // compaction on the next turn before the latch is set.
        if (recovered === 'completed') this.updateCompactionSaturation(mission, compactType);
        return recovered;
      }
      if (outcome === 'completed') this.updateCompactionSaturation(mission, compactType);
      return outcome;
    } finally {
      mission.compacting = false;
    }
  }

  // After a completed compaction, latch whether usage is still at/above the
  // trigger. When the summary itself is near the window, compacting again cannot
  // drop below the trigger, so without this the pre-turn/mid-turn checks would
  // re-fire on every resumed turn and compact in an endless loop. The latch
  // pauses auto-compaction (the task still auto-resumes once so it can finish);
  // it clears on real user input (send) or when usage later falls below the
  // trigger (refreshContext). Reads the post-compaction snapshot refreshed by
  // runCompaction, the same source the meter shows.
  updateCompactionSaturation(mission: Mission, compactType: CompactType): void {
    const appSessionId = mission.summary.id;
    const snap = this.host.contextSnapshots.get(appSessionId);
    const saturated = compactionStillOverTrigger(mission, snap?.used, snap?.limit);
    const wasSaturated = mission.compactionSaturated === true;
    mission.compactionSaturated = saturated;
    if (saturated && !wasSaturated && compactType === 'auto') {
      this.host.emitStatus(
        appSessionId,
        'Context is at the limit and could not be reduced further; automatic compaction is paused. Start a new session to reset context.',
      );
    }
  }

  // Re-apply the session's selected model (and reasoning, plus worker/validator
  // for missions) to a freshly loaded compacted session. loadSession resets the
  // session to the daemon's CLI-default model, so without this an invisible
  // compaction would silently switch the conversation off the user's model.
  // Best-effort: a transient failure here must not abandon an otherwise-live
  // compacted session, so it surfaces a recoverable notice instead of throwing.
  async reapplyModelSettingsAfterSwap(mission: Mission): Promise<void> {
    const s = mission.summary;
    const orchestrator = createSessionSettingsForAgent('orchestrator', {
      modelId: s.modelId ?? null,
      reasoningEffort: s.reasoningEffort,
    });
    const worker = createSessionSettingsForAgent('worker', {
      modelId: s.workerModelId ?? null,
      reasoningEffort: s.workerReasoningEffort,
    });
    const validator = createSessionSettingsForAgent('validator', {
      modelId: s.validatorModelId ?? null,
      reasoningEffort: s.validatorReasoningEffort,
    });
    const missionSettings = {
      ...((worker.missionSettings as Record<string, unknown> | undefined) ?? {}),
      ...((validator.missionSettings as Record<string, unknown> | undefined) ?? {}),
    };
    const next: Record<string, unknown> = {};
    if (orchestrator.modelId !== undefined) next.modelId = orchestrator.modelId;
    if (orchestrator.reasoningEffort !== undefined)
      next.reasoningEffort = orchestrator.reasoningEffort;
    // loadSession also drops the session's autonomy (its params are sessionId +
    // mcpServers only), exactly like the model and reasoning effort, so an
    // autonomous long-horizon mission would silently revert to the daemon
    // default after an invisible compaction swap. Re-apply it from the summary,
    // which setAutonomy / updateSessionSettings keep as the source of truth.
    if (s.autonomy) next.autonomyLevel = s.autonomy;
    if (Object.keys(missionSettings).length > 0) next.missionSettings = missionSettings;
    if (Object.keys(next).length === 0) return;
    try {
      await mission.session.updateSettings(next as never);
    } catch (err) {
      this.host.emitError({
        missionId: mission.summary.id,
        sessionId: mission.summary.sessionId,
        message: `Compaction kept this conversation but could not re-apply the model (${errMsg(err)}); reselect it from the model picker if it changed.`,
        recoverable: true,
      });
    }
  }

  // Adopt the daemon's compacted backing session behind the stable app id:
  // load the new id, swap it in, retire the old session, and persist the new id
  // with carried-over usage. Throws if the new session cannot be loaded.
  async swapMissionSession(
    mission: Mission,
    newSessionId: string,
    carryover: UsageOffset,
  ): Promise<void> {
    const appSessionId = mission.summary.id;
    const compactedFromSessionIds = uniqueStrings([
      ...(mission.summary.compactedFromSessionIds ?? []),
      mission.summary.sessionId,
    ]);
    const ref = { id: appSessionId };
    const oldSession = mission.session;
    mission.session = await this.host.runtime.loadSession(newSessionId, {
      permissionHandler: this.host.makePermissionHandler(ref),
      askUserHandler: this.host.makeAskUserHandler(ref),
      // Re-attach the same local MCP servers (still running) so the swapped
      // session keeps browser tools on subsequent turns.
      mcpServers: mission.mcpConfigs,
    });
    // loadSession cannot carry the model (its params are sessionId + mcpServers
    // only), so the compacted session comes up on the daemon's CLI-default model
    // instead of the one selected for this session. Re-apply the session's model
    // so compaction stays invisible and the conversation keeps running on the
    // same model; compactionModel='current-model' then follows it too.
    await this.reapplyModelSettingsAfterSwap(mission);
    // The replacement session starts with default tool settings, so the cached
    // design-tool policy no longer reflects reality. Clear it so the next turn
    // re-synchronizes disabledToolIds.
    mission.todoDisabledForDesign = undefined;
    await oldSession.close().catch(() => {});
    this.host.usageOffsets.set(appSessionId, carryover);
    this.host.patch(appSessionId, {
      sessionId: newSessionId,
      compactedFromSessionIds,
      tokensIn: carryover.tokensIn,
      tokensOut: carryover.tokensOut,
      contextTokens: 0,
    });
  }

  // Recovery for an orchestrator compaction that swapped backing sessions but
  // failed to adopt the new one (mission.session is now a dead id). Retry the
  // adoption once for a transient failure; if it still fails, persist the new
  // id and drop the live mission so the next send re-resumes against the live
  // (compacted) session instead of streaming into the dead one. Returns the
  // recovered outcome: 'completed' when the retry adopts the swap in place (the
  // mission is live again, so the caller should auto-resume), 'stale' only after
  // the mission is dropped (mirrors the worker recoverStaleAgentSwap contract).
  async recoverStaleMissionSwap(
    mission: Mission,
    newSessionId: string,
    carryover: UsageOffset,
  ): Promise<CompactionOutcome> {
    const appSessionId = mission.summary.id;
    try {
      await this.swapMissionSession(mission, newSessionId, carryover);
      // Retry adopted the swap: the mission stays live on the compacted session,
      // so report success. Returning 'stale' here (the old behavior) skipped the
      // auto-resume in drive()'s finally and left the turn silently stalled.
      return 'completed';
    } catch {
      /* adoption still failing; persist the new id and drop the mission below */
    }
    this.host.patch(appSessionId, {
      sessionId: newSessionId,
      compactedFromSessionIds: uniqueStrings([
        ...(mission.summary.compactedFromSessionIds ?? []),
        mission.summary.sessionId,
      ]),
      tokensIn: carryover.tokensIn,
      tokensOut: carryover.tokensOut,
      contextTokens: 0,
    });
    await this.host.closeMission(appSessionId);
    // closeMission clears the usage offset for this app id, so seed it AFTER the
    // teardown: when the next message re-resumes against the compacted backing
    // session (whose token counts restart low), the carried-over totals are
    // added back instead of the displayed usage collapsing to the new segment.
    this.host.usageOffsets.set(appSessionId, carryover);
    this.host.emitError({
      missionId: appSessionId,
      sessionId: newSessionId,
      message:
        'Compaction moved this conversation to a new session but reloading it failed; it will reload on your next message.',
      recoverable: true,
    });
    return 'stale';
  }

  // Compacting a session that is not currently loaded (e.g. from the sidebar
  // history). There is no live session to refresh; the swapped backing id is
  // persisted to history so the next resume continues from the compacted state.
  async compactHistoricalSession(sessionId: string, customInstructions?: string): Promise<void> {
    const historical = this.host.resolveSummary(sessionId);
    const oldDroidSessionId = historical?.sessionId ?? sessionId;
    try {
      const result = await this.host.withSession(sessionId, (session) =>
        session.compactSession(customInstructions ? { customInstructions } : {}),
      );
      if (!result) return;
      const newSessionId = result.newSessionId || oldDroidSessionId;
      if (newSessionId !== oldDroidSessionId) {
        if (historical) {
          const updated = {
            ...historical,
            sessionId: newSessionId,
            compactedFromSessionIds: uniqueStrings([
              ...(historical.compactedFromSessionIds ?? []),
              oldDroidSessionId,
            ]),
            updatedAt: Date.now(),
          };
          this.host.history.syncSummaries([updated]);
          this.host.emit({ type: 'mission.updated', mission: updated });
          this.host.emit({ type: 'session.updated', session: updated });
        } else {
          // The daemon swapped to a new backing id but there is no local summary
          // to persist it onto, so the old id is now dead and a later resume
          // would target it. Surface it instead of dropping the new id silently.
          this.host.emitError({
            sessionId: newSessionId,
            missionId: sessionId,
            message:
              'Compaction moved this session to a new id but there was no local record to update; reopen it from history to continue from the compacted state.',
            recoverable: true,
          });
        }
      }
    } catch (err) {
      this.host.emitError({
        sessionId: oldDroidSessionId,
        missionId: historical?.id ?? sessionId,
        message: `Could not compact session: ${errMsg(err)}`,
      });
    }
  }

  // Worker pre-turn compaction: when a new send arrives while the worker is
  // already over the internal trigger, compact first (re-keying its session in
  // place) so the prompt runs against a compacted session. The prompt is queued
  // first so the re-key never drops it; a stale swap tears the worker down
  // (matching the existing stale handling). Returns true if it delivered `text`.
  async compactAgentBeforeTurnIfDue(agent: LiveAgent, text: string): Promise<boolean> {
    const snap = this.host.contextSnapshots.get(agent.session.sessionId);
    if (!autoCompactionDueAtTrigger(agent, snap?.used, snap?.limit)) return false;
    agent.pendingSends.push(text);
    const outcome = await this.compactAgent(agent, 'auto');
    if (outcome === 'stale') {
      const missionId = agent.missionId;
      // Capture the queued prompt(s) before teardown and the persisted new id so
      // the steering prompt is re-delivered against the live (compacted) session
      // instead of being silently dropped with the dead-id worker.
      const swappedTo = agent.swappedToSessionId;
      const queued = agent.pendingSends.splice(0);
      this.host.emitError({
        sessionId: agent.session.sessionId,
        missionId,
        message: swappedTo
          ? 'Subagent compaction swapped sessions but could not be adopted in place; re-delivering your message to the compacted subagent.'
          : 'Subagent compaction swapped sessions but could not be adopted; closing the subagent. Re-open it to continue.',
        recoverable: true,
      });
      await this.host.closeAgent(missionId, agent.session.sessionId);
      if (swappedTo) {
        for (const queuedText of queued)
          await this.host.sendAgent(missionId, swappedTo, queuedText);
      }
      return true;
    }
    const next = agent.pendingSends.shift();
    if (next !== undefined) void this.host.driveAgent(agent, next);
    return true;
  }

  async compactAgent(agent: LiveAgent, compactType: CompactType): Promise<CompactionOutcome> {
    const agentSessionId = agent.session.sessionId;
    agent.compacting = true;
    // Reset the transient swap target so a caller reading it after a 'stale'
    // outcome only ever sees this run's new id (set by recoverStaleAgentSwap),
    // never a leftover from an earlier compaction.
    agent.swappedToSessionId = undefined;
    // Remembers the daemon's new backing id (set by the reload hook before it
    // adopts the swap) so a reload failure that returns 'stale' can still
    // recover the new id instead of losing it, mirroring the orchestrator's
    // swapTarget / recoverStaleMissionSwap path.
    let swapTarget: string | undefined;
    try {
      const outcome = await runCompaction(
        agent.session,
        {
          // Status lines stay keyed by the worker's original id so they land on
          // the worker the client is still showing; the rekey event below moves
          // that transcript to the new id afterwards.
          status: (text, ct) =>
            this.host.emitStatus(agent.missionId, text, ct, agentSessionId, agent.role),
          error: (message) =>
            this.host.emitError({
              sessionId: agentSessionId,
              missionId: agent.missionId,
              message: `Could not compact subagent: ${message}`,
              recoverable: true,
            }),
          // After a swap the snapshot must live under the worker's current id so
          // the next auto-compaction check reads the right usage.
          refresh: () => this.host.refreshContext(agent.session.sessionId, agent.session),
          // The daemon swaps to a new backing session id on a successful
          // compaction. Adopt it in place (re-key all maps and re-subscribe)
          // so the worker stays alive and queued sends keep flowing rather than
          // the session being treated as stale and torn down.
          reload: async (newSessionId) => {
            swapTarget = newSessionId;
            await this.rekeyAgentSession(agent, newSessionId);
          },
        },
        { compactType },
      );
      // In-place adoption succeeded: tell clients to remap state from the old id
      // to the new one. Emitted after runCompaction so all old-id-keyed
      // transcript/status events are flushed first.
      if (agent.session.sessionId !== agentSessionId) {
        this.emitWorkerRekey(agent.missionId, agentSessionId, agent.session.sessionId);
        if (outcome === 'completed') this.updateAgentCompactionSaturation(agent, compactType);
        return outcome;
      }
      // The daemon swapped to a new backing id but adopting it threw, so
      // agent.session still points at the swapped-away (now-dead) old id.
      // Recover so the new id isn't lost: otherwise queued sends and future
      // re-opens would target the dead old id.
      if (outcome === 'stale' && swapTarget) {
        const recovered = await this.recoverStaleAgentSwap(agent, agentSessionId, swapTarget);
        // A retry that adopts the swap in place is a real completed compaction,
        // so latch saturation just like the normal completed path (mirrors
        // compactMission) instead of leaving the next turn to re-compact.
        if (recovered === 'completed') this.updateAgentCompactionSaturation(agent, compactType);
        return recovered;
      }
      if (outcome === 'completed') this.updateAgentCompactionSaturation(agent, compactType);
      return outcome;
    } finally {
      agent.compacting = false;
    }
  }

  // Worker counterpart of updateCompactionSaturation: latch when a completed
  // worker compaction left usage still at/above the trigger so the worker's
  // pre-turn/mid-turn checks stop looping. Cleared when the worker gets a
  // genuinely new task (driveAgent) rather than a hidden resume.
  updateAgentCompactionSaturation(agent: LiveAgent, compactType: CompactType): void {
    const snap = this.host.contextSnapshots.get(agent.session.sessionId);
    const saturated = compactionStillOverTrigger(agent, snap?.used, snap?.limit);
    const wasSaturated = agent.compactionSaturated === true;
    agent.compactionSaturated = saturated;
    if (saturated && !wasSaturated && compactType === 'auto') {
      this.host.emitStatus(
        agent.missionId,
        'Subagent context is at the limit and could not be reduced further; automatic compaction is paused.',
        undefined,
        agent.session.sessionId,
        agent.role,
      );
    }
  }

  emitWorkerRekey(missionId: string, oldSessionId: string, newSessionId: string): void {
    this.host.emit({ type: 'mission.worker.rekey', missionId, oldSessionId, newSessionId });
  }

  // Recovery for a worker compaction that swapped backing sessions but failed to
  // adopt the new one (agent.session is now a dead id). Retry the adoption once
  // for a transient load failure; if it still fails, persist the new id to the
  // durable spawn link and mission features so a later re-open/resume targets
  // the live (compacted) session, then report 'stale' so the caller tears down
  // the dead-id worker instead of draining sends into it.
  async recoverStaleAgentSwap(
    agent: LiveAgent,
    oldSessionId: string,
    newSessionId: string,
  ): Promise<CompactionOutcome> {
    try {
      await this.rekeyAgentSession(agent, newSessionId);
      this.emitWorkerRekey(agent.missionId, oldSessionId, agent.session.sessionId);
      return 'completed';
    } catch {
      /* adoption still failing; persist the new id below so re-open hits it */
    }
    const mission = this.host.findMission(agent.missionId);
    if (mission) this.persistWorkerSwap(mission, oldSessionId, newSessionId);
    this.emitWorkerRekey(agent.missionId, oldSessionId, newSessionId);
    // Surface the persisted new id so a pre-turn caller can re-deliver a queued
    // prompt against it after tearing down the dead-id worker.
    agent.swappedToSessionId = newSessionId;
    return 'stale';
  }

  // Adopt a worker's swapped backing session id (returned by the daemon on a
  // successful compaction) in place: load the new session, move every map/set
  // keyed by the old id, re-subscribe notifications, and persist the updated
  // spawn links so a later resume points at the compacted session. Loading runs
  // first so a failure leaves the old (still valid) session untouched; the
  // synchronous re-keying that follows cannot throw.
  async rekeyAgentSession(agent: LiveAgent, newSessionId: string): Promise<void> {
    const oldSessionId = agent.session.sessionId;
    if (newSessionId === oldSessionId) return;
    const ref = { id: agent.missionId };
    const newSession = await this.host.runtime.loadSession(newSessionId, {
      permissionHandler: this.host.makePermissionHandler(ref),
      askUserHandler: this.host.makeAskUserHandler(ref),
    });
    const oldSession = agent.session;
    agent.unsubscribe?.();
    agent.session = newSession;
    agent.unsubscribe = newSession.onNotification((note: Record<string, unknown>) => {
      // Same compaction-armed drop-guard as the openAgent subscription: a
      // terminal tail event here must not mark the worker terminal mid-swap.
      if (agent.interruptingForCompaction) return;
      for (const n of normalizeNotification(agent.missionId, newSessionId, agent.role, note))
        this.host.applyNormalizedForAgent(agent.missionId, newSessionId, n);
    });
    const snapshot = this.host.contextSnapshots.get(oldSessionId);
    this.host.contextSnapshots.delete(oldSessionId);
    if (snapshot) this.host.contextSnapshots.set(newSessionId, snapshot);
    const mission = this.host.findMission(agent.missionId);
    if (mission) {
      if (mission.agents.delete(oldSessionId)) mission.agents.set(newSessionId, agent);
      if (mission.knownSubagents.delete(oldSessionId)) mission.knownSubagents.add(newSessionId);
      if (mission.completedSubagents.delete(oldSessionId))
        mission.completedSubagents.add(newSessionId);
      if (mission.linkedSubagents.delete(oldSessionId)) mission.linkedSubagents.add(newSessionId);
      // terminalAgents is keyed by session id; remap it too so the post-terminal
      // generation guard keeps recognizing this worker after the swap.
      if (mission.terminalAgents.delete(oldSessionId)) mission.terminalAgents.add(newSessionId);
      const settings = mission.subagentSettings.get(oldSessionId);
      if (settings) {
        mission.subagentSettings.delete(oldSessionId);
        mission.subagentSettings.set(newSessionId, settings);
      }
      this.persistWorkerSwap(mission, oldSessionId, newSessionId);
    }
    // loadSession brings the compacted worker up on the daemon's CLI-default
    // model; re-apply its selected model so compaction never silently downgrades
    // the worker (mirrors reapplyModelSettingsAfterSwap for the orchestrator).
    await this.reapplyAgentModelAfterSwap(agent);
    await oldSession.close().catch(() => {});
  }

  // Worker counterpart of reapplyModelSettingsAfterSwap: re-apply the worker's
  // selected model + reasoning directly to its freshly loaded compacted session.
  // Source is the worker's stored per-session settings, falling back to the
  // mission's role default (worker/validator) and then the orchestrator model.
  // Best-effort: a transient failure must not abandon an otherwise-live worker.
  private async reapplyAgentModelAfterSwap(agent: LiveAgent): Promise<void> {
    const mission = this.host.findMission(agent.missionId);
    if (!mission) return;
    const s = mission.summary;
    const stored = mission.subagentSettings.get(agent.session.sessionId);
    const roleModelId =
      agent.role === 'worker'
        ? s.workerModelId
        : agent.role === 'validator'
          ? s.validatorModelId
          : undefined;
    const roleReasoning =
      agent.role === 'worker'
        ? s.workerReasoningEffort
        : agent.role === 'validator'
          ? s.validatorReasoningEffort
          : undefined;
    const modelId = stored?.modelId ?? roleModelId ?? s.modelId;
    const reasoningEffort = stored?.reasoningEffort ?? roleReasoning ?? s.reasoningEffort;
    const next: Record<string, unknown> = {};
    if (modelId) next.modelId = modelId;
    if (reasoningEffort !== undefined) next.reasoningEffort = reasoningEffort;
    if (Object.keys(next).length === 0) return;
    try {
      await agent.session.updateSettings(next as never);
    } catch (err) {
      this.host.emitError({
        missionId: agent.missionId,
        sessionId: agent.session.sessionId,
        message: `Compaction kept this subagent but could not re-apply its model (${errMsg(err)}); reselect it from the model picker if it changed.`,
        recoverable: true,
      });
    }
  }

  // Persist a worker's compaction swap to the durable spawn link and the mission
  // summary features so a later resume or re-open targets the compacted id (not
  // the dead old one). Shared by the in-place rekey and the stale-swap recovery
  // (which runs this even when the new session could not be loaded, so the new
  // id survives in history and the worker is re-openable).
  persistWorkerSwap(mission: Mission, oldSessionId: string, newSessionId: string): void {
    // Authorize the new id for live agent.open/agent.send immediately. When
    // rekeyAgentSession succeeds it has already swapped these sets; but the
    // stale-recovery path runs persistWorkerSwap WITHOUT a successful rekey, so
    // without this the rekeyed id is in neither set and every open/send fails
    // with agent.not_in_session until the mission is reloaded. delete() guards
    // keep it idempotent when the rekey path already moved them.
    if (mission.knownSubagents.delete(oldSessionId)) mission.knownSubagents.add(newSessionId);
    if (mission.linkedSubagents.delete(oldSessionId)) mission.linkedSubagents.add(newSessionId);
    // Carry the worker's per-session model/reasoning to the new id too. The
    // in-place rekey already moved this, but the stale-recovery path runs
    // persistWorkerSwap WITHOUT a successful rekey, so without this a re-opened
    // worker would read no stored settings for the new id and silently revert to
    // the role-default model instead of the user-picked one. Idempotent: a no-op
    // once the rekey path already moved it.
    const settings = mission.subagentSettings.get(oldSessionId);
    if (settings) {
      mission.subagentSettings.delete(oldSessionId);
      mission.subagentSettings.set(newSessionId, settings);
    }
    // Re-point any spawn link for this worker at the new id (preserving its
    // label) so a later resume seeds linkedSubagents with the compacted id.
    const labelByToolUseId = new Map(
      this.host.history.subagentLinks(mission.summary.id).map((l) => [l.toolUseId, l.label]),
    );
    for (const [toolUseId, sid] of mission.subagentToolUseIds) {
      if (sid !== oldSessionId) continue;
      mission.subagentToolUseIds.set(toolUseId, newSessionId);
      this.host.history.recordSubagentLink(
        mission.summary.id,
        toolUseId,
        newSessionId,
        labelByToolUseId.get(toolUseId),
      );
    }
    // Mission features pin workers by session id (feature focus + worker
    // numbering). Remap them on the summary too, so a later mission.list/
    // mission.updated (which re-emits summary.features) can't overwrite the
    // client's rekey with the dead id and make feature-focused views unopenable.
    const features = mission.summary.features;
    if (features?.length) {
      mission.summary.features = features.map((f) =>
        f.currentWorkerSessionId === oldSessionId ||
        f.completedWorkerSessionId === oldSessionId ||
        f.workerSessionIds?.includes(oldSessionId)
          ? {
              ...f,
              workerSessionIds: f.workerSessionIds?.map((id) =>
                id === oldSessionId ? newSessionId : id,
              ),
              currentWorkerSessionId:
                f.currentWorkerSessionId === oldSessionId ? newSessionId : f.currentWorkerSessionId,
              completedWorkerSessionId:
                f.completedWorkerSessionId === oldSessionId
                  ? newSessionId
                  : f.completedWorkerSessionId,
            }
          : f,
      );
    }
  }
}
