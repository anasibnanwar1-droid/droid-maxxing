import { basename } from 'node:path';
import type { DesignTokens } from './types.js';
import { compositeColor, parseColor, type Rgba } from './tokens.js';
import { brandBookMotionCss, renderMotionSamples } from './brandBookMotion.js';
import { parseMotionTokens } from './motionTokens.js';

export interface BrandBookInput {
  cwd: string;
  tokens: DesignTokens;
  designMd: string;
  motionMd: string;
}

/**
 * Deterministically renders a professional, responsive brand-guidelines page
 * from a project's Design DNA — themed IN the brand's own tokens and fonts, with
 * real contrast math, type specimens, swatch cards, and the project's own prose.
 * A designed brand book, not a form. Same tokens in → same page out.
 */
export function renderBrandBook(input: BrandBookInput): string {
  const { tokens } = input;
  const theme = resolveTheme(tokens);
  const brandName = deriveBrandName(input);
  const tagline = deriveTagline(input.designMd) || 'Design system & brand guidelines';
  const prose = parseProse(input.designMd);
  const scale = (tokens.typeScale.length ? tokens.typeScale : [13, 15, 18, 22, 30, 44, 68])
    .slice()
    .sort((a, b) => a - b);
  const spacing = (tokens.spacing.length ? tokens.spacing : [4, 8, 12, 16, 24, 32, 48, 64, 96])
    .slice()
    .sort((a, b) => a - b);
  const radii = tokens.radii.length
    ? tokens.radii.slice().sort((a, b) => a - b)
    : [0, 4, 8, 14, 999];
  const swatches = Object.entries(tokens.colors);
  const motionTokens = parseMotionTokens(input.motionMd);

  const proseSections = prose.map((p, i) => proseSection(p, i + 1));
  const contents = [
    ...prose.map((p, i) => ({ n: pad(i + 1), label: p.title })),
    { n: pad(prose.length + 1), label: 'Color' },
    { n: pad(prose.length + 2), label: 'Typography' },
    { n: pad(prose.length + 3), label: 'Spacing & grid' },
    { n: pad(prose.length + 4), label: 'Motion' },
  ];

  const body = [
    cover(brandName, tagline, theme),
    contentsSection(contents),
    ...proseSections,
    colorSection(swatches, theme, pad(prose.length + 1)),
    typographySection(scale, tokens.fonts, theme, pad(prose.length + 2)),
    spacingSection(spacing, radii, theme, pad(prose.length + 3)),
    motionSection(input.motionMd, motionTokens, pad(prose.length + 4)),
    colophon(brandName),
  ].join('\n');

  return page(brandName, css(theme, tokens.fonts, scale, radii), body);
}

// ── Theme ────────────────────────────────────────────────────────────

interface Theme {
  surface: string;
  text: string;
  muted: string;
  border: string;
  brand: string;
}

function resolveTheme(tokens: DesignTokens): Theme {
  const c = tokens.colors;
  const match = (keys: string[]): string | undefined => {
    const entry = Object.entries(c).find(([name]) =>
      keys.some((k) => name.toLowerCase().includes(k)),
    );
    return entry?.[1];
  };
  // Every value is passed through safeColor before it reaches CSS, so a malformed
  // or hostile token (e.g. `red" onload=...`) can't break out of a style attribute.
  const surface = safeColor(
    match(['surface', 'background', 'bg', 'base', 'paper', 'canvas']),
    '#ffffff',
  );
  const surfaceRgb = parseColor(surface) ?? [255, 255, 255, 1];
  const text = safeColor(
    match(['text', 'ink', 'foreground', 'body']),
    luminance(surfaceRgb) > 0.5 ? '#111111' : '#f5f5f5',
  );
  const brand = safeColor(match(['brand', 'primary', 'accent']) ?? Object.values(c)[0], text);
  const border = safeColor(match(['border', 'line', 'rule', 'divider']), mix(text, surface, 0.14));
  const muted = safeColor(
    match(['muted', 'secondary', 'subtle', 'tertiary']),
    mix(text, surface, 0.55),
  );
  return { surface, text, muted, border, brand };
}

