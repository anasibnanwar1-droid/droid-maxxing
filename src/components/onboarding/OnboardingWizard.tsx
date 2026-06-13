import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, Check, Download, ExternalLink, KeyRound, Loader2, RefreshCw } from 'lucide-react';
import type { OnboardingController } from '../../hooks/useOnboarding';
import type { EnvironmentReport, InstallChannel } from '../../types/bridge';
import { EDITOR_OPTIONS, setDefaultEditor, type EditorId } from '../../lib/editorOpen';
import { listEditors } from '../../lib/desktop';
import { EditorIcon } from '../EditorIcon';

const EASE: [number, number, number, number] = [0.16, 1, 0.3, 1];

const CHANNEL_LABEL: Record<InstallChannel, string> = {
  script: 'Official installer',
  brew: 'Homebrew',
  npm: 'npm',
};

type StepId = 'welcome' | 'system' | 'install' | 'signin' | 'preferences' | 'done';

const STEP_ORDER: StepId[] = ['welcome', 'system', 'install', 'signin', 'preferences', 'done'];

export default function OnboardingWizard({ controller, onComplete }: { controller: OnboardingController; onComplete: () => void }) {
  const { env } = controller;
  const [stepId, setStepId] = useState<StepId>('welcome');

  const steps = useMemo<StepId[]>(() => {
    const base: StepId[] = ['welcome', 'system'];
    if (!env || !env.cli.present) base.push('install');
    base.push('signin', 'preferences', 'done');
    return base;
  }, [env]);

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
    const pos = STEP_ORDER.indexOf(stepId);
    const next = steps.find((s) => STEP_ORDER.indexOf(s) >= pos) ?? steps[steps.length - 1];
    setStepId(next);
  }, [steps, stepId]);

  return (
    <motion.div
      className="fixed inset-0 z-50 flex flex-col bg-droid-bg text-droid-text"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
    >
      <div data-electron-drag-region className="h-9 shrink-0" />
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center px-6">
        <div className="w-full max-w-[460px]">
          <StepDots count={steps.length} index={index} />
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={stepId}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.25, ease: EASE }}
            >
              {stepId === 'welcome' && <WelcomeStep onNext={() => go(1)} />}
              {stepId === 'system' && <SystemStep controller={controller} onNext={() => go(1)} />}
              {stepId === 'install' && <InstallStep controller={controller} onNext={() => go(1)} />}
              {stepId === 'signin' && <SignInStep controller={controller} onNext={() => go(1)} onBack={() => go(-1)} />}
              {stepId === 'preferences' && <PreferencesStep controller={controller} onNext={() => go(1)} onBack={() => go(-1)} />}
              {stepId === 'done' && <DoneStep controller={controller} onComplete={onComplete} />}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
      <div className="h-12 shrink-0 flex items-center justify-center">
        <span className="text-[11px] text-droid-text-muted">You can always change these settings later.</span>
      </div>
    </motion.div>
  );
}

/* ── shared bits ── */

function StepDots({ count, index }: { count: number; index: number }) {
  return (
    <div className="flex items-center justify-center gap-1.5 mb-10">
      {Array.from({ length: count }).map((_, i) => (
        <span
          key={i}
          className={`h-1 rounded-full transition-all duration-300 ${i === index ? 'w-6 bg-droid-accent' : i < index ? 'w-1.5 bg-droid-accent/50' : 'w-1.5 bg-droid-border'}`}
        />
      ))}
    </div>
  );
}

function PrimaryButton({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full h-10 rounded-lg bg-droid-accent text-white text-[13px] font-medium flex items-center justify-center gap-2 transition-opacity hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
    >
      {children}
    </button>
  );
}

function GhostButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full h-10 rounded-lg bg-droid-elevated border border-droid-border text-droid-text text-[13px] font-medium flex items-center justify-center gap-2 transition-colors hover:border-droid-border-hover"
    >
      {children}
    </button>
  );
}

function Heading({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="mb-7">
      <h1 className="text-[19px] font-semibold tracking-tight">{title}</h1>
      <p className="text-[13px] text-droid-text-muted mt-1 leading-relaxed">{sub}</p>
    </div>
  );
}

/* ── steps ── */

