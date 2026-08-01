import type { MotionDuration, MotionTokens } from './types.js';

export function renderMotionSamples(tokens: MotionTokens | undefined): string {
  if (!tokens) {
    return `<div class="motion-unavailable">
      <strong>Motion is documented, but not executable yet.</strong>
      <span>Add a fenced <code>motion-tokens</code> block to MOTION.md to play the real timings here.</span>
    </div>`;
  }

  const duration = durationMs(preferredValue(tokens.durations, ['element', 'micro']));
  const easing = preferredValue(tokens.easings, ['standard']) ?? 'linear';
  const rows = [
    ...Object.entries(tokens.durations).map(
      ([name, value]) =>
        `<li><span>${esc(name)}</span><code>${esc(formatDuration(value))}</code></li>`,
    ),
    ...Object.entries(tokens.easings).map(
      ([name, value]) => `<li><span>${esc(name)}</span><code>${esc(value)}</code></li>`,
    ),
  ].join('');
  const samples = [
    ...Object.entries(tokens.durations).map(([name, value]) => {
      const sampleDuration = durationMs(value);
      return `<button type="button" class="motion-demo-card" data-motion-token="duration:${esc(name)}" style="--demo-duration:${String(sampleDuration)}ms;--demo-ease:${esc(easing)}"><span>Duration · ${esc(name)}</span><small>${esc(formatDuration(value))} · ${esc(easing)}</small></button>`;
    }),
    ...Object.entries(tokens.easings).map(
      ([name, value]) =>
        `<button type="button" class="motion-demo-card" data-motion-token="easing:${esc(name)}" style="--demo-duration:${String(duration)}ms;--demo-ease:${esc(value)}"><span>Easing · ${esc(name)}</span><small>${String(duration)}ms · ${esc(value)}</small></button>`,
    ),
  ].join('');

  return `<div class="motion-contract"><ul>${rows}</ul>
    <div class="motion-stage motion-${esc(tokens.reducedMotion)}" style="--demo-duration:${String(duration)}ms;--demo-ease:${esc(easing)};--press-scale:${String(tokens.pressScale ?? 1)}">
      ${samples}
      <button type="button" class="motion-demo-press">Press me</button>
    </div>
    <p class="motion-policy">Reduced motion: <strong>${esc(tokens.reducedMotion)}</strong></p>
  </div>`;
}

export function brandBookMotionCss(radius: number): string {
  return `
  .motion-unavailable{display:flex;flex-direction:column;gap:4px;padding:18px;border:1px solid var(--border);border-radius:${String(radius)}px;color:var(--muted)}
  .motion-unavailable strong{color:var(--text)}
  .motion-contract{display:grid;grid-template-columns:minmax(220px,1fr) minmax(260px,1.4fr);gap:24px;align-items:start}
  .motion-contract ul{list-style:none;border-top:1px solid var(--border)}
  .motion-contract li{display:flex;justify-content:space-between;gap:16px;padding:10px 0;border-bottom:1px solid var(--border);text-transform:capitalize}
  .motion-contract code{font-family:var(--font-mono);font-size:11px;color:var(--muted);text-transform:none}
  .motion-stage{min-height:210px;padding:24px;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:18px;background:color-mix(in srgb,var(--brand) 7%,var(--surface));border:1px solid var(--border);border-radius:${String(radius)}px}
  .motion-demo-card{appearance:none;width:100%;padding:22px;border:1px solid var(--border);border-radius:${String(radius)}px;background:var(--surface);color:var(--text);font:inherit;text-align:left;transition:transform var(--demo-duration) var(--demo-ease),box-shadow var(--demo-duration) var(--demo-ease),opacity var(--demo-duration) var(--demo-ease)}
  .motion-demo-card span,.motion-demo-card small{display:block}.motion-demo-card small{margin-top:4px;color:var(--muted)}
  .motion-demo-card:hover{transform:translateY(-6px);box-shadow:0 18px 40px color-mix(in srgb,var(--text) 14%,transparent)}
  .motion-demo-press{appearance:none;padding:10px 16px;border:0;border-radius:${String(radius)}px;background:var(--brand);color:var(--surface);font:600 13px var(--font-sans);transition:transform var(--demo-duration) var(--demo-ease),opacity var(--demo-duration) var(--demo-ease)}
  .motion-demo-press:active{transform:scale(var(--press-scale))}
  .motion-policy{grid-column:1/-1;font-size:12px;color:var(--muted)}
  @media (max-width:720px){.motion-contract{grid-template-columns:1fr}}
  @media (prefers-reduced-motion:reduce){
    .motion-disable>*{transition-duration:0ms!important}.motion-disable .motion-demo-card:hover,.motion-disable .motion-demo-press:active{transform:none;box-shadow:none}
    .motion-reduce .motion-demo-card:hover,.motion-reduce .motion-demo-press:active{transform:none;box-shadow:none;opacity:.72}
  }
  `;
}

function durationMs(value: MotionDuration | undefined): number {
  if (value === undefined) return 0;
  return Array.isArray(value) ? Math.round((value[0] + value[1]) / 2) : value;
}

function preferredValue<T>(values: Record<string, T>, names: string[]): T | undefined {
  for (const name of names) {
    const match = Object.entries(values).find(([key]) => key === name);
    if (match) return match[1];
  }
  return Object.values(values)[0];
}

function formatDuration(value: MotionDuration): string {
  return Array.isArray(value) ? `${String(value[0])}–${String(value[1])}ms` : `${String(value)}ms`;
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