// ── Sections ─────────────────────────────────────────────────────────

function cover(name: string, tagline: string, theme: Theme): string {
  return section(
    'cover',
    `
    <div class="cover">
      <div class="cover-mark">${esc(name)}</div>
      <p class="cover-tagline">${esc(tagline)}</p>
      <div class="cover-meta"><span>Brand guidelines</span><span class="mono" style="color:${theme.brand}">v1</span></div>
    </div>`,
  );
}

function contentsSection(items: { n: string; label: string }[]): string {
  const rows = items
    .map((i) => `<li><span class="mono num">${i.n}</span><span>${esc(i.label)}</span></li>`)
    .join('');
  return section(
    'contents',
    `<div class="rail"><span class="kicker">Contents</span></div><ol class="contents body">${rows}</ol>`,
  );
}

function proseSection(p: ProseBlock, n: number): string {
  return numbered(pad(n), p.title, `<div class="prose body">${renderMarkdownish(p.content)}</div>`);
}

function colorSection(swatches: [string, string][], theme: Theme, n: string): string {
  const whiteSurface: Rgba = [255, 255, 255, 1];
  const surface = compositeColor(parseColor(theme.surface) ?? whiteSurface, whiteSurface);
  const cards = swatches
    .map(([role, rawValue]) => {
      const value = safeColor(rawValue, 'transparent');
      const parsed = parseColor(value);
      const rgb = parsed ? compositeColor(parsed, surface) : undefined;
      const ink = rgb ? readableInk(rgb) : '#000';
      const white = rgb ? contrastRatio(rgb, [255, 255, 255, 1]) : 0;
      const black = rgb ? contrastRatio(rgb, [0, 0, 0, 1]) : 0;
      const best = white >= black ? { on: '#FFFFFF', r: white } : { on: '#000000', r: black };
      return `
      <div class="swatch">
        <div class="swatch-block" style="background:${value};color:${ink}"><span class="mono">${esc(value.toUpperCase())}</span></div>
        <div class="swatch-foot" style="background:${mix(value, theme.surface, 0.92)}">
          <div class="swatch-role">${esc(role)}</div>
          <div class="mono swatch-note">${wcag(best.r)} on ${best.on} · ${best.r.toFixed(1)}:1</div>
        </div>
      </div>`;
    })
    .join('');
  const application = `<div class="ui-sample">
    <div><span class="kicker">Token specimen</span><h3>Interface roles</h3><p>An illustrative composition using only this project's surface, text, border, muted, and action tokens.</p></div>
    <label>Input role<input value="Project token preview" readonly></label>
    <div class="ui-sample-actions"><button type="button">Primary action</button><a href="#color">Secondary action</a></div>
  </div>`;
  return numbered(n, 'Color', `<div class="swatches">${cards}</div>${application}`);
}

function typographySection(
  scale: number[],
  fonts: DesignTokens['fonts'],
  theme: Theme,
  n: string,
): string {
  const fontName = (stack: string | undefined) => esc(firstFamily(safeFont(stack, '')));
  const names = [
    fonts.display
      ? `<div><span class="kicker">Display</span><div class="font-name" style="font-family:var(--font-display)">${fontName(fonts.display)}</div></div>`
      : '',
    fonts.sans
      ? `<div><span class="kicker">Body</span><div class="font-name">${fontName(fonts.sans)}</div></div>`
      : '',
    fonts.mono
      ? `<div><span class="kicker">Mono</span><div class="font-name mono">${fontName(fonts.mono)}</div></div>`
      : '',
  ].join('');
  const ladder = scale
    .slice()
    .reverse()
    .map(
      (px) =>
        `<div class="ladder-row"><span class="ladder-aa" style="font-size:${String(px)}px">Aa</span><span class="mono ladder-meta">${String(px)}px</span></div>`,
    )
    .join('');
  return numbered(
    n,
    'Typography',
    `<div class="fonts">${names}</div>
     <div class="ladder">${ladder}</div>
     <div class="specimen"><p style="font-family:var(--font-display);font-size:clamp(28px,4vw,${String(scale[scale.length - 1])}px);line-height:1.05;margin:0 0 .4em">The quick brown fox.</p>
     <p class="body" style="color:${theme.muted}">Declared display and body stacks rendered across the project's type scale.</p></div>`,
  );
}

