import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType, CSSProperties, ReactNode, RefObject } from 'react';
import {
  Expand,
  Laptop,
  MousePointer2,
  Monitor,
  PenLine,
  RefreshCw,
  Send,
  Smartphone,
  Tablet,
  X,
} from 'lucide-react';
import { useStore } from '../../hooks/useStore';
import {
  addDesignReference,
  closeBrowser,
  openBrowser,
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
  clamp,
  CUSTOM_DEFAULT_VIEWPORT,
  normalizeUrl,
  PRESET_VIEWPORTS,
  viewportForMode,
  viewportFromFrame,
} from './browserViewport';
import { NativeBrowserSurface } from './NativeBrowserSurface';
import { DesignModeComposer } from './DesignModeComposer';
import { reloadNativeBrowser, closeNativeBrowser } from '../../lib/nativeBrowser';
import type { NativeBrowserSelection } from '../../lib/nativeBrowser';

type Preset = {
  id: BrowserViewportMode;
  label: string;
  icon: ComponentType<{ className?: string }>;
  viewport?: BrowserViewport;
};

const PRESETS: Preset[] = [
  { id: 'fit', label: 'Fit', icon: Expand },
  { id: 'desktop', label: 'Desktop', icon: Monitor, viewport: PRESET_VIEWPORTS.desktop },
  { id: 'laptop', label: 'Laptop', icon: Laptop, viewport: PRESET_VIEWPORTS.laptop },
  { id: 'tablet', label: 'Tablet', icon: Tablet, viewport: PRESET_VIEWPORTS.tablet },
  { id: 'mobile', label: 'Mobile', icon: Smartphone, viewport: PRESET_VIEWPORTS.mobile },
];

