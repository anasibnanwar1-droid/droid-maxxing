import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from './hooks/useStore';
import { AnimatePresence, motion } from 'framer-motion';
import { Monitor, PanelLeft } from 'lucide-react';
import { bridge } from './lib/bridge';
import { closeBrowser, connect, listFactoryDefaults, listModels, listMissions, listSkills, loadMissionHistory, resumeMission, sendNativeBrowserResult } from './lib/commands';
import { isEmbedded } from './lib/embed';
import { getApiKey } from './lib/desktop';
import { performNativeBrowserRequest } from './lib/nativeBrowserAgent';
import Sidebar from './components/Sidebar';
import ChatView from './components/ChatView';
import MissionControl from './components/MissionControl';
import PromptInput from './components/PromptInput';
import RightPanel from './components/RightPanel';
import StatusBar from './components/StatusBar';
import CommandPalette from './components/CommandPalette';
import SettingsPanel, { applyTheme, paletteForMode } from './components/SettingsPanel';
import AskUserModal from './components/AskUserModal';
import PermissionModal from './components/PermissionModal';
import BrowserWorkspace from './components/browser/BrowserWorkspace';

function ContextListIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className={className}>
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
      listModels();
      listFactoryDefaults();
      listSkills();
    })();
  }, [embedded]);

  useEffect(() => {
    if (embedded || state.workspaceCwds.length === 0) return;
    listMissions({ workspaceCwds: state.workspaceCwds, limitPerWorkspace: 5 });
  }, [embedded, state.workspaceCwds]);

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
    <div id="app-root" className="h-screen w-screen flex flex-col bg-droid-bg text-droid-text overflow-hidden relative">
      {/* Left controls — inside a drag region so their no-drag holes are honored.
          Offset clear of the native traffic-light hit area (~x88) and centered on
          the same h-9 line as the lights for symmetry with the right control. */}
      <div data-electron-drag-region className="absolute top-0 left-[92px] h-9 z-40 flex items-center gap-1.5">
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

      {/* Right control — context panel toggle, same drag-region treatment and
          same h-9 line/sizing as the left controls. */}
      <div data-electron-drag-region className="absolute top-0 right-0 h-9 z-40 flex items-center pr-3">
        <button
          onClick={() => dispatch({ type: 'SET_RIGHT_PANEL', open: !state.rightPanelOpen })}
          className={`p-1.5 rounded-md transition-colors ${
            state.rightPanelOpen
              ? 'text-droid-text bg-droid-elevated'
              : 'text-droid-text-muted/70 hover:text-droid-text hover:bg-droid-elevated/60'
          }`}
          title="Toggle panel (Cmd+\\)"
        >
          <ContextListIcon className="w-4 h-4" />
        </button>
      </div>

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

        <main className="relative flex-1 min-w-0 flex flex-col min-h-0 overflow-hidden bg-droid-bg">
          {state.sidebarCollapsed && <div data-electron-drag-region className="h-9 shrink-0" />}
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

        <AnimatePresence initial={false}>
          {!focused && !showBrowserPane && state.rightPanelOpen && (
            <motion.div
              key="right-panel"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 312, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              className="shrink-0 overflow-hidden h-full"
            >
              <RightPanel />
            </motion.div>
          )}
        </AnimatePresence>
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
