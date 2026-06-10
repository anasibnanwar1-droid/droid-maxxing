import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isDesignModeOpen } from '../../hooks/designModeState';
import { useStore } from '../../hooks/useStore';
import {
  addDesignReference,
  openBrowser,
  reloadBrowser,
  resizeBrowserViewport,
  sendDesignPrompt,
} from '../../lib/commands';
import type {
  BrowserViewport,
  BrowserViewportMode,
  DesignReference,
} from '../../types/bridge';
import type { Size } from '../canvas/canvasMath';
import {
  CUSTOM_DEFAULT_VIEWPORT,
  normalizeUrl,
  sameViewport,
  viewportForMode,
  viewportFromFrame,
} from './browserViewport';
import { NativeBrowserSurface } from './NativeBrowserSurface';
import { isDesktop } from '../../lib/desktop';
import type { NativeBrowserDesignPrompt, NativeBrowserLoadFailed, NativeBrowserSelection } from '../../lib/nativeBrowser';
import { BrowserToolbar } from './BrowserToolbar';
import { DesignModeComposer } from './DesignModeComposer';
import { composerStyleForReferences } from './browserComposerPosition';
import { browserKeyForMission } from '../../lib/browserSessionIdentity';
import { browserTranscriptReferencesFromDesignReferences } from './browserTranscriptReferences';
import { isSelfBrowserUrl, safeBrowserUrl } from './browserUrlSafety';
import { useElementSize } from './useElementSize';