export default function BrowserWorkspace() {
  const { state, dispatch } = useStore();
  const sessionId = state.activeMissionId ?? undefined;
  const browser = sessionId ? state.browsers[sessionId] : undefined;
  const browserError = sessionId ? state.browserErrors[sessionId] : state.browserGlobalError;
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
  }, [browser?.sessionId, browser?.url, sessionId]);

  const requestedViewport = viewportForMode(viewportMode, fitViewport, customViewport);
  const selectedIds = references.map((ref) => ref.id).filter((id): id is string => Boolean(id));
  const canSend = Boolean(sessionId && selectedIds.length > 0 && instruction.trim());
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
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-droid-border bg-droid-bg/95 px-3 py-2">
        <form
          className="flex min-w-[280px] flex-1 items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            openCurrentUrl();
          }}
        >
          <input
            ref={urlInputRef}
            value={urlInput}
            onChange={(event) => setUrlInput(event.target.value)}
            className="h-8 min-w-0 flex-1 rounded-md border border-droid-border bg-droid-surface px-3 text-[13px] text-droid-text placeholder:text-droid-text-muted focus:border-droid-border-hover focus:outline-none"
            placeholder="https://example.com"
          />
          <IconButton title="Open" onClick={openCurrentUrl} disabled={!sessionId}>
            <Send className="h-4 w-4" />
          </IconButton>
          <IconButton title="Reload" onClick={() => reloadNativeBrowser().catch(() => openCurrentUrl())} disabled={!sessionId}>
            <RefreshCw className="h-4 w-4" />
          </IconButton>
        </form>

        <div className="flex max-w-full items-center gap-1 overflow-x-auto rounded-md border border-droid-border bg-droid-surface p-1">
          {PRESETS.map((preset) => {
            const Icon = preset.icon;
            return (
              <button
                key={preset.id}
                onClick={() => applyPreset(preset.id)}
                className={`flex h-7 items-center gap-1.5 rounded px-2 text-[12px] transition-colors ${
                  viewportMode === preset.id
                    ? 'bg-droid-elevated text-droid-text'
                    : 'text-droid-text-muted hover:text-droid-text'
                }`}
                title={`${preset.label} viewport`}
              >
                <Icon className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{preset.label}</span>
              </button>
            );
          })}
          <button
            onClick={() => applyPreset('custom')}
            className={`flex h-7 items-center gap-1.5 rounded px-2 text-[12px] transition-colors ${
              viewportMode === 'custom'
                ? 'bg-droid-elevated text-droid-text'
                : 'text-droid-text-muted hover:text-droid-text'
            }`}
            title="Custom viewport"
          >
            <span className="font-mono text-[11px]">W</span>
            <span className="hidden sm:inline">Custom</span>
          </button>
        </div>

        {viewportMode === 'custom' && (
          <div className="flex items-center gap-1 rounded-md border border-droid-border bg-droid-surface px-1.5 py-1">
            <ViewportInput
              label="Width"
              value={customViewport.width}
              onChange={(width) => setCustomViewport((prev) => ({ ...prev, width }))}
            />
            <span className="text-[11px] text-droid-text-muted">x</span>
            <ViewportInput
              label="Height"
              value={customViewport.height}
              onChange={(height) => setCustomViewport((prev) => ({ ...prev, height }))}
            />
          </div>
        )}

        <div className="flex items-center gap-1">
          <IconButton
            title="Design Mode"
            active={state.designMode}
            onClick={() => dispatch({ type: 'TOGGLE_DESIGN_MODE' })}
          >
            <MousePointer2 className="h-4 w-4" />
          </IconButton>
          <IconButton
            title="Sketch Region"
            active={state.designMode && sketchMode}
            disabled={!state.designMode}
            onClick={() => setSketchMode((value) => !value)}
          >
            <PenLine className="h-4 w-4" />
          </IconButton>
          <IconButton
            title="Close Browser"
            onClick={() => {
              if (sessionId) closeBrowser(sessionId);
              closeNativeBrowser().catch(() => {});
              dispatch({ type: 'SET_BROWSER_OPEN', open: false });
            }}
          >
            <X className="h-4 w-4" />
          </IconButton>
        </div>
      </header>

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
          designMode={state.designMode}
          sketchMode={state.designMode && sketchMode}
          onLoaded={(url) => {
            setActiveUrl(url);
            if (document.activeElement !== urlInputRef.current) setUrlInput(url);
          }}
          onSelection={handleSelection}
          onViewportSizeChange={setActualViewport}
        />

        {state.designMode && references.length > 0 && (
          <DesignModeComposer
            references={references}
            instruction={instruction}
            canSend={canSend}
            disabledReason={!sessionId ? 'No active Droid session' : selectedIds.length === 0 ? 'Select a reference' : undefined}
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

function IconButton({
  title,
  active,
  disabled,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-droid-border transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
        active
          ? 'bg-droid-accent text-black'
          : 'bg-droid-surface text-droid-text-muted hover:text-droid-text hover:bg-droid-elevated'
      }`}
    >
      {children}
    </button>
  );
}

function ViewportInput({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <input
      aria-label={label}
      type="number"
      min={240}
      max={2400}
      value={value}
      onChange={(event) => onChange(clamp(parseInt(event.target.value, 10) || value, 240, 2400))}
      className="h-6 w-16 rounded border border-droid-border bg-droid-bg px-1.5 text-right font-mono text-[11px] text-droid-text focus:border-droid-border-hover focus:outline-none"
    />
  );
}

function useElementSize(ref: RefObject<HTMLElement | null>): Size {
  const [size, setSize] = useState<Size>({ width: 1, height: 1 });

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => {
      const rect = node.getBoundingClientRect();
      setSize({ width: Math.round(rect.width), height: Math.round(rect.height) });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);

  return size;
}

function composerStyleForReferences(
  references: DesignReference[],
  frame: Size,
  viewport: BrowserViewport,
  mode: BrowserViewportMode,
): CSSProperties {
  const surface = nativeSurfaceLayout(frame, viewport, mode);
  const box = unionBoxes(references.map(boxForReference).filter((item): item is BrowserBox => Boolean(item))) ?? {
    x: 0,
    y: 0,
    width: surface.width,
    height: 1,
  };
  const composerWidth = Math.min(420, Math.max(280, frame.width - 24));
  const composerHeight = 112;
  const left = surface.left + box.x;
  const belowTop = surface.top + box.y + box.height + 10;
  const aboveTop = surface.top + box.y - composerHeight - 10;
  const top = belowTop + composerHeight <= frame.height - 12 ? belowTop : aboveTop;
  return {
    left: clamp(left, 12, Math.max(12, frame.width - composerWidth - 12)),
    top: clamp(top, 12, Math.max(12, frame.height - composerHeight - 12)),
  };
}

function nativeSurfaceLayout(frame: Size, viewport: BrowserViewport, mode: BrowserViewportMode): Size & { left: number; top: number } {
  const padding = 18;
  const availableWidth = Math.max(1, frame.width - padding * 2);
  const availableHeight = Math.max(1, frame.height - padding * 2);
  const width = mode === 'fit' ? availableWidth : Math.min(viewport.width, availableWidth);
  const height = mode === 'fit' ? availableHeight : Math.min(viewport.height, availableHeight);
  return {
    width: Math.round(width),
    height: Math.round(height),
    left: Math.round((frame.width - width) / 2),
    top: Math.round((frame.height - height) / 2),
  };
}

function boxForReference(reference: DesignReference): BrowserBox | undefined {
  if (reference.kind === 'element') return reference.element?.box;
  if (reference.kind === 'region') return reference.box;
  if (reference.points?.length) {
    const xs = reference.points.map((point) => point.x);
    const ys = reference.points.map((point) => point.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  }
  return undefined;
}

function unionBoxes(boxes: BrowserBox[]): BrowserBox | undefined {
  if (boxes.length === 0) return undefined;
  const x1 = Math.min(...boxes.map((box) => box.x));
  const y1 = Math.min(...boxes.map((box) => box.y));
  const x2 = Math.max(...boxes.map((box) => box.x + box.width));
  const y2 = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}