function spacingSection(spacing: number[], radii: number[], theme: Theme, n: string): string {
  const bars = spacing
    .map(
      (px) =>
        `<div class="bar-row"><span class="bar" style="width:${String(Math.min(100, px))}%;background:${theme.brand}"></span><span class="mono">${String(px)}px</span></div>`,
    )
    .join('');
  const radiiRow = radii
    .map((r) => {
      const radius = r > 100 ? 999 : r;
      const label = r > 100 ? 'pill' : `${String(r)}px`;
      return `<div class="radius"><span class="radius-box" style="border-radius:${String(radius)}px"></span><span class="mono">${label}</span></div>`;
    })
    .join('');
  return numbered(
    n,
    'Spacing & grid',
    `<div class="bars">${bars}</div><div class="radii">${radiiRow}</div>`,
  );
}

function motionSection(
  motionMd: string,
  motionTokens: ReturnType<typeof parseMotionTokens>,
  n: string,
): string {
  const motionProse = stripTitle(motionMd)
    .replace(/```motion-tokens\s*\n[\s\S]*?```/g, '')
    .trim();
  const prose = motionProse
    ? `<div class="prose body">${renderMarkdownish(motionProse)}</div>`
    : '';
  return numbered(n, 'Motion', `${prose}${renderMotionSamples(motionTokens)}`);
}

function colophon(name: string): string {
  return `<footer class="colophon"><span>${esc(name)}</span><span class="mono">generated from the design system</span></footer>`;
}

// ── Layout helpers ───────────────────────────────────────────────────

function section(cls: string, inner: string): string {
  return `<section class="section ${cls}">${inner}</section>`;
}
function numbered(n: string, title: string, inner: string): string {
  return `<section class="section split">
    <div class="rail"><span class="section-num">${n}</span><h2 class="section-title">${esc(title)}</h2></div>
    <div class="content">${inner}</div>
  </section>`;
}
function pad(n: number): string {
  return n < 10 ? `0${String(n)}` : String(n);
}

// ── Prose parsing (light markdown) ───────────────────────────────────

interface ProseBlock {
  title: string;
  content: string;
}

function parseProse(md: string): ProseBlock[] {
  const withoutTokens = md
    .replace(/```design-tokens[\s\S]*?```/g, '')
    .replace(/```[\s\S]*?```/g, '');
  const blocks: ProseBlock[] = [];
  const re = /^##\s+(.+)$/gm;
  const matches = [...withoutTokens.matchAll(re)];
  for (let i = 0; i < matches.length; i++) {
    const title = matches[i][1].trim();
    if (/^(tokens|themes|scanned sources)$/i.test(title)) continue;
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : withoutTokens.length;
    const content = withoutTokens.slice(start, end).trim();
    if (content) blocks.push({ title, content });
  }
  return blocks.slice(0, 6);
}

