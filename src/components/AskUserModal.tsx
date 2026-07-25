import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useStore } from '../hooks/useStore';
import { respondQuestion } from '../lib/commands';

const EASE = [0.16, 1, 0.3, 1] as const;
const ACCENT = 'var(--droid-accent)';

export default function AskUserModal() {
  const { state, dispatch } = useStore();
  const question = state.pendingQuestion;

  const [current, setCurrent] = useState(0);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [customOpen, setCustomOpen] = useState<Record<number, boolean>>({});
  const inputRef = useRef<HTMLInputElement>(null);

  const requestId = question?.requestId;
  useEffect(() => {
    setCurrent(0);
    setAnswers({});
    setCustomOpen({});
  }, [requestId]);

  useEffect(() => {
    if (customOpen[question?.questions[current]?.index ?? -1]) {
      const t = setTimeout(() => inputRef.current?.focus(), 40);
      return () => clearTimeout(t);
    }
  }, [customOpen, current, question]);

  if (!question) return null;

  const q = question.questions[current];
  const total = question.questions.length;
  const isLast = current === total - 1;
  const answer = (answers[q.index] ?? '').trim();
  const typing = !!customOpen[q.index];
  const canAdvance = answer.length > 0;

  const pickOption = (opt: string) => {
    setAnswers((p) => ({ ...p, [q.index]: opt }));
    setCustomOpen((p) => ({ ...p, [q.index]: false }));
  };

  const openCustom = () => setCustomOpen((p) => ({ ...p, [q.index]: true }));

  const next = () => {
    if (!canAdvance) return;
    if (isLast) {
      const payload = question.questions.map((qq) => ({
        index: qq.index,
        question: qq.question,
        answer: (answers[qq.index] ?? '').trim(),
      }));
      respondQuestion(question.missionId, question.requestId, false, payload);
      dispatch({ type: 'CLEAR_QUESTION' });
    } else {
      setCurrent((c) => c + 1);
    }
  };

  const cancel = () => {
    respondQuestion(question.missionId, question.requestId, true, []);
    dispatch({ type: 'CLEAR_QUESTION' });
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ y: 24, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 24, opacity: 0 }}
        transition={{ duration: 0.26, ease: EASE }}
        className="absolute bottom-0 left-0 right-0 z-[70] border-t border-droid-border bg-droid-surface shadow-[0_-12px_40px_rgba(0,0,0,0.45)]"
      >
        <div className="px-5 pt-4 pb-3">
          {/* Question */}
          <div className="flex items-baseline justify-between gap-3 mb-3">
            <div className="text-[15px] leading-relaxed text-droid-text break-words">
              {q.question}
            </div>
            {total > 1 && (
              <span className="shrink-0 text-[11px] font-mono text-droid-text-muted">
                {current + 1}/{total}
              </span>
            )}
          </div>

          {/* Options */}
          <div className="space-y-1">
            {q.options.map((opt, i) => {
              const selected = !typing && answer === opt.trim();
              return (
                <button
                  key={`${opt}-${i}`}
                  onClick={() => pickOption(opt)}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors border border-dashed ${
                    selected
                      ? 'border-droid-border-hover bg-droid-elevated/40'
                      : 'border-transparent hover:bg-droid-elevated/25'
                  }`}
                >
                  <span
                    className={`text-[12px] font-mono w-3 shrink-0 ${selected ? 'text-droid-text' : 'text-droid-text-muted'}`}
                  >
                    {i + 1}
                  </span>
                  <span
                    className={`text-[13.5px] break-words ${selected ? 'text-droid-text' : 'text-droid-text-secondary'}`}
                  >
                    {opt}
                  </span>
                </button>
              );
            })}

            {/* Type-your-own row */}
            <div
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-dashed ${
                typing
                  ? 'border-droid-border-hover bg-droid-elevated/40'
                  : 'border-transparent hover:bg-droid-elevated/25'
              }`}
            >
              <span
                className={`text-[12px] font-mono w-3 shrink-0 ${typing ? 'text-droid-text' : 'text-droid-text-muted'}`}
              >
                {q.options.length + 1}
              </span>
              {typing ? (
                <input
                  ref={inputRef}
                  type="text"
                  value={answers[q.index] ?? ''}
                  onChange={(e) => setAnswers((p) => ({ ...p, [q.index]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      next();
                    }
                  }}
                  placeholder="Type your own answer…"
                  className="flex-1 bg-transparent text-[13.5px] text-droid-text placeholder:text-droid-text-muted/60 outline-none"
                />
              ) : (
                <button
                  onClick={openCustom}
                  className="flex-1 text-left text-[13.5px] text-droid-text-secondary"
                >
                  Or type your own answer…
                </button>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 mt-3">
            {current > 0 && (
              <button
                onClick={() => setCurrent((c) => c - 1)}
                className="px-3.5 py-1.5 rounded-lg text-[12.5px] uppercase tracking-wide text-droid-text-secondary hover:bg-droid-elevated/60 transition-colors"
              >
                Back
              </button>
            )}
            <button
              onClick={cancel}
              className="px-3.5 py-1.5 rounded-lg text-[12.5px] uppercase tracking-wide text-droid-text-secondary border border-droid-border hover:bg-droid-elevated/60 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={next}
              disabled={!canAdvance}
              className="px-4 py-1.5 rounded-lg text-[12.5px] uppercase tracking-wide font-medium text-droid-bg disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
              style={{ background: ACCENT }}
            >
              {isLast ? 'Submit' : 'Next'}
            </button>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