function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <div className="flex flex-col items-center text-center">
      <h1 className="text-[22px] font-semibold tracking-tight">DROIDEX</h1>
      <p className="text-[13px] text-droid-text-muted mt-1.5 mb-8">The agentic desktop for Droid, built on the Factory CLI.</p>
      <div className="w-full">
        <PrimaryButton onClick={onNext}>
          Get started <ArrowRight className="w-4 h-4" />
        </PrimaryButton>
      </div>
    </div>
  );
}

function SystemStep({ controller, onNext }: { controller: OnboardingController; onNext: () => void }) {
  const { env, refreshEnv } = controller;
  const checks = useMemo(() => systemChecks(env), [env]);

  return (
    <div>
      <Heading title="System check" sub="DROIDEX is detecting what's already set up on your machine." />
      <div className="rounded-lg border border-droid-border divide-y divide-droid-border overflow-hidden mb-6">
        {checks.map((check) => (
          <div key={check.label} className="flex items-center justify-between px-3.5 py-3">
            <div className="flex items-center gap-3">
              <CheckDot ok={check.ok} pending={!env} />
              <span className="text-[13px] text-droid-text">{check.label}</span>
            </div>
            <span className="text-[12px] text-droid-text-muted font-mono">{check.detail}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={refreshEnv}
          className="h-10 px-3 rounded-lg bg-droid-elevated border border-droid-border text-droid-text-muted text-[12px] flex items-center gap-1.5 hover:border-droid-border-hover transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Re-scan
        </button>
        <div className="flex-1">
          <PrimaryButton onClick={onNext} disabled={!env}>
            Continue <ArrowRight className="w-4 h-4" />
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

function CheckDot({ ok, pending }: { ok: boolean; pending?: boolean }) {
  if (pending) return <Loader2 className="w-4 h-4 text-droid-text-muted animate-spin" />;
  return (
    <span className={`w-4 h-4 rounded-full flex items-center justify-center ${ok ? 'bg-droid-green/20 text-droid-green' : 'bg-droid-orange/20 text-droid-orange'}`}>
      {ok ? <Check className="w-3 h-3" strokeWidth={3} /> : <span className="w-1.5 h-1.5 rounded-full bg-droid-orange" />}
    </span>
  );
}

function systemChecks(env: EnvironmentReport | null): { label: string; ok: boolean; detail: string }[] {
  if (!env) {
    return [
      { label: 'Operating system', ok: false, detail: '…' },
      { label: 'Node runtime', ok: false, detail: '…' },
      { label: 'Droid CLI', ok: false, detail: '…' },
      { label: 'Package managers', ok: false, detail: '…' },
    ];
  }
  const managers = Object.entries(env.packageManagers)
    .filter(([, present]) => present)
    .map(([name]) => name);
  return [
    { label: 'Operating system', ok: true, detail: `${env.platform} · ${env.arch}` },
    { label: 'Node runtime', ok: env.node.present, detail: env.node.version ? `v${env.node.version}` : 'missing' },
    { label: 'Droid CLI', ok: env.cli.present, detail: env.cli.present ? (env.cli.version ?? 'installed') : 'not found' },
    { label: 'Package managers', ok: managers.length > 0, detail: managers.length ? managers.join(', ') : 'none' },
  ];
}

function InstallStep({ controller, onNext }: { controller: OnboardingController; onNext: () => void }) {
  const { env, installLog, installing, lastResult, install } = controller;
  const channels = env?.availableChannels ?? [];
  const [channel, setChannel] = useState<InstallChannel | null>(channels[0] ?? null);
  useEffect(() => {
    if (!channel && channels.length) setChannel(channels[0]);
  }, [channels, channel]);

  const installed = Boolean(env?.cli.present);
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [installLog]);

  if (installed) {
    return (
      <div>
        <Heading title="Droid CLI ready" sub={`Detected ${env?.cli.version ? `v${env.cli.version}` : 'an installation'} at ${env?.cli.path}.`} />
        <PrimaryButton onClick={onNext}>
          Continue <ArrowRight className="w-4 h-4" />
        </PrimaryButton>
      </div>
    );
  }

  return (
    <div>
      <Heading title="Install the Droid CLI" sub="Droid runs on the Factory CLI. Pick how you'd like to install it." />
      <div className="grid grid-cols-1 gap-2 mb-4">
        {channels.length === 0 && (
          <p className="text-[12px] text-droid-orange">No supported package manager found. Install curl, Homebrew, or npm first.</p>
        )}
        {channels.map((c) => (
          <button
            key={c}
            onClick={() => setChannel(c)}
            disabled={!!installing}
            className={`flex items-center justify-between px-3.5 py-3 rounded-lg border text-left transition-colors ${channel === c ? 'border-droid-accent bg-droid-accent/5' : 'border-droid-border hover:border-droid-border-hover'}`}
          >
            <span className="text-[13px] text-droid-text">{CHANNEL_LABEL[c]}</span>
            {channel === c && <Check className="w-4 h-4 text-droid-accent" strokeWidth={3} />}
          </button>
        ))}
      </div>

      {(installing || installLog.length > 0) && (
        <div
          ref={logRef}
          className="mb-4 max-h-40 overflow-auto rounded-lg border border-droid-border bg-droid-surface p-3 font-mono text-[11px] leading-5 text-droid-text-muted"
        >
          {installLog.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap break-words">{line}</div>
          ))}
          {installing && <div className="flex items-center gap-1.5 text-droid-accent"><Loader2 className="w-3 h-3 animate-spin" /> working…</div>}
        </div>
      )}

      {lastResult && !lastResult.ok && (
        <p className="text-[12px] text-droid-orange mb-3">Installation didn't finish. Review the log and try again.</p>
      )}

      {installing ? (
        <PrimaryButton onClick={() => {}} disabled>
          <Loader2 className="w-4 h-4 animate-spin" /> Installing…
        </PrimaryButton>
      ) : (
        <PrimaryButton onClick={() => channel && install(channel)} disabled={!channel}>
          <Download className="w-4 h-4" /> Install with {channel ? CHANNEL_LABEL[channel] : 'package manager'}
        </PrimaryButton>
      )}
    </div>
  );
}

function SignInStep({ controller, onNext, onBack }: { controller: OnboardingController; onNext: () => void; onBack: () => void }) {
  const { env, login } = controller;
  const [waiting, setWaiting] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);

  const signedIn = Boolean(env?.auth.loginPresent || env?.auth.apiKeyConfigured);

  useEffect(() => {
    if (signedIn) setWaiting(false);
  }, [signedIn]);

  return (
    <div>
      <Heading title="Sign in to Factory" sub="Connect your account so Droid's models can run. This opens your browser to finish sign-in." />

      {signedIn ? (
        <div className="rounded-lg border border-droid-green/40 bg-droid-green/10 px-3.5 py-3 mb-5 flex items-center gap-2 text-[13px] text-droid-text">
          <Check className="w-4 h-4 text-droid-green" strokeWidth={3} /> You're signed in.
        </div>
      ) : (
        <div className="space-y-2 mb-5">
          <PrimaryButton onClick={() => { setWaiting(true); login(); }}>
            {waiting ? <><Loader2 className="w-4 h-4 animate-spin" /> Waiting for browser…</> : <><ExternalLink className="w-4 h-4" /> Sign in with browser</>}
          </PrimaryButton>
          {!showKey ? (
            <button onClick={() => setShowKey(true)} className="w-full text-[12px] text-droid-text-muted hover:text-droid-text transition-colors py-1.5 flex items-center justify-center gap-1.5">
              <KeyRound className="w-3.5 h-3.5" /> Use an API key instead
            </button>
          ) : (
            <div className="rounded-lg border border-droid-border p-3 space-y-2">
              <input
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="FACTORY_API_KEY"
                className="w-full h-9 px-3 rounded-md bg-droid-surface border border-droid-border text-[12px] font-mono text-droid-text focus:outline-none focus:border-droid-accent"
              />
              <PrimaryButton
                onClick={async () => { setSaving(true); try { await controller.saveApiKey(key); } finally { setSaving(false); } }}
                disabled={!key.trim() || saving}
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save key'}
              </PrimaryButton>
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button onClick={onBack} className="h-10 px-4 rounded-lg text-droid-text-muted text-[13px] hover:text-droid-text transition-colors">Back</button>
        <div className="flex-1">
          {signedIn ? (
            <PrimaryButton onClick={onNext}>Continue <ArrowRight className="w-4 h-4" /></PrimaryButton>
          ) : (
            <GhostButton onClick={onNext}>Skip for now</GhostButton>
          )}
        </div>
      </div>
    </div>
  );
}

function PreferencesStep({ controller, onNext, onBack }: { controller: OnboardingController; onNext: () => void; onBack: () => void }) {
  const [editors, setEditors] = useState<EditorId[]>([]);
  const [editor, setEditor] = useState<EditorId>(controller.onboarding?.defaultEditor as EditorId ?? 'vscode');
  const [cliAuto, setCliAuto] = useState(controller.onboarding?.cliAutoUpdate ?? true);
  const [appAuto, setAppAuto] = useState(controller.onboarding?.appAutoUpdate ?? true);

  useEffect(() => {
    void listEditors().then((ids) => {
      setEditors(ids);
      if (ids.length && !ids.includes(editor)) setEditor(ids[0]);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const editorOptions = EDITOR_OPTIONS.filter((o) => editors.includes(o.id));

  const save = async () => {
    setDefaultEditor(editor);
    await controller.patch({ defaultEditor: editor, cliAutoUpdate: cliAuto, appAutoUpdate: appAuto });
    onNext();
  };

  return (
    <div>
      <Heading title="Preferences" sub="Set your defaults. Existing Droid settings are imported automatically." />

      <div className="rounded-lg border border-droid-border divide-y divide-droid-border overflow-hidden mb-6">
        <div className="px-3.5 py-3">
          <div className="text-[13px] text-droid-text mb-2">Default editor</div>
          <div className="flex flex-wrap gap-2">
            {editorOptions.length === 0 && <span className="text-[12px] text-droid-text-muted">No editors detected.</span>}
            {editorOptions.map((o) => (
              <button
                key={o.id}
                onClick={() => setEditor(o.id)}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-[12px] transition-colors ${editor === o.id ? 'border-droid-accent bg-droid-accent/5 text-droid-text' : 'border-droid-border text-droid-text-muted hover:border-droid-border-hover'}`}
              >
                <EditorIcon editor={o.id} size={14} /> {o.label}
              </button>
            ))}
          </div>
        </div>
        <ToggleRow label="Keep the Droid CLI up to date" sub="Updates silently on launch." checked={cliAuto} onChange={setCliAuto} />
        <ToggleRow label="Auto-update DROIDEX" sub="Installs new app builds and restarts." checked={appAuto} onChange={setAppAuto} />
      </div>

      <div className="flex items-center gap-2">
        <button onClick={onBack} className="h-10 px-4 rounded-lg text-droid-text-muted text-[13px] hover:text-droid-text transition-colors">Back</button>
        <div className="flex-1">
          <PrimaryButton onClick={save}>Continue <ArrowRight className="w-4 h-4" /></PrimaryButton>
        </div>
      </div>
    </div>
  );
}

function ToggleRow({ label, sub, checked, onChange }: { label: string; sub?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between px-3.5 py-3">
      <div>
        <div className="text-[13px] text-droid-text">{label}</div>
        {sub && <div className="text-[11px] text-droid-text-muted">{sub}</div>}
      </div>
      <button
        onClick={() => onChange(!checked)}
        className={`w-10 h-6 rounded-full transition-colors shrink-0 flex items-center p-0.5 ${checked ? 'bg-droid-accent' : 'bg-droid-border'}`}
      >
        <span className={`w-5 h-5 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-4' : 'translate-x-0'}`} />
      </button>
    </div>
  );
}

function DoneStep({ controller, onComplete }: { controller: OnboardingController; onComplete: () => void }) {
  const { env } = controller;
  const summary = [
    { label: 'Droid CLI', ok: Boolean(env?.cli.present) },
    { label: 'Signed in', ok: Boolean(env?.auth.loginPresent || env?.auth.apiKeyConfigured) },
  ];
  return (
    <div className="flex flex-col items-center text-center">
      <h1 className="text-[20px] font-semibold tracking-tight">You're all set</h1>
      <p className="text-[13px] text-droid-text-muted mt-1.5 mb-6">Everything's ready. Let's build something.</p>
      <div className="w-full rounded-lg border border-droid-border divide-y divide-droid-border overflow-hidden mb-6">
        {summary.map((s) => (
          <div key={s.label} className="flex items-center justify-between px-3.5 py-2.5">
            <span className="text-[13px] text-droid-text">{s.label}</span>
            <CheckDot ok={s.ok} />
          </div>
        ))}
      </div>
      <div className="w-full">
        <PrimaryButton onClick={async () => { await controller.patch({ completed: true }); onComplete(); }}>
          Start using DROIDEX <ArrowRight className="w-4 h-4" />
        </PrimaryButton>
      </div>
    </div>
  );
}
