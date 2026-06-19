# Auto-Compaction Runtime Boundary

Droid Control owns the user-visible controls and status UI. The Droid daemon owns automatic compaction timing for orchestrator, worker, validator, and other spawned sessions.

The sidecar must not decide that a live model/tool boundary is safe. `session.stream(prompt)` sends the user message to the daemon and then yields notifications until the daemon reports the turn result. Notifications such as `tool_result` and `working_state_changed` are observable events, not backpressure checkpoints.

Automatic compaction during a turn therefore works by configuring the daemon:

- `initialize_session` receives `compactionThresholdCheckEnabled` so threshold checks are enabled for the session from startup.
- `updateSettings()` receives a numeric `compactionTokenLimit` only when the user selects a numeric trigger hint.
- Live settings changes and existing-chat sends also refresh daemon compaction settings, so a resumed or already-open session does not keep a stale threshold.
- The model context window shown in Droid Control comes from daemon context stats, falling back to the model catalog's `maxContextTokens` when stats are not available. Compaction settings never rewrite the visible context window.
- The selected `compactionTokenLimit` is only a daemon trigger hint. If the user selects Factory default, Droid Control enables daemon threshold checks without sending a token limit, so the daemon uses its own default policy.
- If the user selects Off, Droid Control disables daemon threshold checks and clears per-model trigger hints for that session/settings payload.
- The trigger budget is not a synchronous hard wall. A long model/tool step can push usage slightly past the selected trigger before the daemon reaches the next safe compaction point.
- Droid Control must not call `compactSession()` automatically before, during, or after a streamed turn. It also must not compact in response to observable stream events such as `tool_result`.
- Manual compaction still uses `compactSession()`, and remains blocked while a turn is active.

The daemon emits `working_state_changed: compacting_conversation` while it is compacting. Droid Control normalizes that into the transcript status line `Compacting conversation...` so the UI remains visibly active instead of looking idle.
