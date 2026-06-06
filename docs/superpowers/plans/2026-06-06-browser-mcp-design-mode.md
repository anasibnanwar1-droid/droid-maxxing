# Browser MCP Design Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a lightweight in-app browser canvas that both the user and Droid agents can control, plus a Cursor-style Design Mode for selecting elements, sketching annotations, and sending precise UI-change prompts.

**Architecture:** Use `agent-browser` as the canonical browser engine because it already provides Chrome/CDP control, screenshots, compact accessibility refs, React inspection, and streaming without adding Playwright/Puppeteer. Droid Control owns the app UI and state. Droid agents access the same browser session through a small sidecar-owned MCP server, so human actions and agent tool calls share one live browser context.

**Tech Stack:** Tauri 2, React 19, TypeScript, Node sidecar, `@factory/droid-sdk`, stdio MCP, `agent-browser`, existing WebSocket bridge.

---

## Product Shape

Build a browser workspace, not a Webflow clone.

The browser surface is a responsive canvas in Droid Control with:

- URL bar, reload, back/forward, viewport size indicator, screenshot refresh.
- Separate user cursor and agent cursor overlays.
- Browser interaction from the canvas: click, type, scroll, keypress.
- Agent tools: navigate, screenshot, snapshot refs, click, type, scroll, inspect selected references.
- Design Mode: hover/select DOM target, multi-select references, freeze current viewport, sketch circles/boxes/freehand strokes, attach a comment, send the packed context to the active Droid session.

Out of scope for the first build:

- Full drag-and-drop editing.
- Persisted visual editor layout model.
- Voice input.
- Pixel-perfect source mapping for every framework.
- Browser history sync across old local app states.

## Current-State Constraints

- `/Users/anas/Documents/droid-control` is now the baseline git checkout, pushed to `main`.
- Active frontend work remains in `/Users/anas/Documents/droid-control`; do not touch it for this feature.
- Browser/MCP work happens in `/Users/anas/Documents/droid-control-browser-mcp` on `feature/browser-mcp-design-mode`.
- `droid exec --list-tools --output-format json` currently does not expose browser-control tools.
- `agent-browser` exists at `/Users/anas/.factory/bin/agent-browser`; its skill data exists at `/Users/anas/.factory/tools/agent-browser/skill-data`.
- The implementation must use one canonical current-state path. If `agent-browser` is missing or unusable, Browser Mode fails fast with explicit recovery instructions.

## Target File Structure

- Create: `sidecar/src/browser/AgentBrowserRuntime.ts`
  - Resolve and run `agent-browser` commands.
  - Own session name, env, command timeout, JSON parsing, screenshot path handling.
  - No direct React/UI knowledge.

- Create: `sidecar/src/browser/BrowserSessionManager.ts`
  - Keep browser sessions keyed by Droid Control mission id.
  - Store latest URL, title, screenshot path, viewport, refs, selected design references, and last error.
  - Convert canvas coordinates to browser viewport coordinates.

- Create: `sidecar/src/browser/browserMcpServer.ts`
  - Stdio MCP server exposing the canonical browser tools for Droid sessions.
  - Delegates to `agent-browser` using the same session name the UI uses.

- Modify: `sidecar/src/DroidRuntime.ts`
  - Accept optional browser MCP config in `CreateRuntimeSessionOptions`.
  - Pass `mcpServers` into `initializeSession`.

- Modify: `sidecar/src/MissionManager.ts`
  - Handle browser bridge commands.
  - Attach browser MCP to new sessions when Browser Mode is active.
  - Send design-reference prompt packs to the active mission.

- Modify: `sidecar/src/protocol.ts` and `src/types/bridge.ts`
  - Add browser command/event types.
  - Keep the two protocol files synchronized.

- Modify: `src/lib/commands.ts` and `src/lib/bridge.ts`
  - Add typed browser command helpers.

- Modify: `src/hooks/useStore.tsx`
  - Add browser/design-mode state and reducers.

- Create: `src/components/browser/BrowserWorkspace.tsx`
  - Top-level browser workspace layout.

- Create: `src/components/browser/BrowserCanvas.tsx`
  - Screenshot/canvas renderer and pointer event forwarding.

- Create: `src/components/browser/DesignModeOverlay.tsx`
  - Hover boxes, selected refs, frozen screenshot overlay, drawing strokes.

- Create: `src/components/browser/DesignPromptBar.tsx`
  - Comment box for selected/sketched references.

- Modify: `src/App.tsx`
  - Add browser workspace as a center-panel mode without disturbing chat and mission views.