function stripTitle(md: string): string {
  return md
    .replace(/^#\s+.+$/m, '')
    .replace(/```[\s\S]*?```/g, '')
    .trim();
}

function renderMarkdownish(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let inList = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (inList) {
        out.push('</ul>');
        inList = false;
      }
      continue;
    }
    if (line.startsWith('- ')) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inline(line.slice(2))}</li>`);
    } else if (/^###?\s+/.test(line)) {
      if (inList) {
        out.push('</ul>');
        inList = false;
      }
      out.push(`<h3>${inline(line.replace(/^###?\s+/, ''))}</h3>`);
    } else {
      if (inList) {
        out.push('</ul>');
        inList = false;
      }
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  if (inList) out.push('</ul>');
  return out.join('');
}

function inline(text: string): string {
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code class="mono">$1</code>');
}

// ── Color math ───────────────────────────────────────────────────────

function luminance([r, g, b]: Rgba): number {
  const lin = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
function contrastRatio(a: Rgba, b: Rgba): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
function readableInk(bg: Rgba): string {
  return contrastRatio(bg, [255, 255, 255, 1]) >= contrastRatio(bg, [0, 0, 0, 1])
    ? '#ffffff'
    : '#000000';
}
function wcag(ratio: number): string {
  if (ratio >= 7) return 'AAA';
  if (ratio >= 4.5) return 'AA';
  if (ratio >= 3) return 'AA Large';
  return 'Fail';
}
function mix(a: string, b: string, weightB: number): string {
  return `color-mix(in srgb, ${a} ${String(Math.round((1 - weightB) * 100))}%, ${b})`;
}

// Only let syntactically-valid CSS colors reach a style attribute / custom
// property. Anything with quotes, semicolons, braces, or angle brackets — or an
// unrecognized shape — falls back, so a hostile token can't break out.
function safeColor(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const v = value.trim();
  if (v.length > 64 || /[;{}"'<>]/.test(v)) return fallback;
  if (parseColor(v)) return v;
  return fallback;
}

// Font stacks may contain quotes and commas but never CSS-breaking characters.
function safeFont(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const v = value.trim();
  if (!v || v.length > 200 || /[;{}<>]/.test(v)) return fallback;
  return v;
}

// ── Names ────────────────────────────────────────────────────────────

function deriveBrandName(input: BrandBookInput): string {
  const heading = /^#\s+(.+)$/m.exec(input.designMd)?.[1]?.trim();
  if (heading && !/design dna/i.test(heading)) return heading;
  return titleCase(basename(input.cwd) || 'Brand');
}
function deriveTagline(md: string): string {
  const noHeadings = md
    .replace(/```[\s\S]*?```/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('-') && !l.startsWith('##'));
  return noHeadings[0] ?? '';
}
function titleCase(s: string): string {
  return s
    .replace(/[-_]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
function firstFamily(stack: string): string {
  return (
    stack
      .split(',')[0]
      ?.trim()
      .replace(/^["']|["']$/g, '') || stack
  );
}
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Shell + CSS ──────────────────────────────────────────────────────

function page(title: string, style: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} — Brand Guidelines</title><style>${style}</style></head><body>${body}</body></html>`;
}

function css(theme: Theme, fonts: DesignTokens['fonts'], scale: number[], radii: number[]): string {
  const display = safeFont(fonts.display ?? fonts.sans, 'ui-sans-serif, system-ui, sans-serif');
  const sans = safeFont(fonts.sans, 'ui-sans-serif, system-ui, sans-serif');
  const mono = safeFont(fonts.mono, 'ui-monospace, SFMono-Regular, Menlo, monospace');
  const bodyPx = scale.find((s) => s >= 15 && s <= 18) ?? 16;
  const cardRadius = String(Math.min(12, radii[radii.length - 1] || 10));
  const sampleRadius = String(Math.min(16, radii[radii.length - 1] || 10));
  const controlRadius = String(Math.min(10, radii[radii.length - 1] || 8));
  return `
  :root{
    --surface:${theme.surface}; --text:${theme.text}; --muted:${theme.muted};
    --border:${theme.border}; --brand:${theme.brand};
    --font-display:${display}; --font-sans:${sans}; --font-mono:${mono};
  }
  *{box-sizing:border-box;margin:0;padding:0}
  html{-webkit-font-smoothing:antialiased}
  body{background:var(--surface);color:var(--text);font-family:var(--font-sans);font-size:${String(bodyPx)}px;line-height:1.6}
  .mono{font-family:var(--font-mono)}
  .body{max-width:65ch}
  .kicker{font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:var(--muted)}
  .section{padding:clamp(56px,11vh,150px) clamp(24px,6vw,120px);border-bottom:1px solid var(--border)}
  .split{display:grid;grid-template-columns:minmax(140px,3fr) 9fr;gap:clamp(24px,4vw,64px)}
  .rail{position:sticky;top:clamp(24px,6vh,80px);align-self:start}
  .section-num{font-family:var(--font-display);font-size:clamp(40px,7vw,110px);line-height:.9;color:var(--brand);opacity:.9;display:block}
  .section-title{font-family:var(--font-display);font-weight:600;font-size:clamp(20px,2.4vw,30px);margin-top:.4em}
  .cover{min-height:78vh;display:flex;flex-direction:column;justify-content:center}
  .cover-mark{font-family:var(--font-display);font-weight:700;font-size:clamp(48px,12vw,150px);line-height:.92;letter-spacing:-.02em}
  .cover-tagline{font-size:clamp(18px,2.4vw,30px);color:var(--muted);margin-top:.5em;max-width:24ch}
  .cover-meta{display:flex;justify-content:space-between;margin-top:clamp(40px,8vh,120px);padding-top:16px;border-top:1px solid var(--border);font-size:12px;color:var(--muted)}
  .contents{list-style:none;columns:2;column-gap:64px}
  .contents li{display:flex;gap:14px;padding:8px 0;border-bottom:1px solid var(--border);break-inside:avoid}
  .contents .num{color:var(--brand)}
  .prose h3{font-family:var(--font-display);font-size:1.15em;margin:1.2em 0 .3em}
  .prose p{margin:0 0 .8em;color:var(--text)}
  .prose ul{margin:.2em 0 1em 0;padding-left:1.1em}
  .prose li{margin:.25em 0}
  .swatches{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px}
  .swatch{border:1px solid var(--border);border-radius:${cardRadius}px;overflow:hidden}
  .swatch-block{height:132px;display:flex;align-items:flex-end;padding:12px;font-size:12px}
  .swatch-foot{padding:12px 14px}
  .swatch-role{font-weight:600;text-transform:capitalize}
  .swatch-note{font-size:11px;color:var(--muted);margin-top:2px}
  .ui-sample{margin-top:28px;padding:clamp(20px,4vw,40px);display:grid;grid-template-columns:1.2fr 1fr;gap:24px;background:var(--surface);border:1px solid var(--border);border-radius:${sampleRadius}px}
  .ui-sample h3{font:600 clamp(22px,3vw,34px)/1.1 var(--font-display);margin:8px 0}.ui-sample p{color:var(--muted)}
  .ui-sample label{display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--muted)}.ui-sample input{width:100%;padding:12px 14px;border:1px solid var(--border);border-radius:${controlRadius}px;background:var(--surface);color:var(--text);font:inherit}
  .ui-sample-actions{grid-column:1/-1;display:flex;align-items:center;gap:16px}.ui-sample button{padding:10px 16px;border:0;border-radius:${controlRadius}px;background:var(--brand);color:var(--surface);font:600 13px var(--font-sans)}.ui-sample a{color:var(--text);text-underline-offset:4px}
  .fonts{display:flex;flex-wrap:wrap;gap:32px;margin-bottom:36px}
  .font-name{font-size:26px;margin-top:6px}
  .ladder{border-top:1px solid var(--border)}
  .ladder-row{display:flex;align-items:baseline;justify-content:space-between;gap:24px;padding:14px 0;border-bottom:1px solid var(--border)}
  .ladder-aa{font-family:var(--font-display);line-height:1}
  .ladder-meta{font-size:12px;color:var(--muted)}
  .specimen{margin-top:36px}
  .bars{display:flex;flex-direction:column;gap:10px;max-width:640px}
  .bar-row{display:flex;align-items:center;gap:12px}
  .bar{height:14px;border-radius:3px;min-width:6px}
  .bar-row .mono{font-size:12px;color:var(--muted)}
  .radii{display:flex;flex-wrap:wrap;gap:20px;margin-top:36px}
  .radius{display:flex;flex-direction:column;align-items:center;gap:8px}
  .radius-box{width:56px;height:56px;background:var(--brand);opacity:.9}
  .radius .mono{font-size:11px;color:var(--muted)}
  ${brandBookMotionCss(Math.min(16, radii[radii.length - 1] || 12))}
  .colophon{display:flex;justify-content:space-between;padding:clamp(40px,8vh,90px) clamp(24px,6vw,120px);background:var(--text);color:var(--surface);font-size:13px}
  @media (max-width:900px){
    .split{grid-template-columns:1fr;gap:8px}
    .rail{position:static}
    .section-num{font-size:clamp(36px,10vw,64px)}
    .contents{columns:1}
    .ui-sample{grid-template-columns:1fr}
  }
  `;
}
