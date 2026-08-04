import { motion } from 'framer-motion';
import { SquarePen, X } from 'lucide-react';

const EASE = [0.16, 1, 0.3, 1] as const;

// Bundled nebula artwork for the header. Resolved through URL (not a static
// import) so node-based render tests can load this module without an asset
// loader; Vite still emits the file with a hashed name in production builds.
const WELCOME_IMAGE_URL = new URL('../assets/welcome-nebula.jpg', import.meta.url).href;

// Dismissal key for the welcome card; future sidebar announcements get their
// own id so they show even after the user dismissed this one.
export const SIDEBAR_WELCOME_CARD_ID = 'welcome-to-droidex';

// First-run card pinned above the sidebar Settings button: nebula header,
// one-line pitch, and a primary action that starts a chat. The motion wrapper
// owns entrance and the height-collapse exit so the footer reflows smoothly;
// Sidebar gates visibility and persistence.
export function SidebarWelcomeCard({
  onStart,
  onDismiss,
}: {
  onStart: () => void;
  onDismiss: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 6, scale: 0.98, height: 0, marginBottom: 0 }}
      transition={{ duration: 0.22, ease: EASE }}
      className="mb-2 overflow-hidden"
    >
      <div className="relative overflow-hidden rounded-2xl border border-droid-border bg-droid-elevated shadow-[0_8px_28px_rgba(0,0,0,0.45)]">
        {/* Visual: nebula artwork melting into the card body — a multi-stop
            blend instead of a hard edge, slightly enriched so the color carries,
            with a soft top scrim keeping the dismiss button legible. */}
        <div className="relative h-28 overflow-hidden">
          <img
            src={WELCOME_IMAGE_URL}
            alt=""
            className="h-full w-full scale-105 object-cover saturate-[1.2]"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-droid-elevated via-droid-elevated/35 to-transparent" />
          <div className="absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-black/45 to-transparent" />
        </div>

        <div className="relative -mt-6 px-3.5 pb-3">
          <span className="text-[13.5px] font-semibold text-droid-text">Welcome to Droidex</span>
          <p className="mt-1 text-[12px] leading-snug text-droid-text-muted">
            Chats, workspaces and missions live here. Start a chat and put Droid to work.
          </p>
          <button
            type="button"
            onClick={onStart}
            className="mt-2.5 flex items-center gap-1.5 rounded-lg bg-droid-accent px-3 py-1.5 text-[12px] font-medium text-droid-bg transition-opacity hover:opacity-90"
          >
            <SquarePen className="h-3.5 w-3.5" />
            Start a chat
          </button>
        </div>

        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="absolute right-2 top-2 rounded-md bg-black/35 p-1 text-white/85 backdrop-blur-sm transition-colors hover:bg-black/55 hover:text-white"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </motion.div>
  );
}
