import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowLeft, ArrowRight, X } from 'lucide-react';
import { INTERVIEW_QUESTIONS } from './interviewQuestions';
import InterviewQuestionCard from './InterviewQuestionCard';
import StudioMark from './StudioMark';
import { answered, emptyAnswer, type Answer, type DesignBrief } from './designBrief';

/**
 * The design intake — a designer interviewing you, one question at a time. Pick
 * options, write freely, paste references. On finish it hands the assembled
 * brief up so the agent can author the full system from it.
 */
export default function DnaInterview({
  onClose,
  onComplete,
}: {
  onClose: () => void;
  onComplete: (brief: DesignBrief) => void;
}) {
  const [step, setStep] = useState(0);
  const [brief, setBrief] = useState<DesignBrief>({});
  const total = INTERVIEW_QUESTIONS.length;
  const q = INTERVIEW_QUESTIONS[step];
  const answer = brief[q.id] ?? emptyAnswer();
  const last = step === total - 1;
  const answeredCount = INTERVIEW_QUESTIONS.filter((question) => answered(brief[question.id])).length;

  const setAnswer = (next: Answer) => setBrief((prev) => ({ ...prev, [q.id]: next }));
  const back = () => setStep((s) => Math.max(0, s - 1));
  const next = () => (last ? onComplete(brief) : setStep((s) => Math.min(total - 1, s + 1)));

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-[#070707]/97 backdrop-blur-xl">
      <div data-electron-drag-region className="flex h-11 shrink-0 items-center justify-between px-4">
        <div className="flex items-center gap-2">
          <StudioMark className="h-3.5 w-3.5 text-white/70" />
          <span className="text-[12.5px] font-medium text-white/80">Design intake</span>
          <span className="font-mono text-[11px] text-white/35">
            {step + 1}/{total}
          </span>
        </div>
        <button
          onClick={onClose}
          className="no-drag flex h-7 w-7 items-center justify-center rounded-md text-white/45 transition-colors hover:bg-white/10 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Progress */}
      <div className="flex gap-1 px-4">
        {INTERVIEW_QUESTIONS.map((question, i) => (
          <div
            key={question.id}
            className="h-0.5 flex-1 rounded-full transition-colors duration-300"
            style={{
              backgroundColor:
                i < step ? '#ee6018' : i === step ? 'rgba(238,96,24,0.5)' : 'rgba(255,255,255,0.08)',
            }}
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

      <div className="flex items-center justify-between border-t border-white/[0.06] px-6 py-3.5">
        <button
          onClick={back}
          disabled={step === 0}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] text-white/50 transition-colors hover:text-white/85 disabled:opacity-30"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </button>

        <div className="flex items-center gap-2">
          {!last && (
            <button
              onClick={() => setStep((s) => Math.min(total - 1, s + 1))}
              className="rounded-lg px-3 py-1.5 text-[12.5px] text-white/40 transition-colors hover:text-white/70"
            >
              Skip
            </button>
          )}
          <button
            onClick={next}
            className="flex items-center gap-1.5 rounded-lg bg-[#ee6018] px-4 py-1.5 text-[12.5px] font-medium text-black transition-colors hover:bg-[#ff6a1e]"
          >
            {last ? `Create my system · ${answeredCount} answered` : 'Next'}
            {!last && <ArrowRight className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
    </div>
  );
}
