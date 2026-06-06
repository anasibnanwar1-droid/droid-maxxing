import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from './hooks/useStore';
import { AnimatePresence, motion } from 'framer-motion';
import { Monitor, PanelLeft } from 'lucide-react';
import { bridge } from './lib/bridge';
import { closeBrowser, connect, listFactoryDefaults, listModels, listMissions, listSkills, loadMissionHistory, resumeMission, sendNativeBrowserResult } from './lib/commands';
import { isEmbedded } from './lib/embed';
import { getApiKey } from './lib/tauri';
import { performNativeBrowserRequest } from './lib/nativeBrowserAgent';
import Sidebar from './components/Sidebar';
import ChatView from './components/ChatView';
import MissionControl from './components/MissionControl';
import PromptInput from './components/PromptInput';
import RightPanel from './components/RightPanel';
import StatusBar from './components/StatusBar';
import CommandPalette from './components/CommandPalette';
import SettingsPanel, { applyTheme } from './components/SettingsPanel';
import AskUserModal from './components/AskUserModal';
import PermissionModal from './components/PermissionModal';
import BrowserWorkspace from './components/browser/BrowserWorkspace';

const BROWSER_PANE_MIN = 460;
const BROWSER_PANE_MAX = 1280;
const BROWSER_PANE_DEFAULT = 860;

export default function App() {
  const { state, dispatch } = useStore();
  const embedded = isEmbedded();
  const activeMission = state.activeMissionId ? state.missions[state.activeMissionId] : null;
  // The view is a real mission only when the active session is a mission orchestrator,
  // not merely because the global mission-compose flag is on.
  const isMissionView = !!activeMission && activeMission.kind === 'mission_orchestrator';
  const showBrowserPane = !embedded && state.browserOpen && !!activeMission;
  const focused = isMissionView;
  const requestedHistory = useRef(new Set<string>());
  const requestedResume = useRef(new Set<string>());
  const [browserPaneWidth, setBrowserPaneWidth] = useState(() => initialBrowserPaneWidth());

  const toggleBrowserPane = useCallback(() => {
    if (state.browserOpen && activeMission) closeBrowser(activeMission.id);
    dispatch({ type: 'TOGGLE_BROWSER' });
  }, [activeMission, dispatch, state.browserOpen]);

  useEffect(() => {
    applyTheme(state.theme);
  }, [state.theme]);

  useEffect(() => {
    if (embedded) return;
    void (async () => {
      await bridge.start();
      const key = await getApiKey();
      connect(key ?? '');
      listModels();
      listFactoryDefaults();
      listMissions();
      listSkills();
    })();
  }, [embedded]);

  useEffect(() => {
    if (embedded) return;
    const unsub = bridge.subscribe((event) => {
      if (event.type !== 'browser.native.request') return;
      dispatch({ type: 'SET_ACTIVE_MISSION', id: event.request.missionId });
      dispatch({ type: 'SET_BROWSER_OPEN', open: true });
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
  }, [dispatch, embedded]);

  useEffect(() => {
    if (embedded) return;
    if (!activeMission) return;
    if (!requestedResume.current.has(activeMission.id)) {
      requestedResume.current.add(activeMission.id);
      resumeMission(activeMission.id);
    }
    if (state.historyLoaded[activeMission.id] || requestedHistory.current.has(activeMission.id)) return;
    requestedHistory.current.add(activeMission.id);
    loadMissionHistory(activeMission.id);
  }, [activeMission, embedded, state.historyLoaded]);

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
          dispatch({ type: 'SET_RIGHT_PANEL', open: !state.rightPanelOpen });
          break;
        case ',':
          e.preventDefault();
          dispatch({ type: 'TOGGLE_SETTINGS' });
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dispatch, state.rightPanelOpen, toggleBrowserPane]);

  return (
    <div className="h-screen w-screen flex flex-col bg-droid-bg text-droid-text overflow-hidden relative">
      {/* Sidebar toggle — always at fixed position, clearing traffic lights */}
      <button
        onClick={() => dispatch({ type: 'TOGGLE_SIDEBAR' })}
        className="absolute top-[6px] left-[80px] z-40 p-1 rounded text-droid-text-muted/50 hover:text-droid-text-muted hover:bg-droid-elevated/50 transition-colors pointer-events-auto"
        title="Toggle sidebar (Cmd+B)"
      >
        <PanelLeft className="w-3.5 h-3.5" />
      </button>

      <button
        onClick={toggleBrowserPane}
        className={`absolute top-[6px] left-[108px] z-40 p-1 rounded transition-colors pointer-events-auto ${
          state.browserOpen
            ? 'text-droid-text bg-droid-elevated/80'
            : 'text-droid-text-muted/50 hover:text-droid-text-muted hover:bg-droid-elevated/50'
        }`}
        title="Toggle browser (Cmd+Shift+B)"
      >
        <Monitor className="w-3.5 h-3.5" />
      </button>

      <div className="flex-1 flex min-h-0">
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

        <main className="relative flex-1 min-w-0 flex flex-col min-h-0 overflow-hidden">
          {state.sidebarCollapsed && <div data-tauri-drag-region className="h-9 shrink-0" />}
          <div className="flex-1 min-h-0 min-w-0 overflow-hidden flex relative">
            <section className="min-w-0 flex-1 flex flex-col overflow-hidden">
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
                <ChatView />
              )}
            </section>

            <AnimatePresence initial={false}>
              {showBrowserPane && (
                <motion.aside
                  key="browser-pane"
                  initial={{ width: 0, opacity: 0 }}
                  animate={{ width: browserPaneWidth, opacity: 1 }}
                  exit={{ width: 0, opacity: 0 }}
                  transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                  className="relative shrink-0 overflow-hidden border-l border-droid-border bg-droid-bg shadow-[-24px_0_60px_rgba(0,0,0,0.18)]"
                >
                  <BrowserPaneResizeHandle width={browserPaneWidth} onResize={setBrowserPaneWidth} />
                  <BrowserWorkspace />
                </motion.aside>
              )}
            </AnimatePresence>
          </div>
          {!isMissionView && <PromptInput />}
          {state.pendingQuestion && <AskUserModal />}
        </main>

        {!focused && !showBrowserPane && state.rightPanelOpen && <RightPanel />}
      </div>

      <StatusBar />

      {state.commandPaletteOpen && <CommandPalette />}
      {state.settingsOpen && <SettingsPanel />}
      {state.pendingPermission && <PermissionModal />}
    </div>
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
  return clampBrowserPane(Math.round(window.innerWidth * 0.44));
}

function clampBrowserPane(width: number): number {
  const viewportMax = typeof window === 'undefined'
    ? BROWSER_PANE_MAX
    : Math.max(BROWSER_PANE_MIN, Math.min(BROWSER_PANE_MAX, Math.round(window.innerWidth - 520)));
  return Math.min(viewportMax, Math.max(BROWSER_PANE_MIN, Math.round(width)));
}
