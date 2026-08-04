import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowLeft, ArrowRight, X } from 'lucide-react';
import { INTERVIEW_QUESTIONS } from './interviewQuestions';
import InterviewQuestionCard from './InterviewQuestionCard';
import { answered, emptyAnswer, type Answer, type DesignBrief } from './designBrief';

/**
 * The design intake — a designer interviewing you, one question at a time. Pick
 * options, write freely, paste references. On finish it hands the assembled
 * brief up so the agent can author the full system from it.
 */
export default function DnaInterview({
  onClose,
  onComplete,
  completionDisabled = false,
}: {
  onClose: () => void;
  onComplete: (brief: DesignBrief, directions: number) => void;
  completionDisabled?: boolean;
}) {
  const [step, setStep] = useState(0);
  const [brief, setBrief] = useState<DesignBrief>({});
  const [directions, setDirections] = useState(3);
  const total = INTERVIEW_QUESTIONS.length;
  const q = INTERVIEW_QUESTIONS[step];
  const answer = brief[q.id] ?? emptyAnswer();
  const last = step === total - 1;
  const answeredCount = INTERVIEW_QUESTIONS.filter((question) =>
    answered(brief[question.id]),
  ).length;

  const setAnswer = (next: Answer) => {
    setBrief((prev) => ({ ...prev, [q.id]: next }));
  };
  const back = () => {
    setStep((s) => Math.max(0, s - 1));
  };
  const next = () => {
    if (last) onComplete(brief, directions);
    else setStep((s) => Math.min(total - 1, s + 1));
  };

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-droid-bg/97 backdrop-blur-xl">
      <div
        data-electron-drag-region
        className="flex h-11 shrink-0 items-center justify-between px-4"
      >
        <div className="flex items-center gap-2">
          <span className="text-[12.5px] font-medium text-droid-text">Design intake</span>
          <span className="text-[11px] tabular-nums text-droid-text-muted">
            {step + 1}/{total}
          </span>
        </div>
        <button
          onClick={onClose}
          className="no-drag flex h-7 w-7 items-center justify-center rounded-md text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Progress */}
      <div className="flex gap-1 px-4">
        {INTERVIEW_QUESTIONS.map((question, i) => (
          <div
            key={question.id}
            className={`h-0.5 flex-1 rounded-full transition-colors duration-300 ${
              i < step ? 'bg-droid-accent' : i === step ? 'bg-droid-accent/45' : 'bg-droid-border'
            }`}
          />
        ))}
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-8">
        <div className="w-full max-w-xl">
          <AnimatePresence mode="wait">
            <motion.div
              key={q.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            >
              <InterviewQuestionCard question={q} answer={answer} onChange={setAnswer} />
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-droid-border px-6 py-3.5">
        <button
          onClick={back}
          disabled={step === 0}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] text-droid-text-muted transition-colors hover:text-droid-text disabled:opacity-30"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </button>

        <div className="flex items-center gap-2">
          {last && (
            <div
              className="mr-1 flex items-center gap-1"
              title="How many visual directions to explore"
            >
              {[1, 2, 3, 4].map((n) => (
                <button
                  key={n}
                  onClick={() => {
                    setDirections(n);
                  }}
                  className={`h-7 w-7 rounded-md text-[11.5px] transition-colors ${
                    directions === n
                      ? 'bg-droid-accent/20 text-droid-accent'
                      : 'text-droid-text-muted hover:bg-droid-active/70 hover:text-droid-text-secondary'
                  }`}
                >
                  {n}
                </button>
              ))}
              <span className="ml-1 text-[11px] text-droid-text-muted">directions</span>
            </div>
          )}
          {!last && (
            <button
              onClick={() => {
                setStep((s) => Math.min(total - 1, s + 1));
              }}
              className="rounded-lg px-3 py-1.5 text-[12.5px] text-droid-text-muted transition-colors hover:text-droid-text-secondary"
            >
              Skip
            </button>
          )}
          <button
            onClick={next}
            disabled={last && completionDisabled}
            className="flex items-center gap-1.5 rounded-lg bg-droid-accent px-4 py-1.5 text-[12.5px] font-medium text-droid-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {last
              ? completionDisabled
                ? 'Starting design session…'
                : `Create my system · ${String(answeredCount)} answered`
              : 'Next'}
            {!last && <ArrowRight className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
    </div>
  );
}
