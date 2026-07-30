import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import type { BrowserViewportMode } from '../../types/bridge';
import { normalizeUrl } from '../browser/browserViewport';
import { isSelfBrowserUrl } from '../browser/browserUrlSafety';
import { pushEscapeLayer } from '../environment/usePopover';
import { useStudioCanvas } from './StudioCanvasContext';

const VIEWPORTS: { mode: BrowserViewportMode; label: string }[] = [
  { mode: 'desktop', label: 'Desktop' },
  { mode: 'laptop', label: 'Laptop' },
  { mode: 'tablet', label: 'Tablet' },
  { mode: 'mobile', label: 'Mobile' },
  { mode: 'custom', label: 'Custom' },
];

const QUICK_PORTS = ['localhost:5173', 'localhost:3000', 'localhost:8080'];

/** Minimal, focused dialog for pointing a new frame at a running route. */
export default function AddFrameDialog({ onClose }: { onClose: () => void }) {
  const { studio, studioDispatch } = useStudioCanvas();
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [mode, setMode] = useState<BrowserViewportMode>(studio.defaultMode);
  const [w, setW] = useState(1024);
  const [h, setH] = useState(720);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return pushEscapeLayer(onClose);
  }, [onClose]);

  const submit = () => {
    const normalized = normalizeUrl(url || QUICK_PORTS[0]);
    const appOrigin = typeof window === 'undefined' ? undefined : window.location.origin;
    if (isSelfBrowserUrl(normalized, appOrigin)) {
      setError(
        "That's DROIDEX's own address — embedding it would nest the app in itself and spike your CPU. Use your project's dev-server port.",
      );
      return;
    }
    const custom = mode === 'custom';
    studioDispatch({
      type: 'ADD_FRAME',
      frame: {
        name: name.trim() || deriveName(normalized),
        url: normalized,
        mode,
        kind: 'route',
        width: custom ? clampSize(w) : undefined,
        height: custom ? clampSize(h) : undefined,
      },
    });
    onClose();
  };

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <motion.div
        data-studio-dismissable-layer
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-live-page-title"
        initial={{ opacity: 0, scale: 0.97, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
        onClick={(e) => {
          e.stopPropagation();
        }}
        className="studio-popover w-[440px] overflow-hidden"
      >
        <div className="px-5 pb-1 pt-5">
          <h2
            id="add-live-page-title"
            className="text-[15px] font-medium tracking-tight text-droid-text"
          >
            Add a live page
          </h2>
          <p className="mt-1 text-[12px] text-droid-text-muted">
            Point it at a route on your running dev server. It renders live and hot-reloads.
          </p>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div>
            <Label>URL</Label>
            <input
              autoFocus
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                if (error) setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
              placeholder="localhost:5173/dashboard"
              className={`w-full rounded-lg border bg-droid-surface px-3 py-2 text-[12.5px] text-droid-text placeholder:text-droid-text-muted focus:outline-none ${
                error ? 'border-droid-red/60' : 'border-droid-border focus:border-droid-accent/50'
              }`}
            />
            {error && <div className="mt-1.5 text-[11px] leading-snug text-droid-red">{error}</div>}
            <div className="mt-2 flex gap-1.5">
              {QUICK_PORTS.map((p) => (
                <button
                  key={p}
                  onClick={() => {
                    setUrl(p);
                  }}
                  className="rounded-md border border-droid-border px-2 py-1 text-[10.5px] text-droid-text-muted transition-colors hover:border-droid-border-hover hover:bg-droid-elevated hover:text-droid-text"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          <div>
            <Label>Name (optional)</Label>
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
              placeholder="Dashboard"
              className="w-full rounded-lg border border-droid-border bg-droid-bg/60 px-3 py-2 text-[12.5px] text-droid-text placeholder:text-droid-text-muted focus:border-droid-accent/50 focus:outline-none"
            />
          </div>

          <div>
            <Label>Viewport</Label>
            <div className="flex gap-1">
              {VIEWPORTS.map((v) => (
                <button
                  key={v.mode}
                  onClick={() => {
                    setMode(v.mode);
                  }}
                  aria-pressed={mode === v.mode}
                  className={`flex-1 rounded-lg border px-2 py-2 text-[11px] transition-colors ${
                    mode === v.mode
                      ? 'border-droid-accent/40 bg-droid-accent/10 text-droid-text'
                      : 'border-droid-border text-droid-text-muted hover:border-droid-border-hover hover:text-droid-text'
                  }`}
                >
                  {v.label}
                </button>
              ))}
            </div>
            {mode === 'custom' && (
              <div className="mt-2 flex items-center gap-2">
                <SizeInput label="W" value={w} onChange={setW} />
                <span className="text-droid-text-muted">×</span>
                <SizeInput label="H" value={h} onChange={setH} />
                <span className="text-[10.5px] text-droid-text-muted">px</span>
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-droid-border px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-[12.5px] text-droid-text-secondary transition-colors hover:text-droid-text"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            className="rounded-lg bg-droid-accent px-3.5 py-1.5 text-[12.5px] font-medium text-droid-bg transition-opacity hover:opacity-90 active:translate-y-px"
          >
            Add page
          </button>
        </div>
      </motion.div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="pb-1.5 text-[11.5px] font-medium text-droid-text-secondary">{children}</div>
  );
}

function SizeInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="flex flex-1 items-center gap-1.5 rounded-lg border border-droid-border bg-droid-bg/60 px-2.5 py-1.5 focus-within:border-droid-accent/50">
      <span className="text-[10.5px] text-droid-text-muted">{label}</span>
      <input
        type="number"
        value={value}
        onChange={(e) => {
          onChange(Number(e.target.value));
        }}
        className="w-full bg-transparent text-[12.5px] text-droid-text focus:outline-none"
      />
    </div>
  );
}

function clampSize(n: number): number {
  if (!Number.isFinite(n)) return 400;
  return Math.min(4096, Math.max(200, Math.round(n)));
}

function deriveName(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).pop();
    if (seg) return seg.charAt(0).toUpperCase() + seg.slice(1);
    return u.host.replace(/^www\./, '');
  } catch {
    return 'Frame';
  }
}
