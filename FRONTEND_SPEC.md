# Droid Control — Frontend Implementation Spec

The backend is done. This document tells you exactly what to build in the React app
(`src/`) to drive real Factory Mission Control. No backend changes required.

---

## 1. What the backend gives you

```
React (this app)  ──WebSocket──>  Node sidecar  ──@factory/droid-sdk──>  droid daemon
        │                          (sidecar/)
        └── Tauri IPC (invoke) ──> Rust core (src-tauri/)
```

- **Rust** spawns and supervises the Node sidecar on app launch. It exposes:
  - `bridge_info() -> { port: number, token: string }` — where/how to open the WS.
  - `pick_directory() -> string | null` — native folder picker (mission cwd).
  - `notify(title, body)` — OS notification.
  - `get_api_key() -> string | null`, `has_api_key() -> bool`, `set_api_key(key)`, `clear_api_key()` — Factory API key in the OS keychain.
- **Sidecar** is a WebSocket server at `ws://127.0.0.1:{port}?token={token}`.
  You send it `ClientCommand` JSON; it streams back `ServerEvent` JSON.
  All mission lifecycle is **structured events** — never parse text.

The contract types live in `sidecar/src/protocol.ts`. **Mirror them** into the frontend
(step 3) and keep the two files in sync.

---

## 2. Dependencies to add

```bash
npm install @tauri-apps/api
```

Everything else (React 19, framer-motion, lucide-react, tailwind) is already installed.
No `@tauri-apps/plugin-dialog`/`-notification` needed — those are wrapped by Rust commands.

---

## 3. Bridge protocol mirror — `src/types/bridge.ts`

Copy the type section of `sidecar/src/protocol.ts` verbatim (the `MissionPhase`,
`FeatureStatus`, `BridgeFeature`, `ProgressEntry`, `MissionSummary`, `TranscriptEvent`,
`PermissionRequest`, `MissionQuestion`, `ClientCommand`, `ServerEvent` types). They are
plain TS types with no imports, so copy/paste works. Key shapes you'll use most:

- `MissionSummary` — one per mission: `{ id, title, goal, cwd, phase, features[], tokensIn, tokensOut, proposal?, autonomy, modelId? ... }`
- `MissionPhase` = `intake | planning | awaiting_plan_approval | awaiting_run_start | initializing | running | orchestrator_turn | paused | completed | failed`
- `TranscriptEvent` — streamed chat/tool lines, `kind: text|thinking|tool_call|tool_result|error|status`, tagged with `role: orchestrator|worker|validator` and `agentSessionId`.
- `PermissionRequest` — gate to render a modal. `kind: edit|exec|create|apply_patch|mcp|other`. `propose_mission` and `start_mission_run` arrive here too (kind `other`, with `title`/`detail`).
- `MissionQuestion` — `{ missionId, requestId, questions: [{index, question, options[]}] }`.

---

## 4. Tauri command wrappers — `src/lib/tauri.ts`

```ts
import { invoke } from '@tauri-apps/api/core';

export const getBridgeInfo = () => invoke<{ port: number; token: string }>('bridge_info');
export const pickDirectory = () => invoke<string | null>('pick_directory');
export const notify = (title: string, body: string) => invoke('notify', { title, body });
export const getApiKey = () => invoke<string | null>('get_api_key');
export const hasApiKey = () => invoke<boolean>('has_api_key');
export const setApiKey = (key: string) => invoke('set_api_key', { key });
export const clearApiKey = () => invoke('clear_api_key');
```

---

## 5. WebSocket bridge client — `src/lib/bridge.ts`

Single connection for the whole app. Auto-reconnect with backoff. Typed send/subscribe.

