import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Loader2, TriangleAlert } from 'lucide-react';
import { useStudioCanvas, sizeOf, type StudioFrame } from './StudioCanvasContext';

/**
 * The world-space body of a frame: a live <iframe> pointed at the user's dev
 * server, rendered at its natural viewport size. The parent world layer applies
 * the pan/zoom transform, so this stays pixel-crisp and hot-reloads on its own.
 */
export default function StudioFrameBody({ frame }: { frame: StudioFrame }) {
  const { studio, studioDispatch } = useStudioCanvas();
  const interacting = studio.interactingFrameId === frame.id;
  const size = sizeOf(frame);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const hasUrl = !!frame.url && frame.url !== 'about:blank';

  // Guard against a frame that never fires load (offline dev server): fail after
  // a grace period so the frame shows an honest error instead of a forever spin.
  // The timer is cleared the moment the iframe loads so a live frame never flips
  // to failed.
  useEffect(() => {
    if (!hasUrl) return;
    studioDispatch({ type: 'UPDATE_FRAME', id: frame.id, patch: { status: 'loading' } });
    timerRef.current = setTimeout(() => {
      studioDispatch({
        type: 'UPDATE_FRAME',
        id: frame.id,
        patch: { status: 'failed', error: 'No response from the dev server.' },
      });
    }, 12000);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [frame.id, frame.url, hasUrl, reloadKey, studioDispatch]);

  const handleLoaded = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    studioDispatch({ type: 'UPDATE_FRAME', id: frame.id, patch: { status: 'ready', error: undefined } });
  };

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.965 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className="absolute overflow-hidden rounded-[10px] bg-white shadow-[0_24px_80px_-24px_rgba(0,0,0,0.75),0_2px_8px_rgba(0,0,0,0.4)]"
      style={{
        left: frame.x,
        top: frame.y,
        width: size.width,
        height: size.height,
        pointerEvents: interacting ? 'auto' : 'none',
      }}
    >
      {hasUrl ? (
        <iframe
          key={reloadKey}
          ref={iframeRef}
          title={frame.name}
          src={frame.url}
          className="h-full w-full border-0 bg-white"
          onLoad={handleLoaded}
        />
      ) : (
        <EmptyFrame />
      )}

      {frame.status === 'loading' && hasUrl && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[#0a0a0a]/70 backdrop-blur-sm">
          <div className="flex items-center gap-2 text-[13px] text-white/70">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="font-mono">connecting…</span>
          </div>
        </div>
      )}

      {frame.status === 'failed' && (
        <FailedFrame
          url={frame.url}
          error={frame.error}
          onRetry={() => {
            setReloadKey((k) => k + 1);
            studioDispatch({ type: 'UPDATE_FRAME', id: frame.id, patch: { status: 'loading' } });
          }}
        />
      )}
    </motion.div>
  );
}

function EmptyFrame() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-[#0d0d0d]">
      <div className="text-center">
        <div className="font-mono text-[13px] uppercase tracking-[0.2em] text-white/25">
          no source
        </div>
      </div>
    </div>
  );
}

function FailedFrame({
  url,
  error,
  onRetry,
}: {
  url: string;
  error?: string;
  onRetry: () => void;
}) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#0d0d0d] px-8 text-center">
      <TriangleAlert className="h-6 w-6 text-[#ee6018]" />
      <div className="text-[14px] font-medium text-white/80">This frame couldn’t load</div>
      <div className="max-w-[280px] font-mono text-[11px] leading-relaxed text-white/40">
        {error ?? 'The dev server did not respond.'}
        <div className="mt-1 truncate text-white/30">{url}</div>
      </div>
      <button
        onClick={onRetry}
        className="mt-1 rounded-md border border-white/15 px-3 py-1 text-[12px] text-white/70 transition-colors hover:border-[#ee6018]/60 hover:text-white"
      >
        Retry
      </button>
    </div>
  );
}
