import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'framer-motion';

import type { OnboardingController } from '../../hooks/useOnboarding';
import { EASE } from './kit';
import { advancePastRemovedStep, stepsForEnv, type StepId } from './stepFlow';
import { CoverStep } from './steps/CoverStep';
import { DoneStep } from './steps/DoneStep';
import { InstallStep } from './steps/InstallStep';
import { PreferencesStep } from './steps/PreferencesStep';
import { SignInStep } from './steps/SignInStep';
import { SystemStep } from './steps/SystemStep';

// Full-screen first-run flow over the app's own surface. Uses the same droid-*
// theme tokens as every other screen, so it picks up the active theme's taste
// instead of carrying a palette of its own.
export default function OnboardingWizard({
  controller,
  onComplete,
}: {
  controller: OnboardingController;
  onComplete: () => void;
}) {
  const { env } = controller;
  const [stepId, setStepId] = useState<StepId>('welcome');

  const steps = useMemo(() => stepsForEnv(env), [env]);

  const index = Math.max(0, steps.indexOf(stepId));
  const go = (delta: number) => {
    const next = steps[Math.min(steps.length - 1, Math.max(0, index + delta))];
    setStepId(next);
  };
  // If the CLI gets installed mid-flow the install step disappears; advance to
  // the next still-present step (by canonical order) instead of snapping back
  // to Welcome.
  useEffect(() => {
    if (steps.includes(stepId)) return;
    setStepId(advancePastRemovedStep(steps, stepId));
  }, [steps, stepId]);

  return (
    <MotionConfig reducedMotion="user">
      <motion.div
        className="fixed inset-0 z-50 flex flex-col bg-droid-bg text-droid-text"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.35 }}
      >
        <header
          data-electron-drag-region
          className="h-11 shrink-0 flex items-center justify-end px-5 select-none"
        >
          <span className="font-mono text-[10px] tracking-[0.18em] text-droid-text-muted">
            {index + 1} / {steps.length}
          </span>
        </header>

        <main className="flex-1 min-h-0 flex flex-col items-center justify-center px-6">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={stepId}
              className="w-full"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.32, ease: EASE }}
            >
              {stepId === 'welcome' && (
                <CoverStep
                  onNext={() => {
                    go(1);
                  }}
                />
              )}
              {stepId === 'system' && (
                <SystemStep
                  controller={controller}
                  onNext={() => {
                    go(1);
                  }}
                />
              )}
              {stepId === 'install' && (
                <InstallStep
                  controller={controller}
                  onNext={() => {
                    go(1);
                  }}
                  onBack={() => {
                    go(-1);
                  }}
                />
              )}
              {stepId === 'signin' && (
                <SignInStep
                  controller={controller}
                  onNext={() => {
                    go(1);
                  }}
                  onBack={() => {
                    go(-1);
                  }}
                />
              )}
              {stepId === 'preferences' && (
                <PreferencesStep
                  controller={controller}
                  onNext={() => {
                    go(1);
                  }}
                  onBack={() => {
                    go(-1);
                  }}
                />
              )}
              {stepId === 'done' && <DoneStep controller={controller} onComplete={onComplete} />}
            </motion.div>
          </AnimatePresence>
        </main>

        <footer className="h-8 shrink-0" />
      </motion.div>
    </MotionConfig>
  );
}
