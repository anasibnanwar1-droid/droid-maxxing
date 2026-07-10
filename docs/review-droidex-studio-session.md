# DROIDEX Studio — work completed (review packet)

**Branch:** `feat/droidex-design-platform`  
**Worktree:** `/Users/anas/Documents/droid-control-droidex`  
**Range:** `6de206d` … `b85f672` (20 commits on top of earlier M1/M2 studio base)  
**Tree status:** clean (all changes committed)  
**Verify:** `npm run typecheck` · `npm run sidecar:typecheck` · `npm run sidecar:test`  
**Note:** precommit lint is known-broken on WIP; commits used `-n`.

This packet is for agent review. Prefer reading the commits and the listed files over re-deriving product intent from chat.

---

## Product context (short)

DROIDEX Studio is an agent-native design surface inside droid-control: infinite live canvas + left chat/DNA shelves. Design sessions are **normal chats** (`interactionMode: 'auto'`, title `"Design"`) — never `mission_orchestrator` / Mission Control.

Roadmap: `docs/design-roadmap.md` (M1 canvas + M2 DNA already base; this arc = crash fix, preview harness, isolation, studio UX, DNA keep/library, multi-thread).

---

## Commit log (newest first)

| SHA | Summary |
|-----|---------|
| `b85f672` | Auto-approve tool/MCP permissions for Design Studio sessions; autonomy high |
| `4dfccec` | Snap reasoning when switching models (studio + main chat picker) |
| `673bc69` | History icon beside Libraries; store-backed canvas; new/switch; user prompt echo |
| `6be89c0` | Thread history menu + per-thread canvas HYDRATE |
| `0c5c256` | `sanitizeAgent` no longer wipes custom/unknown model picks on `MODELS_LIST` |
| `b87bc26` | Wire isolated `droidex/design` worktree into studio cwd |
| `7ad6bba` | Adopt active chat into studio; model picker applies live via `settings.agent.update` |
| `85fdfd4` | “Keep this direction” UI + Your directions list + Selected badge |
| `dc7b004` | Saved DNA backend (`design.dna.finalize` / saved* / active marker) |
| `7359154` | Ask-user docks inline above studio composer (not full-screen) |
| `cf597c9` | Rename MCP namespaces `droidmaxx-*` → `droidex-*` |
| `36edbf6` | Two-row composer (model name never collapses/overlaps) |
| `0742782` | Reasoning selector, overflow attempt, stop button while streaming |
| `011416c` | Design-chat responses render markdown (not raw `**`) |
| `e44111c` | Isolated worktree core (`prepareDesignWorkspace`, tests) |
| `d2bb273` | `design_preview` MCP tool → canvas frame |
| `720c214` | Guidelines: brand intake, canvas preview, persist DNA, isolation awareness |
| `586b616` | Brand book as live canvas frame |
| `9ad090c` | Preview harness + brand-book generator (tmp-dir server) |
| `6de206d` | Block self-embedding frames (CPU/wakeup storm) |

Earlier on same branch (context, not this review’s primary focus): M1 canvas (`8909107`), M2 DNA interview (`0dec780`), theme-aware, settings, DNA-as-intent, agent authoring session, etc.

---

## Feature areas (what to review)

### 1. Crash: self-embed / kernel wakeup storm — `6de206d`

**Problem:** Frame pointed at the app’s own origin recursively embedded the app → nested Vite HMR → node process ~8k wakes/s, kernel_task 100%.

**Fix:** Reuse `isSelfBrowserUrl` in `StudioFrameBody` (block render) + `AddFrameDialog` (block add); iframe sandbox; skip redundant onLoad dispatch; `MAX_FRAMES = 24`.

**Key files:**  
`src/components/studio/StudioFrameBody.tsx`, `AddFrameDialog.tsx`, `StudioCanvasContext.tsx`  
`src/components/browser/browserUrlSafety.ts` (existing)

**Review focus:** Origin/loopback edge cases; whether any path still allows self-embed; MAX_FRAMES UX.

---

### 2. Preview harness + brand book — `9ad090c`, `586b616`, `d2bb273`, `720c214`

**What:**  
- `PreviewServer`: free port, path-traversal-safe static serve, `127.0.0.1`, `cache-control: no-store`.  
- `renderBrandBook`: deterministic DNA → professional brand-guidelines HTML (tokens, type, contrast math, sanitization).  
- Writes under OS tmpdir (`droidex-preview/`), never project tree.  
- `design.preview.render` + event `design.preview` → canvas showcase frame.  
- MCP `design_preview` for agent-authored HTML/prototypes onto canvas (not `browser_open`).  
- Guidelines: ask brand/company/logo; preview on canvas; persist DNA; keep artifacts.

