import { motion } from 'framer-motion';

export interface ThreadMessage {
  id: string;
  role: 'user' | 'agent';
  text: string;
  images?: string[];
  status?: string;
}

const SUGGESTIONS = [
  'Audit this screen and propose a cleaner direction',
  'Explore a calm, information-dense workspace',
  'Rework this flow using the existing design system',
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
      <div className="flex h-full flex-col justify-center px-5 py-8">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        >
          <div className="mb-3 text-[11.5px] font-medium text-droid-text-muted">
            Design with context
          </div>
          <h3 className="text-balance text-[18px] font-medium tracking-[-0.025em] text-droid-text">
            What should we make?
          </h3>
          <p className="mt-1.5 text-pretty text-[12.5px] leading-relaxed text-droid-text-muted">
            Describe the outcome. The agent works in your real project and uses its design DNA.
          </p>
          <div className="mt-5 space-y-1">
            {SUGGESTIONS.map((s, i) => (
              <motion.button
                key={s}
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.06 * i + 0.1, duration: 0.3 }}
                onClick={() => {
                  onPickSuggestion(s);
                }}
                className="w-full rounded-lg px-2.5 py-2 text-left text-[12px] leading-snug text-droid-text-secondary transition-colors hover:bg-droid-elevated hover:text-droid-text"
              >
                {s}
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
                    className="h-16 w-16 rounded-lg object-cover ring-1 ring-droid-border"
                  />
                ))}
              </div>
            )}
            {m.text && (
              <div className="rounded-2xl rounded-br-md bg-droid-accent/10 px-3.5 py-2 text-[13px] leading-relaxed text-droid-text">
                {m.text}
              </div>
            )}
          </div>
        ) : (
          <div key={m.id} className="max-w-[92%]">
            <div className="mb-1 flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-droid-accent" />
              <span className="text-[10.5px] text-droid-text-muted">Agent</span>
            </div>
            <div className="rounded-2xl rounded-tl-md border border-droid-border bg-droid-surface px-3.5 py-2 text-[13px] leading-relaxed text-droid-text-secondary">
              {m.text}
              {m.status && (
                <span className="ml-1 inline-block animate-pulse text-[11px] text-droid-text-muted">
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
