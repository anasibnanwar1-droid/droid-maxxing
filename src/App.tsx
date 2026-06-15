import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from './hooks/useStore';
import { AnimatePresence, motion } from 'framer-motion';
import { Monitor, PanelLeft } from 'lucide-react';
import { bridge } from './lib/bridge';
import {
  connect,
  listFactoryDefaults,
  listMissions,
  loadMissionHistory,
  sendNativeBrowserResult,
  subscribeWorker,
} from './lib/commands';
import { isEmbedded } from './lib/embed';
import { getApiKey } from './lib/desktop';
import { performNativeBrowserRequest } from './lib/nativeBrowserAgent';
import {
  activeMissionAfterNativeBrowserRequest,
  browserKeyForMission,
} from './lib/browserSessionIdentity';
import { WORKSPACE_BOOTSTRAP_SESSION_LIMIT } from './lib/workspaces';
import Sidebar from './components/Sidebar';
import ChatView from './components/ChatView';
import MissionControl from './components/MissionControl';
import PromptInput from './components/PromptInput';
import RightPanel from './components/RightPanel';
import EditorOpenMenu from './components/EditorOpenMenu';
import Toaster from './components/Toaster';
import { useRepoStatus } from './hooks/useRepoStatus';
import StatusBar from './components/StatusBar';
import CommandPalette from './components/CommandPalette';
import SettingsPanel, { applyTheme, paletteForMode } from './components/SettingsPanel';
import AskUserModal from './components/AskUserModal';
import SpecWikiModal from './components/SpecWikiModal';
import BrowserWorkspace from './components/browser/BrowserWorkspace';
import { isDesktop } from './lib/desktop';

function ContextListIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      className={className}
    >
      <circle cx="5" cy="8" r="1.6" />
      <line x1="10" y1="8" x2="19" y2="8" />
      <circle cx="5" cy="16" r="1.6" />
      <line x1="10" y1="16" x2="19" y2="16" />
    </svg>
  );
}

const BROWSER_PANE_MIN = 460;
const BROWSER_PANE_MAX = 1280;
const BROWSER_PANE_DEFAULT = 860;
const BROWSER_PANE_WIDTH_STORAGE_KEY = 'droid-browser-pane-width';

