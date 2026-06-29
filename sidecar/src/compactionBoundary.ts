// Decides the single point in a live stream where the client may interrupt to
// compact without corrupting history. The compaction policy (when to compact)
// lives in autoCompaction.ts and the mechanism (how) in compaction.ts; this
// module is just the stream-event bookkeeping that finds a safe boundary, kept
// small and unit-testable instead of inlined in the MissionManager runtime.

// The minimal slice of an SDK stream event this module reads. Tool-call events
// carry the tool-use id under `toolUse.id`; tool results carry it as `toolUseId`.
export interface StreamToolEvent {
  type?: string;
  toolUse?: { id?: string };
  toolUseId?: string;
}

// A non-empty, trimmed tool-use id, or undefined. Used to key the per-turn
// in-flight tool set.
export function toolUseIdOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

// Maintain the per-turn set of tool calls that have started but not yet returned
// a result, keyed by the SDK's stable tool-use id. A tool is "in flight" from
// its first tool_call (or streaming delta) until its tool_result, including the
// Task tool while a subagent runs. The set is meant to be local to one drive
// turn, so it cannot leak across turns; ids are reliably present, and a missing
// id simply leaves the boundary unconfirmed (the caller waits rather than risk
// an unsafe interrupt), which the next turn's pre-turn check would still catch.
export function updateToolsInFlight(inFlight: Set<string>, ev: StreamToolEvent): void {
  const type = ev.type;
  if (type === 'tool_call' || type === 'tool_call_delta') {
    const id = toolUseIdOf(ev.toolUse?.id) ?? toolUseIdOf(ev.toolUseId);
    if (id) inFlight.add(id);
  } else if (type === 'tool_result') {
    const id = toolUseIdOf(ev.toolUseId);
    if (id) inFlight.delete(id);
  }
}

// The only safe point to compact mid-stream: the instant a model step
// completes. That is a tool_result that resolves the LAST in-flight tool (the
// set is now empty), which sits between a fully-formed, already-persisted
// assistant message + its tool results and the next model request. Every other
// event is unsafe to interrupt on: tool_call / tool_call_delta is mid-tool,
// thinking_text_delta is mid-reasoning, assistant_text_delta is mid-response,
// and interrupting any of those truncates content that compaction would then
// summarize from a corrupted transcript. A turn that never calls a tool simply
// runs to its terminal result and is compacted (if still over budget) before
// the next turn, not mid-generation.
export function isSafeCompactionBoundary(ev: StreamToolEvent, inFlight: Set<string>): boolean {
  return ev.type === 'tool_result' && inFlight.size === 0;
}