**Key files:**  
`sidecar/src/design/previewServer.ts`, `brandBook.ts`, `brandBook.test.ts`, `previewServer.test.ts`  
`sidecar/src/design/DesignManager.ts`, `designMcpServer.ts`, `guidelines.ts`  
`src/components/studio/usePreviewFrames.ts`, `DnaShelf.tsx`  
protocol dual-edit: `sidecar/src/protocol.ts` + `src/types/bridge.ts`

**Security:** `safeColor` / `safeFont` / HTML esc; path confined to registered dir; hostile-input tests.

**Review focus:** Path traversal; injection in token values; tmpdir lifecycle; stable frame id / reload-in-place.

---

### 3. Isolation: agent never writes live tree — `e44111c`, `b87bc26`

**What:**  
- `prepareDesignWorkspace(liveCwd)` → linked worktree on branch `droidex/design` under `.worktrees/droidex-design` (or work in place if not a git repo).  
- Seeds uncommitted `DESIGN.md` / `MOTION.md` into worktree.  
- Repo-local exclude so `.worktrees/` doesn’t dirty status.  
- Studio: `design.workspace.prepare` on open → `design.workspace.ready` → agent/session `cwd` = worktree path; **session key** remains live path.

**Key files:**  
`sidecar/src/design/isolatedWorkspace.ts` (+ tests)  
`DesignManager.prepareWorkspace` cache  
`src/components/design/DesignStudio.tsx` (`liveCwd` vs `cwd`)  
`useDesignSession(cwd, sessionKey)`

**Review focus:**  
- Session keyed by live path while process cwd is worktree — correlation of `EXPECT_SESSION` / `mission.created`.  
- DNA/library/preview keyed by which path?  
- Non-git fallback note.  
- Worktree reuse / collision / seed overwrite.

---

### 4. Studio chat UX polish — `011416c`, `0742782`, `36edbf6`, `7359154`, `cf597c9`

| Item | Behavior |
|------|----------|
| Markdown | `SessionThread` uses shared `Markdown` for assistant text |
| Stop | While streaming → `interruptMission` |
| Reasoning selector | Shown when model has multiple `supportedReasoningEfforts` |
| Composer layout | Two rows: selectors wrap; attach + send below (no min-w-0 collapse) |
| Ask-user | `AskUserModal` `inline` in AgentPanel when `pendingQuestion.missionId === sessionId`; global modal suppressed while `design.studioOpen` |
| Branding | MCP servers `droidex-browser` / `droidex-design` |

**Review focus:** Ask-user stacking when studio open; dual modal races; markdown in narrow 336px column.

---

### 5. DNA finalize / library — `dc7b004`, `85fdfd4`

**What:**  
- Persist settled DNA as re-applicable entry under App Support (`saved-dna.json` + `active-dna.json` via `projectDesignDir`).  
- Commands: `design.dna.finalize`, `savedList`, `savedApply`, `savedDelete` + event `design.dna.saved`.  
- UI: “Keep this direction”, **Your directions** with Apply/Delete/Selected.  
- Auto `readDesignDna` on shelf mount / session attach (agent may write DESIGN.md via file tools, no watcher).

**Key files:**  
`sidecar/src/design/savedDna.ts` (+ tests), `dnaFiles.ts` (`activeSavedId`), `DesignManager` cases  
`src/hooks/useDesignStore.tsx` (`savedDna`, `activeDnaId`)  
`DnaShelf.tsx`

**Review focus:** Apply curated library clears active; finalize without tokens; path keyed by worktree vs live cwd for saved DNA.

---

### 6. Multi-thread + canvas restore — `6be89c0`, `673bc69`

**What:**  
- History **icon only** next to Libraries (and top bar).  
- List design/chat threads for project (live + worktree paths).  
- **New** → `SET_SESSION` with `missionId: null` → `sessions[key] = ''` (intentional empty; blocks auto-adopt).  
- **Switch** → `SAVE_CANVAS` into `design.canvasByThread` + `HYDRATE` on canvas reducer.  
- Snapshots store-backed (survive StudioShell remount when worktree path resolves).  
- Optimistic user bubble: `MISSION_TRANSCRIPT` local echo; first create uses `SET_PENDING_COMPOSE`.

**Key files:**  
`ThreadHistoryMenu.tsx`, `AgentPanel.tsx`, `StudioShell.tsx`, `TopBar.tsx`  
`StudioCanvasContext` (`HYDRATE`, `emptyStudioCanvasState`)  
`useDesignStore` (`SET_SESSION`, `SAVE_CANVAS`, `canvasByThread`, `ADOPT_SESSION`)  
`useDesignSession.ts`