export default function App() {
  const { state, dispatch } = useStore();
  const embedded = isEmbedded();
  const activeMission = state.activeMissionId ? state.missions[state.activeMissionId] : null;
  const repoStatus = useRepoStatus(activeMission?.cwd ?? '');
  // The view is a real mission only when the active session is a mission orchestrator,
  // not merely because the global mission-compose flag is on.
  const isMissionView = !!activeMission && activeMission.kind === 'mission_orchestrator';
  const showBrowserPane = !embedded && state.browserOpen;
  const nativeBrowserPane = showBrowserPane && isDesktop();
  const focused = isMissionView;
  // A normal/spec session only has something worth showing once a message has
  // been sent (the first transcript is seeded from the opening prompt).
  const hasSessionContent =
    !!activeMission && (state.transcripts[activeMission.id]?.length ?? 0) > 0;
  // The context toggle is meaningful in Mission Control (always) and in a normal
  // chat only after it has content; otherwise there is nothing to open.
  const canToggleContext = isMissionView || hasSessionContent;
  // The context panel floats *over* the chat as an overlay (it does not shrink
  // the main scroll area), so the page scrollbar stays pinned to the window's
  // right edge instead of sliding inward and looking like a divider.
  const rightPanelVisible =
    !focused && !showBrowserPane && state.rightPanelOpen && hasSessionContent;
  const requestedHistory = useRef(new Set<string>());
  const [browserPaneWidth, setBrowserPaneWidth] = useState(() => initialBrowserPaneWidth());
  const setStoredBrowserPaneWidth = useCallback((width: number) => {
    const next = clampBrowserPane(width);
    setBrowserPaneWidth(next);
    try {
      localStorage.setItem(BROWSER_PANE_WIDTH_STORAGE_KEY, String(next));
    } catch {
      /* ignore */
    }
  }, []);

  const toggleBrowserPane = useCallback(() => {
    // Browser and the context panel are mutually exclusive — opening the browser
    // collapses the right panel so they never fight for horizontal space.
    if (!state.browserOpen) dispatch({ type: 'SET_RIGHT_PANEL', open: false });
    dispatch({ type: 'TOGGLE_BROWSER' });
  }, [dispatch, state.browserOpen]);

  const toggleRightPanel = useCallback(() => {
    const open = !state.rightPanelOpen;
    // Opening the context panel hides the browser pane while preserving the
    // chat-scoped native browser session.
    if (open && state.browserOpen) {
      dispatch({ type: 'SET_BROWSER_OPEN', open: false });
    }
    dispatch({ type: 'SET_RIGHT_PANEL', open });
  }, [dispatch, state.browserOpen, state.rightPanelOpen]);

  useEffect(() => {
    applyTheme(state.theme);
  }, [state.theme]);

  useEffect(() => {
    if (state.theme.mode !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => dispatch({ type: 'SET_THEME', theme: paletteForMode('system') });
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [state.theme.mode, dispatch]);

  useEffect(() => {
    if (embedded) return;
    void (async () => {
      await bridge.start();
      const key = await getApiKey();
      connect(key ?? '');
      listFactoryDefaults();
    })();
  }, [embedded]);

  useEffect(() => {
    if (embedded) return;
    listMissions({
      workspaceCwds: state.workspaceCwds,
      includePlainChats: true,
      limitPerWorkspace: WORKSPACE_BOOTSTRAP_SESSION_LIMIT,
    });
  }, [embedded, state.workspaceCwds]);

  useEffect(() => {
    if (embedded) return;
    const unsub = bridge.subscribe((event) => {
      if (event.type !== 'browser.native.request') return;
      const activeBrowserKey = browserKeyForMission(
        state.activeMissionId ? state.missions[state.activeMissionId] : undefined,
      );
      const requestIsForActiveChat = activeBrowserKey === event.request.missionId;
      const nextActiveMissionId = activeMissionAfterNativeBrowserRequest(
        state.activeMissionId,
        event.request,
        state.missions,
      );
      if (nextActiveMissionId !== state.activeMissionId) {
        dispatch({ type: 'SET_ACTIVE_MISSION', id: nextActiveMissionId });
      }
      if (!state.activeMissionId || requestIsForActiveChat) {
        dispatch({ type: 'SET_RIGHT_PANEL', open: false });
        dispatch({ type: 'SET_BROWSER_OPEN', open: true });
      }
      void performNativeBrowserRequest(event.request)
        .then(sendNativeBrowserResult)
        .catch((err) => {
          sendNativeBrowserResult({
            requestId: event.request.requestId,
            missionId: event.request.missionId,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    });
    return () => unsub();
  }, [dispatch, embedded, state.activeMissionId, state.missions]);

  useEffect(() => {
    if (embedded) return;
    if (!activeMission) return;
    if (state.historyLoaded[activeMission.id] || requestedHistory.current.has(activeMission.id))
      return;
    requestedHistory.current.add(activeMission.id);
    loadMissionHistory(activeMission.id);
  }, [activeMission, embedded, state.historyLoaded]);

  useEffect(() => {
    if (embedded || !activeMission) return;
    if (activeMission.kind === 'mission_orchestrator') return;
    const agentSessionId = state.selectedAgentSessionId;
    if (!agentSessionId || agentSessionId === 'orchestrator') return;
    subscribeWorker(activeMission.id, agentSessionId);
  }, [activeMission?.id, embedded, state.selectedAgentSessionId]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      if (e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleBrowserPane();
        return;
      }
      switch (e.key.toLowerCase()) {
        case 'k':
          e.preventDefault();
          dispatch({ type: 'TOGGLE_COMMAND_PALETTE' });
          break;
        case 'b':
          e.preventDefault();
          dispatch({ type: 'TOGGLE_SIDEBAR' });
          break;
        case '\\':
          e.preventDefault();
          toggleRightPanel();
          break;
        case ',':
          e.preventDefault();
          dispatch({ type: 'TOGGLE_SETTINGS' });
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dispatch, toggleBrowserPane, toggleRightPanel]);

  return (
    <div
      id="app-root"
      className="h-screen w-screen flex flex-col bg-droid-bg text-droid-text overflow-hidden relative"
    >
      <div className="flex-1 flex min-h-0 relative">
        {/* Sidebar with collapse animation */}
        <AnimatePresence initial={false}>
          {!state.sidebarCollapsed && (
            <motion.div
              key="sidebar"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 280, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              className="shrink-0 overflow-hidden h-full"
            >
              <Sidebar />
            </motion.div>
          )}
        </AnimatePresence>

        <main className="relative flex-1 min-w-0 flex flex-col min-h-0 overflow-hidden bg-droid-bg">
          {state.sidebarCollapsed && <div data-electron-drag-region className="h-9 shrink-0" />}
          <div className="flex-1 min-h-0 min-w-0 overflow-hidden flex relative">
            <section className="relative min-w-0 flex-1 flex flex-col overflow-hidden">
              {isMissionView ? (
                <motion.div
                  key="mission-control"
                  className="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden"
                  initial={{ clipPath: 'inset(0 100% 0 0)', opacity: 0.4 }}
                  animate={{ clipPath: 'inset(0 0% 0 0)', opacity: 1 }}
                  transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                >
                  <MissionControl />
                </motion.div>
              ) : (
                <>
                  <ChatView rightInset={rightPanelVisible} />
                  <PromptInput rightInset={rightPanelVisible} />
                </>
              )}
              {state.pendingQuestion && <AskUserModal />}
            </section>

            <AnimatePresence initial={false}>
              {showBrowserPane && (
                <BrowserPane
                  animated={!nativeBrowserPane}
                  width={browserPaneWidth}
                  onResize={setStoredBrowserPaneWidth}
                />
              )}
            </AnimatePresence>
          </div>
        </main>

        {/* Floating overlay — does not take flex space, so `main` keeps full
            width and its scrollbar stays at the window's right edge. */}
        <AnimatePresence initial={false}>
          {rightPanelVisible && (
            <motion.div
              key="right-panel"
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 12 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              className="absolute top-0 right-0 h-full w-[312px] z-30"
            >
              <RightPanel />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <StatusBar />

      {/* Floating window controls — rendered LAST so their `no-drag` regions are
          accumulated after the full-width header drag regions (sidebar/chat/
          mission headers). Earlier in the DOM, those overlapping drag regions
          would re-assert `drag` over these buttons and swallow their clicks
          (Electron #27149). They stay absolutely positioned, so paint order and
          layout are unchanged. */}
      <div
        data-electron-drag-region
        className="absolute top-0 left-[92px] h-9 z-40 flex items-center gap-1.5"
      >
        <button
          onClick={() => dispatch({ type: 'TOGGLE_SIDEBAR' })}
          className="p-1.5 rounded-md text-droid-text-muted/70 hover:text-droid-text hover:bg-droid-elevated/60 transition-colors"
          title="Toggle sidebar (Cmd+B)"
        >
          <PanelLeft className="w-4 h-4" />
        </button>
        <button
          onClick={toggleBrowserPane}
          className={`p-1.5 rounded-md transition-colors ${
            state.browserOpen
              ? 'text-droid-text bg-droid-elevated'
              : 'text-droid-text-muted/70 hover:text-droid-text hover:bg-droid-elevated/60'
          }`}
          title="Toggle browser (Cmd+Shift+B)"
        >
          <Monitor className="w-4 h-4" />
        </button>
      </div>

      <div
        data-electron-drag-region
        className="absolute top-0 right-0 h-9 z-40 flex items-center gap-1 pr-3"
      >
        {activeMission?.cwd && !state.browserOpen && (
          <EditorOpenMenu cwd={activeMission.cwd} hasRepo={!!repoStatus} variant="toolbar" />
        )}
        {canToggleContext && !state.browserOpen && (
          <button
            onClick={toggleRightPanel}
            className={`p-1.5 rounded-md transition-colors ${
              state.rightPanelOpen
                ? 'text-droid-text bg-droid-elevated'
                : 'text-droid-text-muted/70 hover:text-droid-text hover:bg-droid-elevated/60'
            }`}
            title="Toggle panel (Cmd+\\)"
          >
            <ContextListIcon className="w-4 h-4" />
          </button>
        )}
      </div>

      {state.commandPaletteOpen && <CommandPalette />}
      {state.settingsOpen && <SettingsPanel />}
      <SpecWikiModal />
      <Toaster />
    </div>
  );
}

function BrowserPane({
  animated,
  width,
  onResize,
}: {
  animated: boolean;
  width: number;
  onResize: (width: number) => void;
}) {
  const content = (
    <>
      <BrowserPaneResizeHandle width={width} onResize={onResize} />
      <BrowserWorkspace />
    </>
  );

  const className =
    'relative shrink-0 overflow-hidden border-l border-droid-border bg-droid-bg shadow-[-24px_0_60px_rgba(0,0,0,0.18)]';
  if (!animated) {
    return (
      <aside key="browser-pane" className={className} style={{ width }}>
        {content}
      </aside>
    );
  }

  return (
    <motion.aside
      key="browser-pane"
      initial={{ width: 0, opacity: 0 }}
      animate={{ width, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className={className}
    >
      {content}
    </motion.aside>
  );
}

function BrowserPaneResizeHandle({
  width,
  onResize,
}: {
  width: number;
  onResize: (width: number) => void;
}) {
  const dragStart = useRef<{ x: number; width: number } | null>(null);

  return (
    <div
      role="separator"
      aria-label="Resize browser pane"
      aria-orientation="vertical"
      className="group absolute left-0 top-0 z-20 h-full w-3 cursor-col-resize"
      onPointerDown={(event) => {
        dragStart.current = { x: event.clientX, width };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const start = dragStart.current;
        if (!start) return;
        onResize(clampBrowserPane(start.width + start.x - event.clientX));
      }}
      onPointerUp={(event) => {
        dragStart.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
    >
      <div className="absolute left-0 top-0 h-full w-px bg-droid-border-hover/60 transition-colors group-hover:bg-droid-accent/70" />
      <div className="absolute left-1 top-1/2 h-12 w-1 -translate-y-1/2 rounded-full bg-droid-border-hover/70 opacity-70 transition-colors group-hover:bg-droid-accent" />
    </div>
  );
}

function initialBrowserPaneWidth(): number {
  if (typeof window === 'undefined') return BROWSER_PANE_DEFAULT;
  try {
    const stored = Number(localStorage.getItem(BROWSER_PANE_WIDTH_STORAGE_KEY));
    if (Number.isFinite(stored) && stored > 0) return clampBrowserPane(stored);
  } catch {
    /* ignore */
  }
  return clampBrowserPane(Math.round(window.innerWidth * 0.44));
}

function clampBrowserPane(width: number): number {
  const viewportMax =
    typeof window === 'undefined'
      ? BROWSER_PANE_MAX
      : Math.max(BROWSER_PANE_MIN, Math.min(BROWSER_PANE_MAX, Math.round(window.innerWidth - 520)));
  return Math.min(viewportMax, Math.max(BROWSER_PANE_MIN, Math.round(width)));
}
