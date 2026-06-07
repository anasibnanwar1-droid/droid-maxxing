import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isDesignModeOpen } from '../../hooks/designModeState';
import { useStore } from '../../hooks/useStore';
import {
  addDesignReference,
  closeBrowser,
  openBrowser,
  reloadBrowser,
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
import { closeNativeBrowser } from '../../lib/nativeBrowser';
import { isDesktop } from '../../lib/desktop';
import type { NativeBrowserDesignPrompt, NativeBrowserSelection } from '../../lib/nativeBrowser';
import { BrowserToolbar } from './BrowserToolbar';
import { DesignModeComposer } from './DesignModeComposer';
import { composerStyleForReferences } from './browserComposerPosition';
import { safeBrowserUrl } from './browserUrlSafety';
import { useElementSize } from './useElementSize';

export default function BrowserWorkspace() {
  const { state, dispatch } = useStore();
  const requestedChatId = state.activeMissionId ?? undefined;
  const activeMission = requestedChatId ? state.missions[requestedChatId] : undefined;
  const chatId = activeMission ? requestedChatId : undefined;
  const droidSessionId = activeMission ? activeMission.sessionId ?? chatId : undefined;
  const browser = chatId ? state.browsers[chatId] : undefined;
  const browserError = chatId ? state.browserErrors[chatId] : state.browserGlobalError;
  const designMode = isDesignModeOpen(state.designModes, droidSessionId);
  const nativeBrowser = isDesktop();
  const frameRef = useRef<HTMLDivElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const openedFallbackSessionRef = useRef<string | null>(null);
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
  const [sketchMode, setSketchMode] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [references, setReferences] = useState<DesignReference[]>([]);

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
    setSketchMode(false);
  }, [browser?.sessionId, browser?.url, chatId]);

  useEffect(() => {
    if (!designMode) setSketchMode(false);
  }, [designMode]);

  const requestedViewport = viewportForMode(viewportMode, fitViewport, customViewport);
  const selectedIds = references.map((ref) => ref.id).filter((id): id is string => Boolean(id));
  const canSend = Boolean(chatId && selectedIds.length > 0 && instruction.trim());
  const disabledReason = !chatId
    ? 'Select or create a Droid session'
    : selectedIds.length === 0
    ? 'Select a reference'
    : 'Enter a prompt';
  const composerStyle = useMemo(
    () => composerStyleForReferences(references, frameSize, requestedViewport, viewportMode),
    [frameSize, references, requestedViewport, viewportMode],
  );

  useEffect(() => {
    if (!chatId || browser) return;
    const key = `${chatId}:${activeUrl}`;
    if (openedFallbackSessionRef.current === key) return;
    openedFallbackSessionRef.current = key;
    openBrowser({
      missionId: chatId,
      url: activeUrl,
      viewport: requestedViewport,
      viewportMode,
    });
  }, [activeUrl, browser, chatId, requestedViewport, viewportMode]);

  useEffect(() => {
    if (!chatId || !browser) return;
    if (browser.viewportMode === viewportMode && sameViewport(browser.viewport, requestedViewport)) return;
    const id = window.setTimeout(() => {
      resizeBrowserViewport({ missionId: chatId, viewport: requestedViewport, viewportMode });
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
    chatId,
    viewportMode,
  ]);

  const openCurrentUrl = () => {
    const url = safeBrowserUrl(normalizeUrl(urlInput), appOrigin);
    setUrlInput(url);
    setActiveUrl(url);
    if (chatId) {
      openBrowser({
        missionId: chatId,
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
    if (!chatId || !canSend) return;
    sendDesignPrompt(chatId, instruction.trim(), selectedIds);
    setInstruction('');
  };

  const handleSelection = useCallback((selection: NativeBrowserSelection) => {
    const reference = referenceFromNativeSelection(selection);
    setReferences((prev) => {
      if (reference.id && prev.some((item) => item.id === reference.id)) return prev;
      return [...prev, reference];
    });
    if (chatId) addDesignReference(chatId, reference);
  }, [chatId]);

  const handleNativePrompt = useCallback((prompt: NativeBrowserDesignPrompt) => {
    if (!chatId) return;
    const text = prompt.instruction.trim();
    if (!text) return;
    const reference = referenceFromNativeSelection(prompt.selection);
    const referenceId = reference.id;
    if (!referenceId) return;
    setReferences((prev) => {
      if (prev.some((item) => item.id === referenceId)) return prev;
      return [...prev, reference];
    });
    addDesignReference(chatId, reference);
    window.setTimeout(() => sendDesignPrompt(chatId, text, [referenceId]), 0);
  }, [chatId]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-droid-bg">
      <BrowserToolbar
        urlInputRef={urlInputRef}
        urlInput={urlInput}
        viewportMode={viewportMode}
        customViewport={customViewport}
        designMode={designMode}
        designModeDisabled={!droidSessionId}
        sketchMode={sketchMode}
        onUrlInputChange={setUrlInput}
        onOpen={openCurrentUrl}
        onReload={() => {
          if (chatId && browser) reloadBrowser(chatId);
          else openCurrentUrl();
        }}
        onViewportModeChange={applyPreset}
        onCustomViewportChange={setCustomViewport}
        onToggleDesignMode={() => {
          if (droidSessionId) dispatch({ type: 'TOGGLE_DESIGN_MODE', sessionId: droidSessionId });
        }}
        onToggleSketchMode={() => setSketchMode((value) => !value)}
        onClose={() => {
          if (chatId) closeBrowser(chatId);
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
        {chatId && frameReady ? (
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
            onPrompt={handleNativePrompt}
            onViewportSizeChange={setActualViewport}
          />
        ) : (
          <div className="flex h-full items-center justify-center bg-[#070707] px-6 text-sm text-droid-text-muted">
            {chatId ? 'Preparing browser pane...' : 'Select or create a Droid session.'}
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