```ts
import { getBridgeInfo } from './tauri';
import type { ClientCommand, ServerEvent } from '../types/bridge';

type Listener = (ev: ServerEvent) => void;

class Bridge {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private queue: ClientCommand[] = [];
  private backoff = 500;

  async start() {
    const { port, token } = await getBridgeInfo();
    this.open(`ws://127.0.0.1:${port}?token=${token}`);
  }

  private open(url: string) {
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 500;
      this.queue.forEach((c) => ws.send(JSON.stringify(c)));
      this.queue = [];
    };
    ws.onmessage = (e) => {
      const ev = JSON.parse(e.data) as ServerEvent;
      this.listeners.forEach((l) => l(ev));
    };
    ws.onclose = () => {
      this.ws = null;
      setTimeout(() => this.open(url), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 5000);
    };
    ws.onerror = () => ws.close();
  }

  send(cmd: ClientCommand) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(cmd));
    else this.queue.push(cmd);
  }

  subscribe(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

export const bridge = new Bridge();
```

**Startup flow** (in `main.tsx` or a top-level effect):
1. `await bridge.start()`.
2. Read `getApiKey()`. If present → `bridge.send({ type: 'connect', apiKey })`.
   If absent → route to Settings and prompt for the key, then `setApiKey` + `connect`.
3. The sidecar replies `{ type: 'connection', status: 'connected' | 'error' }`.

---

## 6. New store — replace `src/hooks/useStore.tsx`

Keep the reducer+context pattern; swap the mock domain for missions. Suggested shape:

```ts
interface AppState {
  connection: 'idle' | 'connecting' | 'connected' | 'error';
  missions: Record<string, MissionSummary>;      // by mission id
  missionOrder: string[];                          // sidebar order
  activeMissionId: string | null;
  transcripts: Record<string, TranscriptEvent[]>;  // by mission id (merge by agentSessionId in UI)
  progress: Record<string, ProgressEntry[]>;       // by mission id
  pendingPermission: PermissionRequest | null;     // show modal when set
  pendingQuestion: MissionQuestion | null;         // show modal when set
  workerSubscriptions: Record<string, string[]>;   // missionId -> worker session ids being viewed
  // UI flags (keep existing): rightPanelOpen, commandPaletteOpen, sidebarCollapsed
}
```

Wire `bridge.subscribe(dispatch-adapter)` once in the `StoreProvider`. Map each
`ServerEvent` to a state update:

| ServerEvent | Reducer action |
|---|---|
| `connection` | set `connection` status |
| `mission.created` | add `MissionSummary`, push id to `missionOrder`, set active, match by `clientRef` to clear "creating" spinner |
| `mission.updated` | replace `missions[mission.id]` (phase, proposal, tokens, features all live here) |
| `mission.features` | set `missions[missionId].features` |
| `mission.progress` | append `entries` to `progress[missionId]` |
| `mission.worker` | annotate feature/worker UI; on `started` you may auto-`subscribeWorker` |
| `mission.tokens` | update `tokensIn/out` on the summary |
| `mission.transcript` | append `event` to `transcripts[event.missionId]` (text deltas: concat onto last same-`agentSessionId` text event) |
| `mission.permission` | set `pendingPermission` (opens modal) |
| `mission.question` | set `pendingQuestion` (opens modal) |
| `mission.error` | toast / status line; if `missionId` set phase to `failed` |
| `mission.list` | replace `missions` + `missionOrder` |

**Transcript delta merging:** `assistant_text_delta`/`thinking_text_delta` arrive as many
small `text` events with the same `agentSessionId`. In the reducer, if the last transcript
event for that mission has the same `kind` and `agentSessionId` and no tool boundary in
between, append `text` to it; otherwise push a new bubble.

---

## 7. Sending commands (helpers)

```ts
import { bridge } from '../lib/bridge';

export const createMission = (p: { clientRef: string; cwd: string; title: string; goal: string; modelId?: string; reasoningEffort?: ReasoningEffort; autonomy: Autonomy }) =>
  bridge.send({ type: 'mission.create', ...p });

export const sendToMission = (missionId: string, text: string) =>
  bridge.send({ type: 'mission.send', missionId, text });

export const respondPermission = (missionId: string, requestId: string, outcome: 'proceed_once' | 'proceed_always' | 'proceed_auto_run' | 'cancel') =>
  bridge.send({ type: 'mission.respondPermission', missionId, requestId, outcome });

export const respondQuestion = (missionId: string, requestId: string, cancelled: boolean, answers: { index: number; question: string; answer: string }[]) =>
  bridge.send({ type: 'mission.respondQuestion', missionId, requestId, cancelled, answers });

export const interruptMission = (missionId: string) => bridge.send({ type: 'mission.interrupt', missionId });
export const subscribeWorker = (missionId: string, workerSessionId: string) => bridge.send({ type: 'mission.subscribeWorker', missionId, workerSessionId });
export const closeMission = (missionId: string) => bridge.send({ type: 'mission.close', missionId });
```

- **Approve a proposed plan:** it's a `propose_mission` permission → `respondPermission(..., 'proceed_once')`. Reject → `'cancel'`.
- **Allow execution to start:** `start_mission_run` permission → same approve/reject.

---

## 7b. Session history (past missions)

Two extra commands let you browse and reopen past missions persisted on disk:

```ts
export const listSessions = () => bridge.send({ type: 'sessions.list' });
export const resumeMission = (sessionId: string) => bridge.send({ type: 'mission.resume', sessionId });
```

- `sessions.list` → replies `{ type: 'sessions.history', missions: HistoryMission[] }`
  where `HistoryMission = { sessionId, title, cwd?, modifiedTime, createdTime, messageCount }`.
  Only mission orchestrator sessions are returned (not regular chats).
- `mission.resume` loads the mission and replies with `mission.created`
  (`clientRef: "resume:<id>"`) plus a `mission.features` event, so it lands in the
  board view with its restored `phase` and features. Past transcript text is **not**
  replayed (the snapshot restores features/state only); new turns stream normally.

UI: add a "History" section/tab in the Sidebar. On app load (after `connect`), call
`listSessions()`; render the returned missions; clicking one calls `resumeMission` and
sets it active. Store these in a separate `history: HistoryMission[]` slice so they don't
mix with live `missions` until resumed.

## 8. Screens & components (map to existing files)

Route the **main pane** by `missions[activeMissionId].phase`:

| Phase | Screen | Build in |
|---|---|---|
| no active mission | **New Mission** form (title, goal, cwd via `pickDirectory()`, model, autonomy) → `createMission` with a generated `clientRef` | new `NewMission.tsx` |
| `intake` / `planning` | **Orchestrator chat** (transcript stream + `PromptInput`) | rework `ChatView.tsx` + `PromptInput.tsx` to read `transcripts[activeMissionId]` and call `sendToMission` |
| `awaiting_plan_approval` | **Plan Review** — render `mission.proposal` markdown; Approve/Reject buttons | new `PlanReview.tsx` |
| `awaiting_run_start` | **Run confirmation** banner (Approve/Reject `start_mission_run`) | inline in mission view |
| `initializing` / `running` / `orchestrator_turn` / `paused` | **Mission Control board** — feature cards from `mission.features` grouped by `milestone`, each showing `status`, current worker, skill; live activity feed from `progress`; toolbar (Pause=`interrupt`) | new `MissionBoard.tsx` |
| `completed` / `failed` | **Summary** — final state, token/cost totals, feature outcomes | new `MissionSummary.tsx` |

Other components:
- **`Sidebar.tsx`** → mission list from `missionOrder`/`missions`, showing title + phase badge + token count; click sets `activeMissionId`; "＋ New Mission" button.
- **`RightPanel.tsx`** → **Agent detail drawer**: when a worker is selected, `subscribeWorker` and show that `agentSessionId`'s transcript; also show the selected feature's `preconditions`/`expectedBehavior`/`verificationSteps`.
- **`StatusBar.tsx`** → active mission phase, total tokens in/out, connection status.
- **`PermissionModal.tsx`** (new) → driven by `pendingPermission`. Render by `kind`:
  exec → command; edit/create/apply_patch → file path (+ diff if present in `raw`);
  mcp → tool + impact. Buttons map to outcomes (`proceed_once`, `proceed_always`,
  `proceed_auto_run`, `cancel`).
- **`QuestionModal.tsx`** (new) → driven by `pendingQuestion`. One block per question with
  its `options` as choices plus a free-text field; submit → `respondQuestion`.
- **`Settings.tsx`** (new) → API key (get/set/clear via Tauri), default model id,
  default autonomy, reasoning effort. Trigger `connect` after saving the key.

Keep the existing `CommandPalette.tsx`, framer-motion transitions, and the
`droid-*` tailwind palette.

---

## 9. Models / autonomy values

- `autonomy`: `'off' | 'low' | 'medium' | 'high'`.
- `reasoningEffort` (optional): `'off' | 'none' | 'low' | 'medium' | 'high' | 'max'`.
- `modelId`: a Factory model id string (e.g. leave blank to use the daemon default; expose a text/select field in Settings).
- Mission mode is fixed by the sidecar (`DroidInteractionMode.AGI`). You don't set it.

---

## 10. Run it

Terminal A (or rely on Tauri's `beforeDevCommand`):
```bash
npm run dev            # vite on :1420
```
Terminal B:
```bash
npm run tauri dev      # builds Rust, which spawns the sidecar automatically
```

The sidecar runs from `sidecar/dist/sidecar.mjs` (already built). If you change sidecar
code: `cd sidecar && npm run build`. To point Rust at a different entry during dev, set
`SIDECAR_ENTRY=/abs/path/to/sidecar.mjs`. Default WS port is `8765` (override `BRIDGE_PORT`).

Requires the `droid` CLI installed and logged in (the daemon is what actually runs missions).

---

## 11. Suggested build order

1. `types/bridge.ts` + `lib/tauri.ts` + `lib/bridge.ts` (the contract).
2. New `useStore` with the event→state reducer; log every `ServerEvent` to console first.
3. Settings + connect flow (get the key in, see `connection: connected`).
4. New Mission form → create a mission, watch transcript stream in a temporary list.
5. Plan Review + Permission + Question modals (these unblock the mission lifecycle).
6. Mission Board (features + progress) and Sidebar mission list.
7. Agent detail drawer (worker subscription) + Status bar polish.
