# Auto Compaction Runtime Boundary

Droid Control owns the user-visible compaction policy: the configured context window, the 90% to 75% automatic threshold, manual compaction rejection while work is active, and the transcript/status UI.

The current `@factory/droid-sdk@0.6.0` stream API does not expose a safe callback between tool results and the next model request. `session.stream(prompt)` sends the user message to the daemon and then yields notifications until the daemon reports the turn result. Notifications such as `tool_result` and `working_state_changed` are observable events, not backpressure checkpoints.

Because of that, Droid Control must not call `compactSession()` from inside the active `for await` stream. That would race the daemon's internal model/tool loop and can corrupt or strand the live turn.

True Codex-style same-task compaction needs an SDK/daemon checkpoint before the next model request, for example:

- `beforeNextModelRequest`
- `afterToolResults`
- `shouldAutoCompact`
- `autoCompactTokenLimit`

Once the SDK/daemon exposes that boundary, Droid Control should pass its effective threshold into the stream options, render `Compacting conversation...` while the daemon pauses at the checkpoint, and keep the existing pre-stream compaction as a first-turn guard.