- Create: `sidecar/src/browser/AgentBrowserRuntime.test.ts`
  - Unit tests with a fake command runner.

- Create: `sidecar/src/browser/BrowserSessionManager.test.ts`
  - Unit tests for coordinate mapping and design-reference packing.

- Modify: `sidecar/package.json`
  - Add `test` script using existing `tsx`.

## Data Contracts

```ts
export interface BrowserViewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
}

export interface BrowserSnapshotRef {
  ref: string;
  role?: string;
  name?: string;
  text?: string;
  selector?: string;
  box?: { x: number; y: number; width: number; height: number };
}

export interface DesignReference {
  id: string;
  kind: 'element' | 'region' | 'stroke';
  url: string;
  title?: string;
  viewport: BrowserViewport;
  screenshotPath: string;
  scroll: { x: number; y: number };
  element?: BrowserSnapshotRef;
  box?: { x: number; y: number; width: number; height: number };
  points?: { x: number; y: number }[];
  note?: string;
}

export interface DesignPromptPack {
  missionId: string;
  browserSessionId: string;
  createdAt: string;
  instruction: string;
  references: DesignReference[];
}
```

## Agent-Facing MCP Tools

Expose these MCP tools:

- `browser_open({ url })`
- `browser_snapshot({ interactiveOnly?: boolean })`
- `browser_screenshot({ fullPage?: boolean })`
- `browser_click({ ref?: string, x?: number, y?: number })`
- `browser_type({ text })`
- `browser_keypress({ key })`
- `browser_scroll({ direction, pixels? })`
- `browser_design_context({ referenceIds?: string[] })`

Tool behavior:

- `browser_snapshot` returns compact refs like `@e1`, URL, title, and visible text snippets.
- `browser_screenshot` returns a saved PNG path under `~/.factory/droid-control/browser/<session>/`.
- `browser_design_context` returns the JSON prompt pack and screenshot paths for the selected/sketched references.
- Every mutating tool refreshes the latest screenshot and emits a bridge event so the UI canvas updates.

## Task 1: Worktree and Baseline Guard

**Files:**
- No code files.

- [ ] **Step 1: Confirm the isolated worktree**

Run:

```bash
git -C /Users/anas/Documents/droid-control-browser-mcp status --short --branch
```

Expected:

```text
## feature/browser-mcp-design-mode
```

- [ ] **Step 2: Confirm the active frontend checkout is not touched**

Run:

```bash
git -C /Users/anas/Documents/droid-control status --short --branch
```

Expected: user frontend changes may appear, but no browser/MCP feature files should appear there.

- [ ] **Step 3: Commit only inside the feature worktree**

Run commits from:

```bash
/Users/anas/Documents/droid-control-browser-mcp
```

Expected: all feature commits land on `feature/browser-mcp-design-mode`.

## Task 2: Browser Runtime Wrapper

**Files:**
- Create: `sidecar/src/browser/AgentBrowserRuntime.ts`
- Create: `sidecar/src/browser/AgentBrowserRuntime.test.ts`
- Modify: `sidecar/package.json`

- [ ] **Step 1: Add the sidecar test script**

In `sidecar/package.json`, add:

```json
{
  "scripts": {
    "test": "tsx --test src/**/*.test.ts"
  }
}
```

Keep the existing scripts unchanged.

- [ ] **Step 2: Write runtime tests first**

Create `sidecar/src/browser/AgentBrowserRuntime.test.ts` with cases for:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentBrowserRuntime } from './AgentBrowserRuntime.js';

