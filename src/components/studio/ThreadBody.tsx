import { motion } from 'framer-motion';
import { ArrowUpRight } from 'lucide-react';
import StudioMark from './StudioMark';

export interface ThreadMessage {
  id: string;
  role: 'user' | 'agent';
  text: string;
  images?: string[];
  status?: string;
}

const SUGGESTIONS = [
  'Design a pricing page with three tiers',
  'A clean analytics dashboard, dense but calm',
  'Reimagine the landing hero, editorial feel',
  'A settings screen with a left rail',
];

export default function ThreadBody({
  messages,
  onPickSuggestion,
}: {
  messages: ThreadMessage[];
  onPickSuggestion: (s: string) => void;
}) {
  if (messages.length === 0) {
    return (
      <div className="flex h-full flex-col justify-end px-4 pb-2">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        >
          <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-gradient-to-b from-white/[0.06] to-transparent">
            <StudioMark className="h-4 w-4 text-white/70" />
          </div>
          <h3 className="text-[15px] font-medium tracking-tight text-white/90">
            Start a direction
          </h3>
          <p className="mt-1 text-[12.5px] leading-relaxed text-white/40">
            Describe what you want to see. The agent designs it into a live frame on the canvas,
            working from your project’s design DNA.
          </p>
          <div className="mt-4 space-y-1.5">
            {SUGGESTIONS.map((s, i) => (
              <motion.button
                key={s}
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.06 * i + 0.1, duration: 0.3 }}
                onClick={() => { onPickSuggestion(s); }}
                className="group flex w-full items-center justify-between gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-left text-[12.5px] text-white/60 transition-colors hover:border-white/12 hover:bg-white/[0.04] hover:text-white/90"
              >
                <span className="truncate">{s}</span>
                <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-white/25 transition-colors group-hover:text-[#ee6018]" />
              </motion.button>
            ))}
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      {messages.map((m) =>
        m.role === 'user' ? (
          <div key={m.id} className="flex max-w-[85%] flex-col items-end gap-1 self-end">
            {m.images && m.images.length > 0 && (
              <div className="flex flex-wrap justify-end gap-1">
                {m.images.map((src, i) => (
                  <img
                    key={i}
                    src={src}
                    alt="attachment"
                    className="h-16 w-16 rounded-lg object-cover ring-1 ring-white/10"
                  />
                ))}
              </div>
            )}
            {m.text && (
              <div className="rounded-2xl rounded-br-md bg-[#ee6018]/12 px-3.5 py-2 text-[13px] leading-relaxed text-white/90">
                {m.text}
              </div>
            )}
          </div>
        ) : (
          <div key={m.id} className="max-w-[92%]">
            <div className="mb-1 flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-[#ee6018]" />
              <span className="font-mono text-[10px] uppercase tracking-wider text-white/40">
                agent
              </span>
            </div>
            <div className="rounded-2xl rounded-tl-md border border-white/[0.07] bg-white/[0.02] px-3.5 py-2 text-[13px] leading-relaxed text-white/75">
              {m.text}
              {m.status && (
                <span className="ml-1 inline-block animate-pulse font-mono text-[11px] text-white/40">
                  {m.status}
                </span>
              )}
            </div>
          </div>
        ),
      )}
    </div>
  );
}
