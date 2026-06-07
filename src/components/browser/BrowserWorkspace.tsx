import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isDesignModeOpen } from '../../hooks/designModeState';
import { useStore } from '../../hooks/useStore';
import {
  addDesignReference,
  closeBrowser,
  openBrowser,
  resizeBrowserViewport,
  sendDesignPrompt,
} from '../../lib/commands';
import type {
  BrowserBox,
  BrowserElementRef,
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
import { reloadNativeBrowser, closeNativeBrowser } from '../../lib/nativeBrowser';
import type { NativeBrowserSelection } from '../../lib/nativeBrowser';
import { BrowserToolbar } from './BrowserToolbar';
import { DesignModeComposer } from './DesignModeComposer';
import { composerStyleForReferences } from './browserComposerPosition';
import { useElementSize } from './useElementSize';

export default function BrowserWorkspace() {
  const { state, dispatch } = useStore();
  const sessionId = state.activeMissionId ?? undefined;
  const browser = sessionId ? state.browsers[sessionId] : undefined;
  const browserError = sessionId ? state.browserErrors[sessionId] : state.browserGlobalError;
  const designMode = isDesignModeOpen(state.designModes, sessionId);
  const frameRef = useRef<HTMLDivElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const openedFallbackSessionRef = useRef<string | null>(null);
  const frameSize = useElementSize(frameRef);
  const fitViewport = useMemo(() => viewportFromFrame(frameSize), [frameSize]);
  const [urlInput, setUrlInput] = useState(browser?.url ?? 'http://127.0.0.1:1420/');
  const [activeUrl, setActiveUrl] = useState(browser?.url ?? 'http://127.0.0.1:1420/');
  const [viewportMode, setViewportMode] = useState<BrowserViewportMode>(browser?.viewportMode ?? 'fit');
  const [customViewport, setCustomViewport] = useState<BrowserViewport>(CUSTOM_DEFAULT_VIEWPORT);
  const [actualViewport, setActualViewport] = useState<Size>({ width: 1, height: 1 });
  const [sketchMode, setSketchMode] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [references, setReferences] = useState<DesignReference[]>([]);

  useEffect(() => {
    if (browser?.url && document.activeElement !== urlInputRef.current) {
      setUrlInput(browser.url);
    }
    if (browser?.url && browser.url !== activeUrl) {
      setActiveUrl(browser.url);
    }
  }, [activeUrl, browser?.url]);

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
    setSketchMode(false);
  }, [browser?.sessionId, browser?.url, sessionId]);

  useEffect(() => {
    if (!designMode) setSketchMode(false);
  }, [designMode]);

  const requestedViewport = viewportForMode(viewportMode, fitViewport, customViewport);
  const selectedIds = references.map((ref) => ref.id).filter((id): id is string => Boolean(id));
  const canSend = Boolean(sessionId && selectedIds.length > 0 && instruction.trim());
  const disabledReason = !sessionId
    ? 'Select or create a Droid session'
    : selectedIds.length === 0
    ? 'Select a reference'
    : 'Enter a prompt';
  const composerStyle = useMemo(
    () => composerStyleForReferences(references, frameSize, requestedViewport, viewportMode),
    [frameSize, references, requestedViewport, viewportMode],
  );

  useEffect(() => {
    if (!sessionId || browser) return;
    const key = `${sessionId}:${activeUrl}`;
    if (openedFallbackSessionRef.current === key) return;
    openedFallbackSessionRef.current = key;
    openBrowser({
      missionId: sessionId,
      url: activeUrl,
      viewport: requestedViewport,
      viewportMode,
    });
  }, [activeUrl, browser, requestedViewport, sessionId, viewportMode]);

  useEffect(() => {
    if (!sessionId || !browser) return;
    if (browser.viewportMode === viewportMode && sameViewport(browser.viewport, requestedViewport)) return;
    const id = window.setTimeout(() => {
      resizeBrowserViewport({ missionId: sessionId, viewport: requestedViewport, viewportMode });
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
    sessionId,
    viewportMode,
  ]);

  const openCurrentUrl = () => {
    const url = normalizeUrl(urlInput);
    setUrlInput(url);
    setActiveUrl(url);
    if (sessionId) {
      openBrowser({
        missionId: sessionId,
        url,
        viewport: requestedViewport,
        viewportMode,
      });
    }
  };

  const applyPreset = (mode: BrowserViewportMode) => {
    setViewportMode(mode);
  };

  const sendPrompt = () => {
    if (!sessionId || !canSend) return;
    const text = instruction.trim();
    dispatch({
      type: 'MISSION_TRANSCRIPT',
      event: {
        id: `local-browser-${Date.now()}`,
        missionId: sessionId,
        agentSessionId: 'user',
        role: 'orchestrator',
        ts: Date.now(),
        kind: 'text',
        text,
        author: 'user',
      },
    });
    sendDesignPrompt(sessionId, instruction.trim(), selectedIds);
    setInstruction('');
  };

  const handleSelection = useCallback((selection: NativeBrowserSelection) => {
    const reference = referenceFromNativeSelection(selection);
    setReferences((prev) => {
      if (reference.id && prev.some((item) => item.id === reference.id)) return prev;
      return [...prev, reference];
    });
    if (sessionId) addDesignReference(sessionId, reference);
  }, [sessionId]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-droid-bg">
      <BrowserToolbar
        urlInputRef={urlInputRef}
        urlInput={urlInput}
        viewportMode={viewportMode}
        customViewport={customViewport}
        designMode={designMode}
        designModeDisabled={!sessionId}
        sketchMode={sketchMode}
        onUrlInputChange={setUrlInput}
        onOpen={openCurrentUrl}
        onReload={() => reloadNativeBrowser().catch(() => openCurrentUrl())}
        onViewportModeChange={applyPreset}
        onCustomViewportChange={setCustomViewport}
        onToggleDesignMode={() => {
          if (sessionId) dispatch({ type: 'TOGGLE_DESIGN_MODE', missionId: sessionId });
        }}
        onToggleSketchMode={() => setSketchMode((value) => !value)}
        onClose={() => {
          if (sessionId) closeBrowser(sessionId);
          closeNativeBrowser().catch(() => {});
          dispatch({ type: 'SET_BROWSER_OPEN', open: false });
        }}
      />

      {browserError && (
        <div className="shrink-0 border-b border-droid-border bg-droid-accent/10 px-4 py-2 text-[12px] text-droid-text-secondary">
          {browserError}
        </div>
      )}

      <div ref={frameRef} className="relative flex-1 min-h-0 min-w-0">
        <NativeBrowserSurface
          url={activeUrl}
          viewport={requestedViewport}
          viewportMode={viewportMode}
          designMode={designMode}
          sketchMode={designMode && sketchMode}
          onLoaded={(url) => {
            setActiveUrl(url);
            if (document.activeElement !== urlInputRef.current) setUrlInput(url);
          }}
          onSelection={handleSelection}
          onViewportSizeChange={setActualViewport}
        />

        {designMode && references.length > 0 && (
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
  if (selection.kind === 'region') {
    return { id: selection.id, kind: 'region', box: selection.box as BrowserBox, note: selection.url };
  }
  const element: BrowserElementRef = {
    ref: selection.id,
    selector: selection.selector ?? '',
    tagName: selection.tagName ?? 'element',
    role: selection.role,
    name: selection.name,
    text: selection.text,
    attributes: {},
    box: selection.box as BrowserBox,
    computedStyles: {},
  };
  return { id: selection.id, kind: 'element', element, note: selection.url };
}
