import { useEffect, useLayoutEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { Loader2, ShieldAlert, TriangleAlert } from 'lucide-react';
import { isDesktop } from '../../lib/desktop';
import {
  attachNativeBrowser,
  closeNativeBrowser,
  detachNativeBrowser,
  onNativeBrowserLoadFailed,
  onNativeBrowserLoaded,
  reloadNativeBrowser,
  setNativeBrowserBounds,
  type NativeBrowserBounds,
} from '../../lib/nativeBrowser';
import { isSelfBrowserUrl } from '../browser/browserUrlSafety';
import { useNativeBrowserResetGeneration } from '../browser/useNativeBrowserReset';
import { useStudioCanvas, sizeOf, type StudioFrame } from './StudioCanvasContext';

/**
 * The world-space body of a frame: a live <iframe> pointed at the user's dev
 * server, rendered at its natural viewport size. The parent world layer applies
 * the pan/zoom transform, so this stays pixel-crisp and hot-reloads on its own.
 */
export default function StudioFrameBody({
  frame,
  entrance = true,
}: {
  frame: StudioFrame;
  /** False when mounting a restored thread — no pop-in on switch. */
  entrance?: boolean;
}) {
  const { studio, studioDispatch } = useStudioCanvas();
  const interacting = studio.interactingFrameId === frame.id;
  const size = sizeOf(frame);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousReloadRevision = useRef(frame.reloadRevision);
  const nativeNavigationRef = useRef(false);
  const frameUrlRef = useRef(frame.url);
  frameUrlRef.current = frame.url;
  const hasUrl = !!frame.url && frame.url !== 'about:blank';
  const native = isDesktop();
  const browserResetGeneration = useNativeBrowserResetGeneration(native);
  const nativeBrowserSessionId = `studio-frame:${frame.id}`;
  const appOrigin = typeof window === 'undefined' ? undefined : window.location.origin;
  // A frame pointed at the app's own origin would recursively embed the whole app
  // (studio included) — nested dev-server/HMR clients pile up until the machine
  // chokes (a CPU/wakeup storm). Refuse to render it, exactly as the browser pane
  // blocks opening the app inside its own pane.
  const isSelf = hasUrl && isSelfBrowserUrl(frame.url, appOrigin);

  // Guard against a frame that never fires load (offline dev server): fail after
  // a grace period so the frame shows an honest error instead of a forever spin.
  // The timer is cleared the moment the iframe loads so a live frame never flips
  // to failed.
  useEffect(() => {
    if (!hasUrl || isSelf) return;
    if (nativeNavigationRef.current) {
      nativeNavigationRef.current = false;
      return;
    }
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
  }, [frame.id, frame.url, frame.reloadRevision, hasUrl, isSelf, studioDispatch]);

  useEffect(() => {
    if (!native) return;
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    const track = (promise: Promise<() => void>) => {
      void promise.then((unlisten) => {
        if (disposed) unlisten();
        else unlisteners.push(unlisten);
      });
    };
    track(
      onNativeBrowserLoaded((event) => {
        if (event.browserSessionId !== nativeBrowserSessionId) return;
        nativeNavigationRef.current = event.url !== frameUrlRef.current;
        studioDispatch({
          type: 'UPDATE_FRAME',
          id: frame.id,
          patch: { url: event.url, status: 'ready', error: undefined },
        });
      }),
    );
    track(
      onNativeBrowserLoadFailed((event) => {
        if (event.browserSessionId !== nativeBrowserSessionId) return;
        studioDispatch({
          type: 'UPDATE_FRAME',
          id: frame.id,
          patch: {
            url: event.url,
            status: 'failed',
            error: event.error ?? 'The page could not be opened.',
          },
        });
      }),
    );
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => {
        unlisten();
      });
    };
  }, [frame.id, native, nativeBrowserSessionId, studioDispatch]);

  useLayoutEffect(() => {
    if (!native || !interacting || !hasUrl || isSelf) return;
    const bounds = nativeBounds(iframeRef.current);
    if (!bounds) return;
    void attachNativeBrowser(nativeBrowserSessionId, bounds, frameUrlRef.current).catch(
      (error: unknown) => {
        studioDispatch({
          type: 'UPDATE_FRAME',
          id: frame.id,
          patch: {
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          },
        });
      },
    );
    return () => {
      void detachNativeBrowser(nativeBrowserSessionId);
    };
  }, [
    browserResetGeneration,
    frame.id,
    hasUrl,
    interacting,
    isSelf,
    native,
    nativeBrowserSessionId,
    studioDispatch,
  ]);

  useEffect(() => {
    if (!native || !interacting) return;
    let animationFrame = 0;
    let previous: NativeBrowserBounds | null = null;
    const syncBounds = () => {
      const bounds = nativeBounds(iframeRef.current);
      if (bounds && !sameBounds(bounds, previous)) {
        previous = bounds;
        void setNativeBrowserBounds(nativeBrowserSessionId, bounds);
      }
      animationFrame = requestAnimationFrame(syncBounds);
    };
    animationFrame = requestAnimationFrame(syncBounds);
    return () => {
      cancelAnimationFrame(animationFrame);
    };
  }, [interacting, native, nativeBrowserSessionId]);

  useEffect(() => {
    const changed = previousReloadRevision.current !== frame.reloadRevision;
    previousReloadRevision.current = frame.reloadRevision;
    if (!changed || !native || !interacting) return;
    void reloadNativeBrowser(nativeBrowserSessionId).catch((error: unknown) => {
      studioDispatch({
        type: 'UPDATE_FRAME',
        id: frame.id,
        patch: {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        },
      });
    });
  }, [frame.id, frame.reloadRevision, interacting, native, nativeBrowserSessionId, studioDispatch]);

  useEffect(
    () => () => {
      if (native) void closeNativeBrowser(nativeBrowserSessionId);
    },
    [native, nativeBrowserSessionId],
  );

  const handleLoaded = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    // Skip the dispatch if already ready — a hot-reloading app fires onLoad
    // repeatedly, and re-dispatching churns the whole canvas each time.
    if (frame.status !== 'ready') {
      studioDispatch({
        type: 'UPDATE_FRAME',
        id: frame.id,
        patch: { status: 'ready', error: undefined },
      });
    }
  };

  return (
    <motion.div
      initial={entrance ? { opacity: 0, scale: 0.965 } : false}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className="absolute overflow-hidden rounded-[10px] bg-white shadow-[0_24px_80px_-24px_rgba(0,0,0,0.75),0_2px_8px_rgba(0,0,0,0.4)]"
      style={{
        left: frame.x,
        top: frame.y,
        width: size.width,
        height: size.height,
        pointerEvents: interacting && !native ? 'auto' : 'none',
      }}
    >
      {isSelf ? (
        <SelfEmbedError url={frame.url} />
      ) : hasUrl ? (
        <iframe
          key={frame.reloadRevision}
          ref={iframeRef}
          title={frame.name}
          src={frame.url}
          className="h-full w-full border-0 bg-white"
          sandbox="allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
          onLoad={handleLoaded}
        />
      ) : (
        <EmptyFrame />
      )}

      {!isSelf && frame.status === 'loading' && hasUrl && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-droid-bg/70 backdrop-blur-sm">
          <div className="flex items-center gap-2 text-[13px] text-droid-text-secondary">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Connecting…</span>
          </div>
        </div>
      )}

      {!isSelf && frame.status === 'failed' && (
        <FailedFrame
          url={frame.url}
          error={frame.error}
          onRetry={() => {
            studioDispatch({ type: 'RELOAD_FRAME', id: frame.id });
          }}
        />
      )}
    </motion.div>
  );
}

