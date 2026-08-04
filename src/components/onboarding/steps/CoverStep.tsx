import { ArrowRight } from 'lucide-react';

import { BrandMark } from '../../BrandMark';

// Welcome cover, mirroring the app's own welcome screen: pixel brand mark, one
// calm headline in the UI font, a single primary action, and the same
// droid-rise stagger. First run should feel like the app, not a landing page.
export function CoverStep({ onNext }: { onNext: () => void }) {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="droid-rise">
        <BrandMark size={34} className="text-droid-accent" />
      </div>
      <h1
        className="droid-rise mt-6 text-[22px] leading-snug font-semibold tracking-tight text-droid-text"
        style={{ animationDelay: '90ms' }}
      >
        Let&apos;s get you set up.
      </h1>
      <p
        className="droid-rise mt-3 max-w-[340px] text-[13px] leading-relaxed text-droid-text-muted"
        style={{ animationDelay: '160ms' }}
      >
        A quick tour: check your machine, install the Droid CLI, connect your account, and pick a
        few defaults.
      </p>
      <div className="droid-rise mt-10" style={{ animationDelay: '230ms' }}>
        <button
          onClick={onNext}
          className="droid-button-primary inline-flex h-10 items-center gap-2 px-5 text-[13px] focus:outline-none focus-visible:ring-2 focus-visible:ring-droid-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-droid-bg"
        >
          Get started <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