export default function BrowserWorkspace() {
  const { state, dispatch } = useStore();
  const requestedChatId = state.activeMissionId ?? undefined;
  const activeMission = requestedChatId ? state.missions[requestedChatId] : undefined;
  const browserKey = browserKeyForMission(activeMission);
  const browser = browserKey ? state.browsers[browserKey] : undefined;
  const browserError = browserKey ? state.browserErrors[browserKey] : state.browserGlobalError;
  const designMode = isDesignModeOpen(state.designModes, browserKey);
  const nativeBrowser = isDesktop();
  // The native BrowserView is an OS-level layer painted above the React tree,
  // so any full-screen overlay would otherwise be punched through by it. Detach
  // it while such an overlay is visible and re-attach once it closes.
  const obscured =
    state.settingsOpen ||
    state.commandPaletteOpen ||
    !!state.pendingQuestion ||
    state.pendingPermission?.kind === 'spec';
  const frameRef = useRef<HTMLDivElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const appOrigin = typeof window === 'undefined' ? undefined : window.location.origin;
  const frameSize = useElementSize(frameRef);
  const frameReady = frameSize.width > 8 && frameSize.height > 8;
  const fitViewport = useMemo(() => viewportFromFrame(frameSize), [frameSize]);
  const initialUrl = safeBrowserUrl(browser?.url, appOrigin);
  const [urlInput, setUrlInput] = useState(initialUrl);
  const [activeUrl, setActiveUrl] = useState(initialUrl);
  const [viewportMode, setViewportMode] = useState<BrowserViewportMode>(browser?.viewportMode ?? 'fit');
  const [customViewport, setCustomViewport] = useState<BrowserViewport>(CUSTOM_DEFAULT_VIEWPORT);
  const [actualViewport, setActualViewport] = useState<Size>({ width: 1, height: 1 });
  const [pencilMode, setPencilMode] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [references, setReferences] = useState<DesignReference[]>([]);
  const [loadFailure, setLoadFailure] = useState<NativeBrowserLoadFailed | null>(null);

  // Auto-reload: when the agent edits files and the browser shows a local
  // dev server URL, reload the pane after a short debounce so the new code
  // is visible immediately.  The timeout id lives in a ref so that
  // subsequent transcript updates (non-edit events) don't clear a pending
  // reload that was already scheduled.
  const lastEditTsRef = useRef(0);
  const reloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transcripts = requestedChatId ? state.transcripts[requestedChatId] : undefined;
  useEffect(() => {
    if (!browserKey || !transcripts) return;
    const last = transcripts[transcripts.length - 1];
    if (!last || last.kind !== 'tool_result') return;
    const name = last.toolName ?? '';
    const isEdit = name === 'edit' || name === 'multiedit' || name === 'multi_edit'
      || name === 'str_replace' || name === 'apply_patch' || name === 'create'
      || name === 'write' || name.includes('edit') || name.includes('patch');
    if (!isEdit || last.isError) return;
    const url = activeUrl;
    if (!/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/.test(url)) return;
    if (last.ts <= lastEditTsRef.current) return;
    lastEditTsRef.current = last.ts;
    if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
    reloadTimerRef.current = setTimeout(() => {
      reloadTimerRef.current = null;
      reloadBrowser(browserKey);
    }, 600);
  }, [activeUrl, browserKey, transcripts]);

  // Cancel any pending auto-reload when the browser session switches or the
  // component unmounts, so a stale timer doesn't reload the wrong session.
  useEffect(() => {
    return () => {
      if (reloadTimerRef.current) {
        clearTimeout(reloadTimerRef.current);
        reloadTimerRef.current = null;
      }
    };
  }, [browserKey]);

  useEffect(() => {
    if (!browser?.url) return;
    const nextUrl = safeBrowserUrl(browser.url, appOrigin);
    if (document.activeElement !== urlInputRef.current) {
      setUrlInput(nextUrl);
    }
    if (nextUrl !== activeUrl) {
      setActiveUrl(nextUrl);
    }
  }, [activeUrl, appOrigin, browser?.url]);

  useEffect(() => {
    if (browser?.viewportMode) setViewportMode(browser.viewportMode);
  }, [browser?.viewportMode]);

  useEffect(() => {
    if (browser?.viewport && browser.viewportMode === 'custom') {
      setCustomViewport(browser.viewport);
    }
  }, [browser?.viewport, browser?.viewportMode]);

  useEffect(() => {
    setReferences([]);
    setInstruction('');
    setPencilMode(false);
    setLoadFailure(null);
  }, [browser?.sessionId, browser?.url, browserKey]);

  useEffect(() => {
    if (!designMode) setPencilMode(false);
  }, [designMode]);

  const requestedViewport = viewportForMode(viewportMode, fitViewport, customViewport);
  const selectedIds = references.map((ref) => ref.id).filter((id): id is string => Boolean(id));
  const canSend = Boolean(browserKey && selectedIds.length > 0 && instruction.trim());
  const disabledReason = !browserKey
    ? 'Select or create a Droid session'
    : selectedIds.length === 0
    ? 'Select a reference'
    : 'Enter a prompt';
  const composerStyle = useMemo(
    () => composerStyleForReferences(references, frameSize, requestedViewport, viewportMode),
    [frameSize, references, requestedViewport, viewportMode],
  );

  useEffect(() => {
    if (!browserKey || !browser) return;
    if (browser.viewportMode === viewportMode && sameViewport(browser.viewport, requestedViewport)) return;
    const id = window.setTimeout(() => {
      resizeBrowserViewport({ missionId: browserKey, viewport: requestedViewport, viewportMode });
    }, 120);
    return () => window.clearTimeout(id);
  }, [
    browser?.viewport.deviceScaleFactor,
    browser?.viewport.height,
    browser?.viewport.width,
    browser?.viewportMode,
    requestedViewport.deviceScaleFactor,
    requestedViewport.height,
    requestedViewport.width,
    browserKey,
    viewportMode,
  ]);

  const openCurrentUrl = () => {
    const normalizedUrl = normalizeUrl(urlInput);
    if (browserKey && isSelfBrowserUrl(normalizedUrl, appOrigin)) {
      setUrlInput(normalizedUrl);
      dispatch({
        type: 'BROWSER_ERROR',
        missionId: browserKey,
        message: 'Cannot open the Droid Control shell inside its own browser pane. Use a different local app port.',
      });
      return;
    }
    const url = safeBrowserUrl(normalizedUrl, appOrigin);
    setLoadFailure(null);
    setUrlInput(url);
    setActiveUrl(url);
    if (browserKey) {
      openBrowser({
        missionId: browserKey,
        url,
        viewport: requestedViewport,
        viewportMode,
      });
    }
  };

  const emitDesignTranscript = useCallback((text: string, refs: DesignReference[]) => {
    if (!requestedChatId) return;
    const browserRefs = browserTranscriptReferencesFromDesignReferences(refs);
    dispatch({
      type: 'MISSION_TRANSCRIPT',
      event: {
        id: `local-design-${Date.now()}`,
        missionId: requestedChatId,
        agentSessionId: 'user',
        role: 'orchestrator',
        ts: Date.now(),
        kind: 'text',
        text,
        author: 'user',
        browserRefs: browserRefs.length ? browserRefs : undefined,
      },
    });
  }, [dispatch, requestedChatId]);

  const sendPrompt = () => {
    if (!browserKey || !canSend) return;
    const text = instruction.trim();
    sendDesignPrompt(browserKey, text, selectedIds);
    emitDesignTranscript(text, references);
    setReferences([]);
    setInstruction('');
    // Re-arm like Cursor: disarm after sending so the user clicks Design Mode
    // again to start a new selection instead of staying live.
    dispatch({ type: 'SET_DESIGN_MODE', sessionId: browserKey, open: false });
  };

  const handleSelection = useCallback((selection: NativeBrowserSelection) => {
    const reference = referenceFromNativeSelection(selection);
    setReferences([reference]);
    if (browserKey) addDesignReference(browserKey, reference, selection.screenshot);
  }, [browserKey]);

  const handleLoadFailed = useCallback((failure: NativeBrowserLoadFailed) => {
    setLoadFailure(failure);
  }, []);

  const handleNativePrompt = useCallback((prompt: NativeBrowserDesignPrompt) => {
    if (!browserKey) return;
    const text = prompt.instruction.trim();
    if (!text) return;
    const reference = referenceFromNativeSelection(prompt.selection);
    const referenceId = reference.id;
    if (!referenceId) return;
    setReferences([reference]);
    addDesignReference(browserKey, reference, prompt.selection.screenshot);
    window.setTimeout(() => sendDesignPrompt(browserKey, text, [referenceId]), 0);
    emitDesignTranscript(text, [reference]);
    setReferences([]);
    dispatch({ type: 'SET_DESIGN_MODE', sessionId: browserKey, open: false });
  }, [browserKey, dispatch, emitDesignTranscript]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-droid-bg">
      <BrowserToolbar
        urlInputRef={urlInputRef}
        urlInput={urlInput}
        designMode={designMode}
        designModeDisabled={!browserKey}
        pencilMode={pencilMode}
        onUrlInputChange={setUrlInput}
        onOpen={openCurrentUrl}
        onReload={() => {
          if (browserKey && browser) reloadBrowser(browserKey);
          else openCurrentUrl();
        }}
        onToggleDesignMode={() => {
          if (browserKey) dispatch({ type: 'TOGGLE_DESIGN_MODE', sessionId: browserKey });
        }}
        onTogglePencilMode={() => setPencilMode((value) => !value)}
        onClose={() => {
          // Hide the pane but keep this chat's browser session alive so it can
          // be reopened (and resumes after an app restart).
          dispatch({ type: 'SET_BROWSER_OPEN', open: false });
        }}
      />

      {browserError && (
        <div className="shrink-0 border-b border-droid-border bg-droid-accent/10 px-4 py-2 text-[12px] text-droid-text-secondary">
          {browserError}
        </div>
      )}

      {loadFailure && (
        <div className="flex shrink-0 items-center gap-2 border-b border-droid-border bg-red-500/10 px-4 py-2 text-[12px] text-droid-text-secondary">
          <span className="min-w-0 flex-1 truncate">
            Could not load {loadFailure.url}{loadFailure.error ? ` (${loadFailure.error})` : ''}. Check that the server is running.
          </span>
          <button
            type="button"
            className="shrink-0 rounded border border-droid-border px-2 py-0.5 text-[11px] text-droid-text-muted hover:text-droid-text"
            onClick={() => {
              setLoadFailure(null);
              if (browserKey && browser) reloadBrowser(browserKey);
              else openCurrentUrl();
            }}
          >
            Retry
          </button>
          <button
            type="button"
            className="shrink-0 rounded px-1 text-[11px] text-droid-text-muted hover:text-droid-text"
            onClick={() => setLoadFailure(null)}
            aria-label="Dismiss"
          >
            x
          </button>
        </div>
      )}

      <div ref={frameRef} className="relative flex-1 min-h-0 min-w-0">
        {browserKey && frameReady ? (
          <NativeBrowserSurface
            browserKey={browserKey}
            visibleSessionId={browser?.sessionId}
            obscured={obscured}
            url={activeUrl}
            viewport={requestedViewport}
            viewportMode={viewportMode}
            designMode={designMode}
            pencilMode={designMode && pencilMode}
            onLoaded={(url) => {
              setLoadFailure(null);
              setActiveUrl(url);
              if (document.activeElement !== urlInputRef.current) setUrlInput(url);
            }}
            onSelection={handleSelection}
            onPrompt={handleNativePrompt}
            onLoadFailed={handleLoadFailed}
            onViewportSizeChange={setActualViewport}
          />
        ) : (
          <div className="flex h-full items-center justify-center bg-[#070707] px-6 text-sm text-droid-text-muted">
            {browserKey ? 'Preparing browser pane...' : 'Select or create a Droid session.'}
          </div>
        )}

        {browserKey && !browser && frameReady && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[#070707] px-6 text-sm text-droid-text-muted">
            Open a URL to start this chat's browser.
          </div>
        )}

        {!nativeBrowser && designMode && references.length > 0 && (
          <DesignModeComposer
            references={references}
            instruction={instruction}
            canSend={canSend}
            disabledReason={disabledReason}
            style={composerStyle}
            onInstructionChange={setInstruction}
            onRemoveReference={(id) => setReferences((prev) => prev.filter((item) => item.id !== id))}
            onSend={sendPrompt}
          />
        )}

        <div className="pointer-events-none absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-md border border-droid-border bg-droid-bg/90 px-2.5 py-1.5 text-[11px] text-droid-text-muted shadow-lg">
          <span className="font-mono text-droid-text-secondary">
            {actualViewport.width}x{actualViewport.height}
          </span>
          <span>{viewportMode}</span>
        </div>
      </div>
    </div>
  );
}

function referenceFromNativeSelection(selection: NativeBrowserSelection): DesignReference {
  return {
    id: selection.anchor.id,
    anchor: {
      ...selection.anchor,
      strokes: selection.anchor.strokes ?? selection.strokes,
    },
    detail: selection.detail,
    url: selection.url,
    title: selection.title,
    scroll: selection.scroll,
    screenshot: selection.screenshot,
  };
}
