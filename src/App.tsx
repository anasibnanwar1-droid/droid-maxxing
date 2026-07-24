import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from './hooks/useStore';
import { AnimatePresence, motion } from 'framer-motion';
import { PanelLeft, PanelRight } from 'lucide-react';
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
import Sidebar from './components/Sidebar';
import ChatView from './components/ChatView';
import MissionControl from './components/MissionControl';
import PromptInput from './components/PromptInput';
import RightPanel from './components/RightPanel';
import { ReviewPanel } from './components/environment/ReviewPanel';
import EditorOpenMenu from './components/EditorOpenMenu';
import Toaster from './components/Toaster';
import { useRepoStatus } from './hooks/useRepoStatus';
import StatusBar from './components/StatusBar';
import CommandPalette from './components/CommandPalette';
import SettingsPanel, { applyTheme, paletteForMode } from './components/SettingsPanel';
import AskUserModal from './components/AskUserModal';
import SpecWikiModal from './components/SpecWikiModal';
import { BrowserFocusWorkspace } from './components/browser/BrowserFocusWorkspace';
import { useOnboarding, shouldShowOnboarding, hasSetupBlocker } from './hooks/useOnboarding';
import OnboardingWizard from './components/onboarding/OnboardingWizard';
import SetupBanner from './components/onboarding/SetupBanner';
import { updateCli } from './lib/commands';
import { refreshAppUpdate, startAppUpdate } from './lib/appUpdate';
import { toast } from './lib/toast';
import { UtilityPane } from './components/utility/UtilityPane';
import { TerminalWorkspace } from './components/terminal/TerminalWorkspace';
import { FilesWorkspace } from './components/files/FilesWorkspace';
import { closeTerminalForTab } from './lib/terminal';
import { utilityPanelForMission, type UtilityTool } from './lib/utilityPanel';

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

const UTILITY_PANE_MIN = 460;
const UTILITY_PANE_MAX = 1280;
const UTILITY_PANE_DEFAULT = 760;
const UTILITY_PANE_WIDTH_STORAGE_KEY = 'droid-utility-pane-width';