function SelfEmbedError({ url }: { url: string }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-droid-surface px-8 text-center">
      <ShieldAlert className="h-6 w-6 text-droid-accent" />
      <div className="text-[14px] font-medium text-droid-text">Can’t embed this app in itself</div>
      <div className="max-w-[300px] text-[11px] leading-relaxed text-droid-text-muted">
        {url} is DROIDEX’s own address. Rendering it here would nest the app inside itself and spike
        your CPU. Point the frame at your project’s dev server on a different port.
      </div>
    </div>
  );
}

function EmptyFrame() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-droid-surface">
      <div className="text-center">
        <div className="text-[13px] uppercase tracking-[0.2em] text-droid-text-muted">
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
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-droid-surface px-8 text-center">
      <TriangleAlert className="h-6 w-6 text-droid-accent" />
      <div className="text-[14px] font-medium text-droid-text">This frame couldn’t load</div>
      <div className="max-w-[280px] text-[11px] leading-relaxed text-droid-text-muted">
        {error ?? 'The dev server did not respond.'}
        <div className="mt-1 truncate text-droid-text-muted">{url}</div>
      </div>
      <button
        onClick={onRetry}
        className="mt-1 rounded-md border border-droid-border px-3 py-1 text-[12px] text-droid-text-secondary transition-colors hover:border-droid-accent/60 hover:text-droid-text"
      >
        Retry
      </button>
    </div>
  );
}

function nativeBounds(element: HTMLElement | null): NativeBrowserBounds | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return null;
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function sameBounds(a: NativeBrowserBounds, b: NativeBrowserBounds | null): boolean {
  return (
    b !== null &&
    Math.round(a.x) === Math.round(b.x) &&
    Math.round(a.y) === Math.round(b.y) &&
    Math.round(a.width) === Math.round(b.width) &&
    Math.round(a.height) === Math.round(b.height)
  );
}
