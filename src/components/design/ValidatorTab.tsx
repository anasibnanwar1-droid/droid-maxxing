import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Play, Plus, Wand2, X } from 'lucide-react';
import { useDesignStore } from '../../hooks/useDesignStore';
import { fixValidatorFindings, runValidator, writeValidatorConfig } from '../../lib/commands';
import type { ValidatorConfig, ValidatorFinding, ValidatorPage } from '../../types/bridge';

type Viewport = ValidatorConfig['viewports'][number];

const ALL_VIEWPORTS: Viewport[] = ['desktop', 'laptop', 'tablet', 'mobile'];
const MAX_PAGES = 20;

const inputClass =
  'h-8 min-w-0 rounded-md border border-droid-border bg-droid-bg/60 px-2.5 text-[12.5px] text-droid-text placeholder:text-droid-text-muted/50 outline-none focus:border-droid-accent';

export default function ValidatorTab({
  cwd,
  missionId,
}: {
  cwd: string;
  missionId: string | null;
}) {
  const { design } = useDesignStore();
  const storedConfig = design.validatorConfigs[cwd];
  const runStatus = design.validatorRuns[cwd];
  const report = design.reports[cwd];

  const [pages, setPages] = useState<ValidatorPage[]>([]);
  const [viewports, setViewports] = useState<Viewport[]>(['desktop', 'mobile']);
  const [runAfterPrompt, setRunAfterPrompt] = useState(false);
  const [seededFor, setSeededFor] = useState<string | null>(null);

  // Seed the editor once per cwd when the stored config arrives; later edits
  // stay local until saved.
  useEffect(() => {
    if (!storedConfig || seededFor === cwd) return;
    setPages(storedConfig.pages);
    setViewports(storedConfig.viewports);
    setRunAfterPrompt(storedConfig.runAfterDesignPrompt ?? false);
    setSeededFor(cwd);
  }, [storedConfig, cwd, seededFor]);

  const dirty = useMemo(() => {
    if (!storedConfig) return pages.length > 0;
    return (
      JSON.stringify({
        p: storedConfig.pages,
        v: storedConfig.viewports,
        r: storedConfig.runAfterDesignPrompt ?? false,
      }) !== JSON.stringify({ p: pages, v: viewports, r: runAfterPrompt })
    );
  }, [storedConfig, pages, viewports, runAfterPrompt]);

  const hasEmptyUrl = pages.some((p) => !p.url.trim());
  const running = runStatus?.status === 'running';

  const findingsByPage = useMemo(() => {
    const map = new Map<string, ValidatorFinding[]>();
    for (const f of report?.findings ?? []) {
      const list = map.get(f.pageId) ?? [];
      list.push(f);
      map.set(f.pageId, list);
    }
    return map;
  }, [report]);

  const errorCount = report?.findings.filter((f) => f.severity === 'error').length ?? 0;
  const warningCount = report?.findings.filter((f) => f.severity === 'warning').length ?? 0;

  const pageLabel = (pageId: string) => {
    const page = (storedConfig?.pages ?? pages).find((p) => p.id === pageId);
    return page?.label || page?.url || pageId;
  };

  const save = () => {
    writeValidatorConfig(cwd, {
      ...(storedConfig ?? {}),
      pages: pages.map((p) => ({ ...p, url: p.url.trim(), label: p.label?.trim() || undefined })),
      viewports,
      runAfterDesignPrompt: runAfterPrompt,
    });
  };

  return (
    <div className="max-w-3xl space-y-5">
      <header>
        <h2 className="text-[15px] font-semibold text-droid-text">Design Validator</h2>
        <p className="mt-1 text-[12px] text-droid-text-muted">
          Audits live pages against the project's design tokens: palette colors, type scale, radii,
          spacing, and fonts.
        </p>
      </header>

      <section className="rounded-xl border border-droid-border bg-droid-surface p-4 space-y-4">
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[12.5px] font-medium text-droid-text">Pages</span>
            <button
              onClick={() =>
                pages.length < MAX_PAGES &&
                setPages((prev) => [
                  ...prev,
                  { id: `p-${Date.now().toString(36)}-${prev.length}`, url: '', label: '' },
                ])
              }
              disabled={pages.length >= MAX_PAGES}
              className="flex items-center gap-1 text-[12px] text-droid-text-muted hover:text-droid-text transition-colors disabled:opacity-40"
            >
              <Plus className="w-3.5 h-3.5" />
              Add page
            </button>
          </div>
          {pages.length === 0 ? (
            <div className="rounded-lg border border-dashed border-droid-border px-3 py-4 text-center text-[12px] text-droid-text-muted">
              No pages configured yet. Add the URLs the validator should audit.
            </div>
          ) : (
            <div className="space-y-1.5">
              {pages.map((page, i) => (
                <div key={page.id} className="flex items-center gap-2">
                  <input
                    value={page.url}
                    onChange={(e) =>
                      setPages((prev) =>
                        prev.map((p, j) => (j === i ? { ...p, url: e.target.value } : p)),
                      )
                    }
                    placeholder="http://localhost:5173/"
                    className={`${inputClass} flex-1`}
                  />
                  <input
                    value={page.label ?? ''}
                    onChange={(e) =>
                      setPages((prev) =>
                        prev.map((p, j) => (j === i ? { ...p, label: e.target.value } : p)),
                      )
                    }
                    placeholder="Label"
                    className={`${inputClass} w-36`}
                  />
                  <button
                    onClick={() => setPages((prev) => prev.filter((_, j) => j !== i))}
                    className="p-1.5 rounded-md text-droid-text-muted hover:text-droid-text hover:bg-droid-elevated/60 transition-colors"
                    title="Remove page"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="mb-2 text-[12.5px] font-medium text-droid-text">Viewports</div>
          <div className="flex flex-wrap gap-1.5">
            {ALL_VIEWPORTS.map((vp) => {
              const active = viewports.includes(vp);
              return (
                <button
                  key={vp}
                  onClick={() =>
                    setViewports((prev) => {
                      if (prev.includes(vp)) {
                        return prev.length === 1 ? prev : prev.filter((v) => v !== vp);
                      }
                      return ALL_VIEWPORTS.filter((v) => prev.includes(v) || v === vp);
                    })
                  }
                  className={`px-3 py-1 rounded-full border text-[12px] capitalize transition-colors ${
                    active
                      ? 'border-droid-accent/50 bg-droid-accent/15 text-droid-accent'
                      : 'border-droid-border text-droid-text-muted hover:text-droid-text'
                  }`}
                >
                  {vp}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center justify-between">
          <label className="flex items-center gap-2.5 cursor-pointer">
            <button
              onClick={() => setRunAfterPrompt((v) => !v)}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                runAfterPrompt ? 'bg-droid-accent' : 'bg-droid-border'
              }`}
              role="switch"
              aria-checked={runAfterPrompt}
            >
              <span
                className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                  runAfterPrompt ? 'translate-x-[18px]' : 'translate-x-[3px]'
                }`}
              />
            </button>
            <span className="text-[12.5px] text-droid-text">Run after design prompts</span>
          </label>
          <button
            onClick={save}
            disabled={!dirty || hasEmptyUrl}
            className="h-8 px-3.5 rounded-md bg-droid-accent text-white text-[12.5px] font-medium hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Save config
          </button>
        </div>
      </section>

      <section className="rounded-xl border border-droid-border bg-droid-surface p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[12.5px] font-medium text-droid-text">Run</div>
            <div className="mt-0.5 text-[11px] text-droid-text-muted">
              {missionId
                ? 'Drives the active session\u2019s browser through each page and viewport.'
                : 'Open a session to run the validator.'}
            </div>
          </div>
          <button
            onClick={() => missionId && runValidator(cwd, missionId)}
            disabled={!missionId || running || pages.length === 0}
            className="flex items-center gap-1.5 h-8 px-3.5 rounded-md bg-droid-accent text-white text-[12.5px] font-medium hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
          >
            <Play className="w-3.5 h-3.5" />
            {running ? 'Running\u2026' : 'Run validator'}
          </button>
        </div>

        {running && typeof runStatus?.total === 'number' && (
          <div className="mt-3">
            <div className="mb-1 flex justify-between text-[11px] text-droid-text-muted">
              <span className="truncate">
                {runStatus.pageId
                  ? `${pageLabel(runStatus.pageId)} \u00b7 ${runStatus.viewport ?? ''}`
                  : 'Auditing\u2026'}
              </span>
              <span>
                {runStatus.completed ?? 0} / {runStatus.total}
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-droid-elevated">
              <motion.div
                className="h-full rounded-full bg-droid-accent"
                animate={{
                  width: `${Math.min(100, ((runStatus.completed ?? 0) / Math.max(1, runStatus.total)) * 100)}%`,
                }}
                transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              />
            </div>
          </div>
        )}

        {runStatus?.status === 'failed' && runStatus.error && (
          <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-400">
            {runStatus.error}
          </div>
        )}
      </section>

      <AnimatePresence initial={false}>
        {report && (
          <motion.section
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="rounded-xl border border-droid-border bg-droid-surface p-4"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <span className="rounded-md bg-droid-elevated px-2 py-1 text-droid-text">
                  {report.pagesAudited} page{report.pagesAudited === 1 ? '' : 's'}
                </span>
                <span className="rounded-md bg-droid-elevated px-2 py-1 text-droid-text">
                  {report.elementsAudited} elements
                </span>
                {errorCount > 0 && (
                  <span className="rounded-md bg-red-500/10 px-2 py-1 text-red-400">
                    {errorCount} error{errorCount === 1 ? '' : 's'}
                  </span>
                )}
                {warningCount > 0 && (
                  <span className="rounded-md bg-amber-500/10 px-2 py-1 text-amber-400">
                    {warningCount} warning{warningCount === 1 ? '' : 's'}
                  </span>
                )}
              </div>
              {report.findings.length > 0 && missionId && (
                <button
                  onClick={() => fixValidatorFindings(cwd, missionId)}
                  className="flex items-center gap-1.5 h-8 px-3 rounded-md border border-droid-accent/40 bg-droid-accent/15 text-droid-accent text-[12.5px] font-medium hover:bg-droid-accent/25 transition-colors shrink-0"
                >
                  <Wand2 className="w-3.5 h-3.5" />
                  Fix with agent
                </button>
              )}
            </div>

            {report.findings.length === 0 ? (
              <div className="mt-3 rounded-lg border border-dashed border-droid-border px-3 py-5 text-center text-[12px] text-droid-text-muted">
                No findings. The page matches the design DNA.
              </div>
            ) : (
              <div className="mt-3 space-y-4">
                {[...findingsByPage.entries()].map(([pageId, findings]) => (
                  <div key={pageId}>
                    <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-droid-text-muted/70 truncate">
                      {pageLabel(pageId)}
                    </div>
                    <div className="space-y-1.5">
                      {findings.map((f) => (
                        <div
                          key={f.id}
                          className="flex items-start gap-2.5 rounded-lg border border-droid-border bg-droid-bg/60 px-3 py-2"
                        >
                          <span
                            className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                              f.severity === 'error' ? 'bg-red-400' : 'bg-amber-400'
                            }`}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-[11px] text-droid-text">
                                {f.rule}
                              </span>
                              <span className="text-[10.5px] text-droid-text-muted">
                                {f.viewport}
                              </span>
                            </div>
                            <div className="mt-0.5 text-[11px] text-droid-text-muted truncate">
                              {f.label} <span className="font-mono">{f.selector}</span>
                            </div>
                            <div className="mt-0.5 font-mono text-[11px]">
                              <span className="text-droid-text-muted">{f.property}: </span>
                              <span className="text-red-400">{f.actual}</span>
                              <span className="text-droid-text-muted"> {'\u2192'} </span>
                              <span className="text-droid-text">{f.expected}</span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </motion.section>
        )}
      </AnimatePresence>
    </div>
  );
}