export default function App() {
  const { state, dispatch } = useStore();
  const embedded = isEmbedded();
  const onboard = useOnboarding();
  const [forceWizard, setForceWizard] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [expandedBrowserMissionId, setExpandedBrowserMissionId] = useState<string | null>(null);
  const launchHandled = useRef(false);
  const showWizard =
    !embedded && onboard.ready && (forceWizard || shouldShowOnboarding(onboard.onboarding));
  const activeMission = state.activeMissionId ? state.missions[state.activeMissionId] : null;
  const repoStatus = useRepoStatus(activeMission?.cwd ?? '');
  // The view is a real mission only when the active session is a mission orchestrator,
  // not merely because the global mission-compose flag is on.
  const isMissionView = !!activeMission && activeMission.kind === 'mission_orchestrator';
  const utilityPanel = utilityPanelForMission(state.utilityPanels, activeMission?.id);
  const activeUtilityTab =
    utilityPanel.tabs.find((tab) => tab.id === utilityPanel.activeTabId) ?? null;
  const showUtilityPane = !embedded && !!activeMission && utilityPanel.open && !showWizard;
  const browserExpanded = Boolean(
    showUtilityPane &&
    activeUtilityTab?.tool === 'browser' &&
    expandedBrowserMissionId === activeMission?.id,
  );
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
    !focused && !showUtilityPane && state.rightPanelOpen && hasSessionContent;
  const requestedHistory = useRef(new Set<string>());
  const [utilityPaneWidth, setUtilityPaneWidth] = useState(() => initialUtilityPaneWidth());
  const [utilityPaneMax, setUtilityPaneMax] = useState(() => utilityPaneMaxWidth());
  const contentRowRef = useRef<HTMLDivElement>(null);
  const [contentRowWidth, setContentRowWidth] = useState(0);

  const toggleRightPanel = useCallback(() => {
    const open = !state.rightPanelOpen;
    dispatch({ type: 'SET_RIGHT_PANEL', open });
  }, [dispatch, state.rightPanelOpen]);

  const toggleUtilityPane = useCallback(() => {
    dispatch({ type: 'SET_UTILITY_PANEL_OPEN', open: !utilityPanel.open });
  }, [dispatch, utilityPanel.open]);

  const openUtilityTool = useCallback(
    (tool: UtilityTool) => {
      dispatch({
        type: 'OPEN_UTILITY_TOOL',
        tool,
        tabId: tool === 'terminal' ? crypto.randomUUID() : undefined,
      });
    },
    [dispatch],
  );

  useEffect(() => {
    const onResize = () => {
      setUtilityPaneMax(utilityPaneMaxWidth());
      setUtilityPaneWidth((width) => clampUtilityPane(width));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    const node = contentRowRef.current;
    if (!node) return;
    const update = () => {
      setContentRowWidth(Math.round(node.getBoundingClientRect().width));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

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
    // Load every known session for the chosen workspaces; the sidebar shows the
    // latest few and reveals the rest behind "Show more" rather than capping.
    listMissions({ workspaceCwds: state.workspaceCwds, includePlainChats: true });
  }, [embedded, state.workspaceCwds]);

  // Post-onboarding launch tasks: silent CLI update + non-blocking app update
  // check. Runs once, only after the first-run tour is complete.
  useEffect(() => {
    if (embedded || launchHandled.current) return;
    if (!onboard.ready || !onboard.onboarding?.completed) return;
    // Defer until env detection lands so the CLI auto-update isn't skipped by a
    // race where this runs before `env` arrives.
    const wantsCliAutoUpdate = onboard.onboarding.cliAutoUpdate !== false;
    if (wantsCliAutoUpdate && !onboard.env) return;
    launchHandled.current = true;
    if (wantsCliAutoUpdate && onboard.env?.cli.present) {
      updateCli(onboard.onboarding.installChannel);
    }
    if (onboard.onboarding.appAutoUpdate !== false) {
      void refreshAppUpdate().then((info) => {
        // Auto-update is on by default: download and (on the feed path) restart
        // into the new build, not just record it for the sidebar pill.
        // updateAvailable only reflects the managed manifest, so when an
        // autoUpdater feed is configured we still kick it off (it resolves as
        // up-to-date when there's nothing new) even if the manifest is stale,
        // down, or absent.
        if (info?.updateAvailable || info?.feedConfigured) void startAppUpdate(info);
      });
    }
  }, [embedded, onboard.ready, onboard.onboarding, onboard.env]);

  // Surface the result of a background CLI update.
  useEffect(() => {
    if (onboard.lastResult?.phase !== 'update') return;
    if (onboard.lastResult.ok) toast.success('Droid CLI is up to date.');
  }, [onboard.lastResult]);

  // The native browser is a separate Electron layer that floats above the DOM,
  // so close it while the full-screen wizard is up or it paints over the tour.
  useEffect(() => {
    if (showWizard && utilityPanel.open) dispatch({ type: 'SET_UTILITY_PANEL_OPEN', open: false });
  }, [showWizard, utilityPanel.open, dispatch]);

  // "Run setup again" from Settings re-opens the tour.
  useEffect(() => {
    const onOpen = () => {
      setBannerDismissed(false);
      setForceWizard(true);
    };
    window.addEventListener('droid:open-onboarding', onOpen);
    return () => window.removeEventListener('droid:open-onboarding', onOpen);
  }, []);

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
        dispatch({ type: 'OPEN_UTILITY_TOOL', tool: 'browser' });
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
    dispatch({ type: 'SESSION_RESTORE_START', missionId: activeMission.id });
    loadMissionHistory(activeMission.id);
  }, [activeMission, embedded, state.historyLoaded, dispatch]);

  useEffect(() => {
    if (embedded || !activeMission) return;
    if (activeMission.kind === 'mission_orchestrator') return;
    const agentSessionId = state.selectedAgentSessionId;
    if (!agentSessionId || agentSessionId === 'orchestrator') return;
    // A worker's inner events only stream once we subscribe, so mark its
    // transcript as loading until the backend replays history and acks with
    // 'opened'. This keeps the card honest instead of flashing "no activity".
    dispatch({ type: 'AGENT_HISTORY_LOADING', agentSessionId, loading: true });
    subscribeWorker(activeMission.id, agentSessionId);
  }, [activeMission?.id, embedded, state.selectedAgentSessionId, dispatch]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault();
        openUtilityTool('terminal');
        return;
      }
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      if (e.shiftKey) {
        const key = e.key.toLowerCase();
        if (key === 'b' || key === 'f' || key === 'r') {
          e.preventDefault();
          openUtilityTool(key === 'b' ? 'browser' : key === 'f' ? 'files' : 'review');
          return;
        }
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
          toggleUtilityPane();
          break;
        case ',':
          e.preventDefault();
          dispatch({ type: 'TOGGLE_SETTINGS' });
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dispatch, openUtilityTool, toggleUtilityPane]);

  const setupBlocker =
    !showWizard &&
    !embedded &&
    onboard.ready &&
    onboard.onboarding?.completed === true &&
    hasSetupBlocker(onboard.env);
  const showBanner = !bannerDismissed && setupBlocker;

  return (
    <div
      id="app-root"
      className="h-screen w-screen flex flex-col bg-droid-bg text-droid-text overflow-hidden relative"
    >
      {showBanner && (
        <SetupBanner
          kind="blocker"
          message="Finish setting up Droid to start running agents."
          actionLabel="Finish setup"
          onAction={() => setForceWizard(true)}
          onDismiss={() => setBannerDismissed(true)}
        />
      )}
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
          <div ref={contentRowRef} className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
            <section
              aria-hidden={browserExpanded}
              className={`relative flex min-w-0 flex-1 flex-col overflow-hidden ${
                browserExpanded ? 'pointer-events-none' : ''
              }`}
            >
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
            </section>

            <AnimatePresence initial={false}>
              {showUtilityPane && (
                <motion.div
                  key="utility-pane"
                  initial={{ width: 0, opacity: 0 }}
                  animate={{
                    width:
                      browserExpanded && contentRowWidth > 0 ? contentRowWidth : utilityPaneWidth,
                    opacity: 1,
                  }}
                  exit={{ width: 0, opacity: 0 }}
                  transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
                  className="h-full min-w-0 shrink-0 overflow-hidden"
                >
                  <UtilityPane
                    panel={utilityPanel}
                    expanded={browserExpanded}
                    width={utilityPaneWidth}
                    minWidth={UTILITY_PANE_MIN}
                    maxWidth={utilityPaneMax}
                    onResize={setUtilityPaneWidth}
                    onResizeEnd={(width) => {
                      const next = clampUtilityPane(width);
                      setUtilityPaneWidth(next);
                      try {
                        localStorage.setItem(UTILITY_PANE_WIDTH_STORAGE_KEY, String(next));
                      } catch {
                        /* ignore */
                      }
                    }}
                    onOpenTool={openUtilityTool}
                    onActivateTab={(tabId) => {
                      const nextTab = utilityPanel.tabs.find((tab) => tab.id === tabId);
                      if (nextTab?.tool !== 'browser') setExpandedBrowserMissionId(null);
                      dispatch({ type: 'ACTIVATE_UTILITY_TAB', tabId });
                    }}
                    onCloseTab={(tab) => {
                      if (
                        tab.tool === 'terminal' &&
                        !window.confirm('Close this terminal and stop its running process?')
                      ) {
                        return;
                      }
                      if (tab.tool === 'terminal') {
                        void closeTerminalForTab(tab.id, tab.terminalId).finally(() => {
                          dispatch({
                            type: 'CLOSE_UTILITY_TAB',
                            tabId: tab.id,
                            missionId: activeMission.id,
                          });
                        });
                        return;
                      }
                      if (tab.tool === 'browser') setExpandedBrowserMissionId(null);
                      dispatch({ type: 'CLOSE_UTILITY_TAB', tabId: tab.id });
                    }}
                    onClosePane={() => {
                      setExpandedBrowserMissionId(null);
                      dispatch({ type: 'SET_UTILITY_PANEL_OPEN', open: false });
                    }}
                    renderTab={(tab, { overlayOpen }) => {
                      if (tab.tool === 'review') {
                        return <ReviewPanel cwd={activeMission.cwd} />;
                      }
                      if (tab.tool === 'browser') {
                        return (
                          <BrowserFocusWorkspace
                            expanded={browserExpanded}
                            externalObscured={overlayOpen}
                            onToggleExpanded={() => {
                              setExpandedBrowserMissionId(
                                browserExpanded ? null : activeMission.id,
                              );
                            }}
                          />
                        );
                      }
                      if (tab.tool === 'terminal') {
                        return (
                          <TerminalWorkspace
                            tabId={tab.id}
                            terminalId={tab.terminalId}
                            missionId={activeMission.id}
                            cwd={activeMission.cwd}
                            onCreated={(terminalId, label) => {
                              dispatch({
                                type: 'UPDATE_UTILITY_TAB',
                                tabId: tab.id,
                                missionId: activeMission.id,
                                terminalId,
                                label,
                              });
                            }}
                          />
                        );
                      }
                      return (
                        <FilesWorkspace
                          root={activeMission.cwd}
                          selectedPath={tab.filePath}
                          onSelectPath={(filePath) => {
                            dispatch({
                              type: 'UPDATE_UTILITY_TAB',
                              tabId: tab.id,
                              missionId: activeMission.id,
                              filePath,
                            });
                          }}
                        />
                      );
                    }}
                  />
                </motion.div>
              )}
            </AnimatePresence>
            {state.pendingQuestion && <AskUserModal />}
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
      </div>

      {!showUtilityPane && (
        <div
          data-electron-drag-region
          className="absolute top-0 right-0 h-9 z-40 flex items-center gap-1 pr-3"
        >
          {activeMission?.cwd && (
            <EditorOpenMenu cwd={activeMission.cwd} hasRepo={!!repoStatus} variant="toolbar" />
          )}
          {canToggleContext && (
            <button
              onClick={toggleRightPanel}
              className={`p-1.5 rounded-md transition-colors ${
                state.rightPanelOpen
                  ? 'text-droid-text bg-droid-elevated'
                  : 'text-droid-text-muted/70 hover:text-droid-text hover:bg-droid-elevated/60'
              }`}
              title="Toggle context"
            >
              <ContextListIcon className="w-4 h-4" />
            </button>
          )}
          {!!activeMission && (
            <button
              onClick={toggleUtilityPane}
              className="rounded-md p-1.5 text-droid-text-muted/70 transition-colors hover:bg-droid-elevated/60 hover:text-droid-text"
              title="Toggle utility pane (Cmd+\\)"
            >
              <PanelRight className="h-4 w-4" />
            </button>
          )}
        </div>
      )}

      {state.commandPaletteOpen && <CommandPalette />}
      {state.settingsOpen && <SettingsPanel />}
      <SpecWikiModal />
      <Toaster />

      <AnimatePresence>
        {showWizard && (
          <OnboardingWizard
            controller={onboard}
            onComplete={() => {
              setForceWizard(false);
              setBannerDismissed(false);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function initialUtilityPaneWidth(): number {
  if (typeof window === 'undefined') return UTILITY_PANE_DEFAULT;
  try {
    const stored = Number(
      localStorage.getItem(UTILITY_PANE_WIDTH_STORAGE_KEY) ??
        localStorage.getItem('droid-browser-pane-width'),
    );
    if (Number.isFinite(stored) && stored > 0) return clampUtilityPane(stored);
  } catch {
    /* ignore */
  }
  return clampUtilityPane(Math.round(window.innerWidth * 0.56));
}

function utilityPaneMaxWidth(): number {
  if (typeof window === 'undefined') return UTILITY_PANE_MAX;
  return Math.max(
    UTILITY_PANE_MIN,
    Math.min(UTILITY_PANE_MAX, Math.round(window.innerWidth - 420)),
  );
}

function clampUtilityPane(width: number): number {
  return Math.min(utilityPaneMaxWidth(), Math.max(UTILITY_PANE_MIN, Math.round(width)));
}
