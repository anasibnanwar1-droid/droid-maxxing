import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { motion } from 'framer-motion';
import {
  Bug,
  Check,
  CheckCircle2,
  Copy,
  Ellipsis,
  ShieldCheck,
  ThumbsDown,
  ThumbsUp,
  X,
} from 'lucide-react';
import type { FeedbackAttachments, FeedbackCategory, FeedbackReportRequest } from '../lib/desktop';
import { submitFeedbackReport } from '../lib/feedbackReport';

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const CATEGORIES: {
  value: FeedbackCategory;
  label: string;
  icon: typeof Bug;
}[] = [
  { value: 'bug', label: 'Bug', icon: Bug },
  { value: 'bad_result', label: 'Bad result', icon: ThumbsDown },
  { value: 'good_result', label: 'Good result', icon: ThumbsUp },
  { value: 'safety', label: 'Safety', icon: ShieldCheck },
  { value: 'other', label: 'Other', icon: Ellipsis },
];

interface FeedbackModalProps {
  initialReport: FeedbackReportRequest;
  onClose: () => void;
}

export function FeedbackModal({ initialReport, onClose }: FeedbackModalProps) {
  const [category, setCategory] = useState(initialReport.category);
  const [description, setDescription] = useState(initialReport.description);
  const [attachments, setAttachments] = useState<FeedbackAttachments>({
    sessionLog: true,
    screenshot: false,
    appState: true,
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [reportId, setReportId] = useState('');
  const [copied, setCopied] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const reportIdRef = useRef<HTMLInputElement>(null);
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  const submittingRef = useRef(false);

  useEffect(() => {
    const opener = document.activeElement;
    descriptionRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => {
      setCopied(false);
    }, 1_800);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [copied]);

  useEffect(() => {
    if (reportId) copyButtonRef.current?.focus();
  }, [reportId]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('keydown', handleEscape);
    };
  }, [onClose, submitting]);

  const trapTab = (event: ReactKeyboardEvent) => {
    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusables = dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === dialog || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      (active === last || active === dialog || !dialog.contains(active))
    ) {
      event.preventDefault();
      first.focus();
    }
  };

  const submit = async () => {
    const details = description.trim();
    if (details.length < 5 || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError('');
    try {
      const receipt = await submitFeedbackReport({ category, description: details, attachments });
      setReportId(receipt.reportId);
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : 'The report could not be delivered.',
      );
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const copyReportId = async () => {
    try {
      await navigator.clipboard.writeText(reportId);
      setError('');
      setCopied(true);
    } catch {
      setError('Copy failed. Select the report ID and copy it manually.');
      reportIdRef.current?.focus();
      reportIdRef.current?.select();
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.14 }}
      className="fixed inset-0 z-[1250] flex items-center justify-center bg-black/65 p-5 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) onClose();
      }}
    >
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-title"
        aria-busy={submitting}
        tabIndex={-1}
        onKeyDown={trapTab}
        initial={{ y: 18, scale: 0.975, opacity: 0 }}
        animate={{ y: 0, scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 430, damping: 34 }}
        className="max-h-[calc(100vh-2.5rem)] w-full max-w-[680px] overflow-y-auto rounded-2xl border border-droid-border bg-droid-surface shadow-[0_28px_90px_rgba(0,0,0,0.58)]"
      >
        {reportId ? (
          <div className="px-8 py-9 text-center" aria-live="polite">
            <div className="mx-auto mb-5 flex h-11 w-11 items-center justify-center rounded-full border border-droid-accent/35 bg-droid-accent/10 text-droid-accent">
              <CheckCircle2 className="h-5 w-5" />
            </div>
            <h2
              id="feedback-title"
              className="text-[22px] font-semibold tracking-[-0.02em] text-droid-text"
            >
              Report accepted
            </h2>
            <p className="mx-auto mt-2 max-w-md text-[13px] leading-5 text-droid-text-secondary">
              Keep this report ID if you need to follow up with support.
            </p>
            <div className="mx-auto mt-6 flex max-w-[430px] items-center gap-2 rounded-xl border border-droid-border bg-droid-bg/60 p-2 pl-4">
              <input
                ref={reportIdRef}
                aria-label="Report ID"
                readOnly
                value={reportId}
                onFocus={(event) => {
                  event.currentTarget.select();
                }}
                className="min-w-0 flex-1 bg-transparent text-left font-mono text-[14px] font-medium tracking-[0.04em] text-droid-text outline-none"
              />
              <button
                ref={copyButtonRef}
                type="button"
                onClick={() => void copyReportId()}
                className="flex h-9 items-center gap-1.5 rounded-lg border border-droid-border bg-droid-elevated px-3 text-[12px] font-medium text-droid-text transition-colors hover:border-droid-border-hover hover:bg-droid-elevated/80"
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? 'Copied' : 'Copy ID'}
              </button>
            </div>
            {error && (
              <p role="alert" className="mt-3 text-[12px] text-red-400">
                {error}
              </p>
            )}
            <button
              type="button"
              onClick={onClose}
              className="mt-7 h-10 rounded-xl bg-droid-accent px-6 text-[13px] font-semibold text-droid-bg transition-opacity hover:opacity-90"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            <header className="flex items-start justify-between gap-5 px-7 pb-5 pt-6">
              <div>
                <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-droid-accent">
                  DROIDEX feedback
                </div>
                <h2
                  id="feedback-title"
                  className="text-[22px] font-semibold tracking-[-0.02em] text-droid-text"
                >
                  Share feedback
                </h2>
                <p className="mt-1.5 text-[13px] leading-5 text-droid-text-secondary">
                  Tell us what happened. A report ID will be created when delivery succeeds.
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                aria-label="Close feedback"
                className="rounded-lg p-2 text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text disabled:opacity-40"
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            <div className="border-y border-droid-border/70 px-7 py-5">
              <div className="flex flex-wrap gap-2" role="group" aria-label="Feedback category">
                {CATEGORIES.map((option) => {
                  const Icon = option.icon;
                  const selected = category === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={selected}
                      disabled={submitting}
                      onClick={() => {
                        setCategory(option.value);
                      }}
                      className={`flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-[12px] font-medium transition-colors ${
                        selected
                          ? 'border-droid-accent/55 bg-droid-accent/10 text-droid-text'
                          : 'border-droid-border bg-droid-bg/25 text-droid-text-secondary hover:border-droid-border-hover hover:text-droid-text'
                      }`}
                    >
                      <Icon className={`h-3.5 w-3.5 ${selected ? 'text-droid-accent' : ''}`} />
                      {option.label}
                    </button>
                  );
                })}
              </div>

              <label className="mt-5 block">
                <span className="mb-2 block text-[12px] font-medium text-droid-text">Details</span>
                <textarea
                  ref={descriptionRef}
                  value={description}
                  maxLength={2_000}
                  disabled={submitting}
                  onChange={(event) => {
                    setDescription(event.target.value);
                    if (error) setError('');
                  }}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                      event.preventDefault();
                      void submit();
                    }
                  }}
                  placeholder="What happened? What did you expect instead?"
                  className="min-h-[168px] w-full resize-none rounded-xl border border-droid-border bg-droid-bg/45 px-4 py-3 text-[14px] leading-6 text-droid-text outline-none transition-colors placeholder:text-droid-text-muted/70 focus:border-droid-accent/70 disabled:opacity-60"
                />
              </label>
              <div className="mt-2 flex items-start justify-between gap-5">
                <p className="max-w-[500px] text-[11px] leading-[17px] text-droid-text-muted">
                  Includes a random pseudonymous ID (report-scoped while automatic diagnostics are
                  off), app version, macOS version, architecture, and runtime versions. Chats,
                  files, browser content, keys, and credentials are not attached unless you opt in
                  to a screenshot below.
                </p>
                <span className="shrink-0 font-mono text-[10px] text-droid-text-muted">
                  {description.length}/2000
                </span>
              </div>
              {error && (
                <p role="alert" className="mt-3 text-[12px] text-red-400">
                  {error}
                </p>
              )}

              <div className="mt-4 border-t border-droid-border/50 pt-4">
                <div className="mb-2 text-[11px] font-medium text-droid-text-muted">
                  Include with this report
                </div>
                <div className="flex flex-wrap gap-4">
                  {(
                    [
                      ['sessionLog', 'Recent session log'],
                      ['screenshot', 'Screenshot'],
                      ['appState', 'App state'],
                    ] as const
                  ).map(([key, label]) => (
                    <label
                      key={key}
                      className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-droid-text-secondary"
                    >
                      <input
                        type="checkbox"
                        checked={attachments[key]}
                        disabled={submitting}
                        onChange={(event) => {
                          setAttachments((prev) => ({ ...prev, [key]: event.target.checked }));
                          if (error) setError('');
                        }}
                        className="accent-droid-accent"
                      />
                      {label}
                    </label>
                  ))}
                </div>
                <p className="mt-2 text-[10px] leading-[15px] text-droid-text-muted">
                  Optional. Session log and app state contain anonymized operational facts only. The
                  screenshot captures the full app window, which may include chats, file paths, and
                  browser content. Uncheck all to exclude these optional attachments.
                </p>
              </div>
            </div>

            <footer className="flex items-center justify-between gap-4 px-7 py-4">
              <span className="text-[11px] text-droid-text-muted">⌘↵ to submit</span>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={description.trim().length < 5 || submitting}
                aria-live="polite"
                className="h-10 min-w-[132px] rounded-xl bg-droid-accent px-5 text-[13px] font-semibold text-droid-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-35"
              >
                {submitting ? 'Sending…' : 'Submit report'}
              </button>
            </footer>
          </>
        )}
      </motion.div>
    </motion.div>
  );
}
