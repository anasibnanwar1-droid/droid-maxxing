import { useEffect, useRef } from 'react';
import { useStore } from './hooks/useStore';
import { AnimatePresence, motion } from 'framer-motion';
import { Monitor, PanelLeft } from 'lucide-react';
import { bridge } from './lib/bridge';
import { connect, listFactoryDefaults, listModels, listMissions, listSkills, loadMissionHistory, resumeMission } from './lib/commands';
import { getApiKey } from './lib/tauri';
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

export default function App() {
  const { state, dispatch } = useStore();
  const activeMission = state.activeMissionId ? state.missions[state.activeMissionId] : null;
  // The view is a real mission only when the active session is a mission orchestrator,
  // not merely because the global mission-compose flag is on.
  const isMissionView = !!activeMission && activeMission.kind === 'mission_orchestrator';
  const isBrowserView = state.browserOpen;
  const focused = isMissionView || isBrowserView;
  const requestedHistory = useRef(new Set<string>());
  const requestedResume = useRef(new Set<string>());

  useEffect(() => {
    applyTheme(state.theme);
  }, [state.theme]);

  useEffect(() => {
    void (async () => {
      await bridge.start();
      const key = await getApiKey();
      connect(key ?? '');
      listModels();
      listFactoryDefaults();
      listMissions();
      listSkills();
    })();
  }, []);

  useEffect(() => {
    if (!activeMission) return;
    if (!requestedResume.current.has(activeMission.id)) {
      requestedResume.current.add(activeMission.id);
      resumeMission(activeMission.id);
    }
    if (state.historyLoaded[activeMission.id] || requestedHistory.current.has(activeMission.id)) return;
    requestedHistory.current.add(activeMission.id);
    loadMissionHistory(activeMission.id);
  }, [activeMission, state.historyLoaded]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      if (e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        dispatch({ type: 'TOGGLE_BROWSER' });
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
  }, [dispatch, state.rightPanelOpen]);

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
        onClick={() => dispatch({ type: 'TOGGLE_BROWSER' })}
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
          <div className="flex-1 min-h-0 min-w-0 overflow-hidden flex flex-col relative">
            {isBrowserView ? (
              <BrowserWorkspace />
            ) : isMissionView ? (
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
          </div>
          {!isMissionView && !isBrowserView && <PromptInput />}
          {state.pendingQuestion && <AskUserModal />}
        </main>

        {!focused && state.rightPanelOpen && <RightPanel />}
      </div>

      <StatusBar />

      {state.commandPaletteOpen && <CommandPalette />}
      {state.settingsOpen && <SettingsPanel />}
      {state.pendingPermission && <PermissionModal />}
    </div>
  );
}