**Known residual risks for reviewers:**  
- Canvas restore is **in-memory store only** (lost on full app reload).  
- Thread list quality depends on mission titles/kinds and cwd matching.  
- `listMissions` on menu open is fire-and-forget (can lag).  
- No skeleton loaders for cold history yet.

---

### 7. Model / reasoning correctness — `7ad6bba`, `0c5c256`, `4dfccec`, `b85f672`

| Issue | Fix |
|-------|-----|
| Studio model only affected create | Live session → `updateAgentSettings` immediately |
| Main chat pick wiped to Default | `sanitizeAgent`: empty catalog / unknown id keeps pick |
| Reasoning stuck on `max` after switch | Snap to new model’s default/supported set (studio + `ModelSelectorPopover`) |
| MCP permission prompts mid-design | Design sessions (`title === 'Design'`, not orchestrator): auto `proceed_always` for tool/MCP; plan/run still prompt; `autonomy: 'high'` |

**Key files:**  
`useDesignSession.ts`, `StudioComposer.tsx`, `ModelSelectorPopover.tsx`  
`src/hooks/useStore.tsx` (`sanitizeAgent`)  
`sidecar/src/MissionManager.ts` (`makePermissionHandler`, `isDesignStudioSession`)

**Review focus:**  
- Over-broad auto-approve (title `"Design"` only — confirm no collision).  
- `sanitizeAgent` keeping unknown ids forever if catalog never includes custom GLM.  
- Reasoning snap effect dependency loops in composer.

---

## Architecture notes (for reviewers)

```
DesignStudio
  liveCwd = active mission cwd | workspaceCwds[0]
  prepareDesignWorkspace(liveCwd) → worktree path
  StudioShell(cwd=worktree|live, sessionKey=liveCwd)
    AgentPanel + ThreadHistoryMenu
    useDesignSession(cwd, sessionKey)  // process cwd vs session map key
    StudioCanvas + usePreviewFrames(cwd)
```

**Protocol dual-edit rule:** every new `design.*` command/event must land in both `sidecar/src/protocol.ts` and `src/types/bridge.ts`.

**Design vs chat:** design sessions must stay `interactionMode: 'auto'` and title `"Design"` (permission auto-approve + Mission Control avoidance both depend on this).

---

## Test coverage (automated)

- `sidecar/src/design/brandBook.test.ts` (incl. hostile tokens)  
- `sidecar/src/design/previewServer.test.ts` (serve + traversal)  
- `sidecar/src/design/isolatedWorkspace.test.ts` (create / idempotent / non-git)  
- `sidecar/src/design/savedDna.test.ts`  
- Existing browserUrlSafety / normalize tests updated for `droidex-*` rename  

**Not automated:** full Electron E2E (brand book on canvas, thread switch with live frames, permission auto-approve in real droid CLI).

---

## Explicitly NOT done (out of this packet)

1. **Richer intake** — multi-option directions → select → finalize (#22)  
2. Skeleton loaders while cold thread history rehydrates  
3. Custom model **listing** if missing from `droid exec --help` Custom Models parse (`DroidCliCatalog`) — wipe-on-refresh is fixed; absence from catalog is separate  
4. Persist canvas snapshots to disk across app restarts  
5. Full roadmap later phases (validator UI polish, component shelf swap, etc.) beyond what’s already on branch from M1/M2  

---

## Suggested review checklist

1. **Security:** preview path confinement; brand book injection; permission auto-approve scope.  
2. **Isolation:** worktree creation side effects; DNA/saved-dna keyed by which cwd.  
3. **Session model:** `sessions[key] === ''` vs missing key; adopt vs new; mission.created correlation with `EXPECT_SESSION`.  
4. **Canvas restore:** HYDRATE deep-copy correctness; interaction mode reset; preview frames re-added by `usePreviewFrames` after hydrate.  
5. **UX regressions:** composer two-row; ask-user inline; history icon placement; user message always visible on send.  
6. **Model/reasoning:** live updateSettings; sanitizeAgent; snap on switch.  

---

## How to run review

```bash
cd /Users/anas/Documents/droid-control-droidex
git log --oneline 6de206d^..HEAD
npm run typecheck
npm run sidecar:typecheck
npm run sidecar:test
# optional focused:
node --import tsx --test sidecar/src/design/*.test.ts
```

Primary review surface: commits above + files named in each section.  
Base for “before this arc”: parent of `6de206d` (or `b77e4eb` for studio authoring baseline).
