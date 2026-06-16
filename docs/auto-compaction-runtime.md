# Auto-Compaction Runtime Boundary

Droid Control owns the user-visible controls and status UI. The Droid daemon owns automatic compaction timing.

The sidecar must not decide that a live model/tool boundary is safe. `session.stream(prompt)` sends the user message to the daemon and then yields notifications until the daemon reports the turn result. Notifications such as `tool_result` and `working_state_changed` are observable events, not backpressure checkpoints.

Automatic compaction therefore works by configuring the daemon:

- `initialize_session` receives `compactionThresholdCheckEnabled` so threshold checks are enabled for the session from startup.
- `updateSettings()` receives the selected `compactionTokenLimit` because the current SDK initialize schema does not accept that field.
- Live settings changes and existing-chat sends also refresh daemon compaction settings, so a resumed or already-open session does not keep a stale threshold.
- The configured context window remains the user-visible budget. The sidecar gives the daemon an earlier trigger derived from that budget: 90% for fresh sessions, then 85%, 80%, and a 75% floor for sessions that have already compacted. This keeps daemon-owned compaction ahead of long tool-heavy turns without exposing an internal window to users.
- Droid Control does not call `compactSession()` automatically before, during, or after a streamed turn.
- Manual compaction still uses `compactSession()`, and remains blocked while a turn is active.

The daemon emits `working_state_changed: compacting_conversation` while it is compacting. Droid Control normalizes that into the transcript status line `Compacting conversation...` so the UI remains visibly active instead of looking idle.

If the public SDK later exposes an explicit pre-continuation callback, Droid Control can route the same settings through that API. Until then, automatic compaction is daemon-owned.