test('open runs agent-browser with the configured session name', async () => {
  const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const runtime = new AgentBrowserRuntime({
    binPath: '/tmp/agent-browser',
    sessionName: 'droid-control-test',
    runCommand: async (args, env) => {
      calls.push({ args, env });
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });

  await runtime.open('http://127.0.0.1:1420/');

  assert.deepEqual(calls[0].args, ['open', 'http://127.0.0.1:1420/']);
  assert.equal(calls[0].env.AGENT_BROWSER_SESSION_NAME, 'droid-control-test');
});
```

Add similar tests for screenshot path parsing, JSON snapshot parsing, and non-zero exit errors.

- [ ] **Step 3: Implement the runtime**

Create `sidecar/src/browser/AgentBrowserRuntime.ts` with:

```ts
export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type RunCommand = (args: string[], env: NodeJS.ProcessEnv) => Promise<CommandResult>;

export interface AgentBrowserRuntimeOptions {
  binPath?: string;
  sessionName: string;
  runCommand?: RunCommand;
}

export class AgentBrowserRuntime {
  constructor(private readonly options: AgentBrowserRuntimeOptions) {}

  async open(url: string): Promise<void> {
    await this.run(['open', url]);
  }

  async screenshot(fullPage = false): Promise<string> {
    const result = await this.run(['screenshot', ...(fullPage ? ['--full'] : [])]);
    return result.stdout.trim();
  }

  async snapshot(): Promise<unknown> {
    const result = await this.run(['snapshot', '-i', '--json']);
    return JSON.parse(result.stdout);
  }

  async clickRef(ref: string): Promise<void> {
    await this.run(['click', ref]);
  }

  async clickPoint(x: number, y: number): Promise<void> {
    await this.run(['mouse', 'move', String(x), String(y)]);
    await this.run(['mouse', 'down']);
    await this.run(['mouse', 'up']);
  }

  async type(text: string): Promise<void> {
    await this.run(['keyboard', 'type', text]);
  }

  async keypress(key: string): Promise<void> {
    await this.run(['press', key]);
  }

  async scroll(direction: 'up' | 'down' | 'left' | 'right', pixels = 500): Promise<void> {
    await this.run(['scroll', direction, String(pixels)]);
  }

  private async run(args: string[]): Promise<CommandResult> {
    const runCommand = this.options.runCommand ?? defaultRunCommand(this.binPath());
    const env = {
      ...process.env,
      AGENT_BROWSER_SESSION_NAME: this.options.sessionName,
      AGENT_BROWSER_SKILLS_DIR: process.env.AGENT_BROWSER_SKILLS_DIR ?? '/Users/anas/.factory/tools/agent-browser/skill-data',
    };
    const result = await runCommand(args, env);
    if (result.exitCode !== 0) {
      throw new Error(`agent-browser ${args[0]} failed: ${result.stderr || result.stdout}`);
    }
    return result;
  }

  private binPath(): string {
    return this.options.binPath ?? process.env.AGENT_BROWSER_PATH ?? '/Users/anas/.factory/bin/agent-browser';
  }
}
```

Implement `defaultRunCommand` with `spawn` and no shell.

- [ ] **Step 4: Run runtime tests**

Run:

```bash
cd /Users/anas/Documents/droid-control-browser-mcp/sidecar
npm run test -- AgentBrowserRuntime.test.ts
```

Expected: all runtime tests pass.

## Task 3: Browser Session Manager

**Files:**
- Create: `sidecar/src/browser/BrowserSessionManager.ts`
- Create: `sidecar/src/browser/BrowserSessionManager.test.ts`

- [ ] **Step 1: Test coordinate scaling**

Create a test proving screenshot coordinates map to viewport coordinates:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { scalePointToViewport } from './BrowserSessionManager.js';

test('scalePointToViewport maps canvas point into browser viewport', () => {
  assert.deepEqual(
    scalePointToViewport(
      { x: 360, y: 225 },
      { width: 720, height: 450 },
      { width: 1440, height: 900, deviceScaleFactor: 1 },
    ),
    { x: 720, y: 450 },
  );
});
```

- [ ] **Step 2: Implement manager**

Implement:

```ts
export function scalePointToViewport(
  point: { x: number; y: number },
  canvas: { width: number; height: number },
  viewport: BrowserViewport,
): { x: number; y: number } {
  return {
    x: Math.round((point.x / canvas.width) * viewport.width),
    y: Math.round((point.y / canvas.height) * viewport.height),
  };
}
```

Add `BrowserSessionManager` with `open`, `screenshot`, `snapshot`, `click`, `type`, `scroll`, `addDesignReference`, and `designContext`.

- [ ] **Step 3: Run manager tests**

Run:

```bash
cd /Users/anas/Documents/droid-control-browser-mcp/sidecar
npm run test -- BrowserSessionManager.test.ts
```

Expected: all manager tests pass.

## Task 4: Browser Bridge Protocol

**Files:**
- Modify: `sidecar/src/protocol.ts`
- Modify: `src/types/bridge.ts`
- Modify: `src/lib/commands.ts`

- [ ] **Step 1: Add client commands**

Add:

```ts
| { type: 'browser.open'; missionId?: string; url: string }
| { type: 'browser.refresh'; missionId?: string }
| { type: 'browser.click'; missionId?: string; x: number; y: number; canvasWidth: number; canvasHeight: number }
| { type: 'browser.type'; missionId?: string; text: string }
| { type: 'browser.keypress'; missionId?: string; key: string }
| { type: 'browser.scroll'; missionId?: string; direction: 'up' | 'down' | 'left' | 'right'; pixels?: number }
| { type: 'browser.design.addReference'; missionId: string; reference: DesignReference }
| { type: 'browser.design.sendPrompt'; missionId: string; instruction: string; referenceIds: string[] }
```

- [ ] **Step 2: Add server events**

Add:

```ts
| { type: 'browser.updated'; state: BrowserState }
| { type: 'browser.error'; missionId?: string; message: string }
```

- [ ] **Step 3: Add command helpers**

In `src/lib/commands.ts`, export `openBrowser`, `refreshBrowser`, `clickBrowser`, `typeBrowser`, `keypressBrowser`, `scrollBrowser`, `addDesignReference`, and `sendDesignPrompt`.

- [ ] **Step 4: Run typecheck**

Run:

```bash
npm run build
```

Expected: TypeScript succeeds.

## Task 5: Sidecar Browser Command Handling

**Files:**
- Modify: `sidecar/src/MissionManager.ts`
- Modify: `sidecar/src/DroidRuntime.ts`

- [ ] **Step 1: Add a BrowserSessionManager field**

In `MissionManager`, add:

```ts
private readonly browsers = new BrowserSessionManager((event) => this.emit(event));
```

- [ ] **Step 2: Handle browser commands in `handle`**

Add cases for every `browser.*` command. Each case calls the browser manager and emits `browser.updated` or `browser.error`.

- [ ] **Step 3: Add browser MCP config to Droid sessions**

Pass an MCP server config when a mission/session has browser tools enabled:

```ts
mcpServers: [{
  name: 'droid-control-browser',
  command: process.execPath,
  args: [browserMcpEntryPath()],
  env: {
    DROID_CONTROL_BROWSER_SESSION: browserSessionName,
    AGENT_BROWSER_PATH: resolvedAgentBrowserPath,
    AGENT_BROWSER_SKILLS_DIR: resolvedAgentBrowserSkillsDir,
  },
}]
```

Use explicit failure if `agent-browser` is missing:

```text
Browser tools unavailable: /Users/anas/.factory/bin/agent-browser was not found. Install or repair Factory agent-browser, then reopen Browser Mode.
```

- [ ] **Step 4: Run build**

Run:

```bash
cd /Users/anas/Documents/droid-control-browser-mcp/sidecar
npm run build
```

Expected: sidecar bundle succeeds.

## Task 6: Browser MCP Server

**Files:**
- Create: `sidecar/src/browser/browserMcpServer.ts`
- Modify: `sidecar/package.json`

- [ ] **Step 1: Add explicit MCP SDK dependency**

In `sidecar/package.json`, add:

```json
"@modelcontextprotocol/sdk": "^1.29.0"
```

This dependency already exists transitively through `@factory/droid-sdk`; making it explicit prevents accidental breakage.

- [ ] **Step 2: Implement stdio MCP tools**

Create a server that registers the tools listed in “Agent-Facing MCP Tools”. Each tool creates `AgentBrowserRuntime` with:

```ts
const sessionName = process.env.DROID_CONTROL_BROWSER_SESSION;
if (!sessionName) throw new Error('DROID_CONTROL_BROWSER_SESSION is required');
```

Each tool returns compact text or JSON, not large base64 images. Screenshot tools return local file paths.

- [ ] **Step 3: Bundle MCP server**

Update sidecar build to emit both:

```bash
dist/sidecar.mjs
dist/browser-mcp.mjs
```

- [ ] **Step 4: Verify MCP server starts**

Run:

```bash
cd /Users/anas/Documents/droid-control-browser-mcp/sidecar
npm run build
node dist/browser-mcp.mjs
```

Expected: server waits for stdio MCP messages and does not crash on startup.

## Task 7: React Store and Workspace

**Files:**
- Modify: `src/hooks/useStore.tsx`
- Modify: `src/App.tsx`
- Create: `src/components/browser/BrowserWorkspace.tsx`
- Create: `src/components/browser/BrowserCanvas.tsx`

- [ ] **Step 1: Add browser state**

Add to `AppState`:

```ts
browserOpen: boolean;
browser?: BrowserState;
designMode: boolean;
```

Add actions for `BROWSER_UPDATED`, `BROWSER_ERROR`, `TOGGLE_BROWSER`, `TOGGLE_DESIGN_MODE`.

- [ ] **Step 2: Add BrowserWorkspace**

The workspace should be a center-panel mode:

```tsx
<BrowserWorkspace missionId={activeMission?.id} />
```

Use the existing dark Droid palette and avoid nested cards.

- [ ] **Step 3: Add BrowserCanvas**

Render the latest screenshot path as an image. Forward pointer events to browser commands with the rendered image size.

- [ ] **Step 4: Run build**

Run:

```bash
npm run build
```

Expected: frontend build succeeds.

## Task 8: Design Mode Overlay

**Files:**
- Create: `src/components/browser/DesignModeOverlay.tsx`
- Create: `src/components/browser/DesignPromptBar.tsx`
- Modify: `src/components/browser/BrowserWorkspace.tsx`

- [ ] **Step 1: Add selection mode**

When Design Mode is active:

- Click selects the nearest browser snapshot ref.
- Shift-click adds another ref.
- Escape clears pending selection.
- Selected refs render as thin orange outlines with numbered chips.

- [ ] **Step 2: Add sketch mode**

Add a pencil button. When active:

- Freeze the current screenshot.
- Record pointer strokes in screenshot-relative coordinates.
- Render strokes above the frozen screenshot.

- [ ] **Step 3: Add prompt bar**

The prompt bar sends:

```ts
sendDesignPrompt(missionId, instruction, selectedReferenceIds)
```

Disable send until there is an active mission, non-empty instruction, and at least one reference.

- [ ] **Step 4: Verify manually in Browser**

Run:

```bash
npm run dev -- --host 127.0.0.1 --port 1420
```

Open `http://127.0.0.1:1420/`, switch to Browser Mode, open a local app URL, select one element, sketch one circle, and send a design prompt.

Expected: the chat receives a prompt containing element metadata plus screenshot path.

## Task 9: Design Prompt Packaging

**Files:**
- Modify: `sidecar/src/browser/BrowserSessionManager.ts`
- Modify: `sidecar/src/MissionManager.ts`

- [ ] **Step 1: Save prompt packs**

Write prompt packs under:

```text
~/.factory/droid-control/design-references/<missionId>/<referenceId>.json
```

Do not store base64 in chat messages.

- [ ] **Step 2: Send compact instruction to Droid**

Format:

```text
Design Mode reference pack:
- URL: <url>
- Screenshot: <path>
- References JSON: <path>

User instruction:
<instruction>
```

- [ ] **Step 3: Run a live smoke**

Start a chat, open Browser Mode, capture a reference, send “remove this dot pattern,” and verify the Droid transcript contains the reference pack paths.

## Task 10: Verification and Ship

**Files:**
- All changed files.

- [ ] **Step 1: Run sidecar tests**

```bash
cd /Users/anas/Documents/droid-control-browser-mcp/sidecar
npm run test
```

Expected: all tests pass.

- [ ] **Step 2: Run sidecar build**

```bash
cd /Users/anas/Documents/droid-control-browser-mcp/sidecar
npm run build
```

Expected: sidecar and browser MCP bundles build.

- [ ] **Step 3: Run root build**

```bash
cd /Users/anas/Documents/droid-control-browser-mcp
npm run build
```

Expected: TypeScript and Vite build succeed.

- [ ] **Step 4: Browser visual smoke**

Use the in-app Browser at 1440×900 and 390×844.

Check:

- Browser canvas scales without overlapping the prompt bar.
- Pointer coordinates map correctly after resize.
- Agent cursor overlay and user cursor overlay are visually distinct.
- Design Mode selected refs remain aligned after screenshot refresh.
- Prompt bar text does not overflow.

- [ ] **Step 5: Commit and push feature branch**

```bash
git add .
git commit -m "Add browser MCP design mode foundation"
git push -u origin feature/browser-mcp-design-mode
```

Expected: branch exists on `anasibnanwar1-droid/droid-maxxing`.

## Caveats and Trade-Offs

- Screenshot canvas over embedded webview: a canvas gives reliable agent control, screenshots, and cross-origin behavior. A true embedded webview feels more native but is harder to inspect/control consistently and breaks on frame restrictions.
- `agent-browser` dependency: this keeps implementation lightweight and avoids Playwright/Puppeteer downloads, but it must be treated as a required local runtime with fail-fast diagnostics.
- Source mapping: React component names/source are best-effort and mostly reliable in dev builds. Production/minified pages may only provide DOM selectors, text, styles, and screenshots.
- Existing Droid sessions: sessions created before Browser Mode may need MCP attachment or a new session. Do not add compatibility shims for old local states.
- Voice input: Cursor has it, but the first Droid implementation should ship text, element refs, and sketches first.
- Streaming: continuous streaming is nice but not required for MVP. Start with screenshot refresh after actions, then add streaming only if interaction feels too slow.

## Decision

Use `agent-browser` as the canonical browser engine and expose it through Droid Control’s sidecar plus MCP. This is the smallest maintainable path to “Droid can use the browser like Codex Browser does” while preserving a good interactive canvas for the user.
