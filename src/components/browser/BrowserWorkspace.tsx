import { useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType, ReactNode, RefObject } from 'react';
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
  clickBrowser,
  openBrowser,
  refreshBrowser,
  resizeBrowserViewport,
  scrollBrowser,
  sendDesignPrompt,
} from '../../lib/commands';
import type {
  BrowserBox,
  BrowserElementRef,
  BrowserScrollDirection,
  BrowserViewport,
  BrowserViewportMode,
  DesignReference,
} from '../../types/bridge';
import type { Point, Size } from '../canvas/canvasMath';
import { BrowserCanvas } from './BrowserCanvas';
import {
  clamp,
  CUSTOM_DEFAULT_VIEWPORT,
  normalizeUrl,
  PRESET_VIEWPORTS,
  sameViewport,
  viewportForMode,
  viewportFromFrame,
} from './browserViewport';
import { DesignPromptBar } from './DesignPromptBar';

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
  const frameSize = useElementSize(frameRef);
  const fitViewport = useMemo(() => viewportFromFrame(frameSize), [frameSize]);
  const [urlInput, setUrlInput] = useState(browser?.url ?? 'http://127.0.0.1:1420/');
  const [viewportMode, setViewportMode] = useState<BrowserViewportMode>(browser?.viewportMode ?? 'fit');
  const [customViewport, setCustomViewport] = useState<BrowserViewport>(CUSTOM_DEFAULT_VIEWPORT);
  const [canvasScale, setCanvasScale] = useState(1);
  const [sketchMode, setSketchMode] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [references, setReferences] = useState<DesignReference[]>([]);

  useEffect(() => {
    if (browser?.url && document.activeElement !== urlInputRef.current) {
      setUrlInput(browser.url);
    }
  }, [browser?.url]);

  useEffect(() => {
    if (browser?.viewportMode) setViewportMode(browser.viewportMode);
  }, [browser?.viewportMode]);

  useEffect(() => {
    setReferences([]);
  }, [browser?.sessionId, sessionId]);

  useEffect(() => {
    if (!browser || viewportMode !== 'fit') return;
    if (sameViewport(browser.viewport, fitViewport)) return;
    const handle = window.setTimeout(() => {
      if (sessionId) resizeBrowserViewport({ missionId: sessionId, viewport: fitViewport, viewportMode: 'fit' });
    }, 180);
    return () => window.clearTimeout(handle);
  }, [browser, fitViewport, sessionId, viewportMode]);

  useEffect(() => {
    if (!browser || viewportMode !== 'custom') return;
    if (sameViewport(browser.viewport, customViewport)) return;
    const handle = window.setTimeout(() => {
      if (sessionId) resizeBrowserViewport({ missionId: sessionId, viewport: customViewport, viewportMode: 'custom' });
    }, 220);
    return () => window.clearTimeout(handle);
  }, [browser, customViewport, sessionId, viewportMode]);

  const requestedViewport = viewportForMode(viewportMode, fitViewport, customViewport);
  const visibleViewport = browser?.viewport ?? requestedViewport;
  const selectedIds = references.map((ref) => ref.id).filter((id): id is string => Boolean(id));
  const canSend = Boolean(sessionId && selectedIds.length > 0 && instruction.trim());

  const openCurrentUrl = () => {
    const url = normalizeUrl(urlInput);
    setUrlInput(url);
    if (!sessionId) return;
    openBrowser({ missionId: sessionId, url, viewport: requestedViewport, viewportMode });
  };

  const applyPreset = (mode: BrowserViewportMode) => {
    setViewportMode(mode);
    const viewport = viewportForMode(mode, fitViewport, customViewport);
    if (browser && sessionId) resizeBrowserViewport({ missionId: sessionId, viewport, viewportMode: mode });
  };

  const toggleElement = (element: BrowserElementRef) => {
    const id = element.ref;
    if (references.some((ref) => ref.id === id)) {
      setReferences((prev) => prev.filter((ref) => ref.id !== id));
      return;
    }
    const reference: DesignReference = { id, kind: 'element', element };
    setReferences((prev) => [...prev, reference]);
    if (sessionId) addDesignReference(sessionId, reference);
  };

  const addRegion = (box: BrowserBox) => {
    const reference: DesignReference = {
      id: `region-${Date.now().toString(36)}`,
      kind: 'region',
      box,
    };
    setReferences((prev) => [...prev, reference]);
    if (sessionId) addDesignReference(sessionId, reference);
  };

  const sendPrompt = () => {
    if (!sessionId || !canSend) return;
    sendDesignPrompt(sessionId, instruction.trim(), selectedIds);
    setInstruction('');
  };

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
          <IconButton title="Refresh" onClick={() => sessionId && refreshBrowser(sessionId)} disabled={!browser || !sessionId}>
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
          <IconButton title="Close Browser" onClick={() => dispatch({ type: 'SET_BROWSER_OPEN', open: false })}>
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
        <BrowserCanvas
          browser={browser}
          viewport={visibleViewport}
          designMode={state.designMode}
          sketchMode={state.designMode && sketchMode}
          selectedIds={selectedIds}
          onScaleChange={setCanvasScale}
          onClickPoint={(point: Point) => sessionId && clickBrowser({ missionId: sessionId, x: point.x, y: point.y })}
          onToggleElement={toggleElement}
          onAddRegion={addRegion}
          onScroll={(direction: BrowserScrollDirection, pixels: number) => sessionId && scrollBrowser({ missionId: sessionId, direction, pixels })}
        />

        <div className="pointer-events-none absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-md border border-droid-border bg-droid-bg/90 px-2.5 py-1.5 text-[11px] text-droid-text-muted shadow-lg">
          <span className="font-mono text-droid-text-secondary">{visibleViewport.width}x{visibleViewport.height}</span>
          <span>{Math.round(canvasScale * 100)}%</span>
          <span>{viewportMode}</span>
        </div>
      </div>

      {state.designMode && (
        <DesignPromptBar
          references={references}
          instruction={instruction}
          canSend={canSend}
          disabledReason={!sessionId ? 'No active Droid session' : selectedIds.length === 0 ? 'Select a reference' : 'Describe the change'}
          onInstructionChange={setInstruction}
          onRemoveReference={(id) => setReferences((prev) => prev.filter((ref) => ref.id !== id))}
          onSend={sendPrompt}
        />
      )}
    </div>
  );
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
