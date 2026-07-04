import { INTERVIEW_QUESTIONS, type InterviewQuestion } from './interviewQuestions';

export interface Answer {
  selected: string[];
  text: string;
  images: string[];
}

export type DesignBrief = Record<string, Answer>;

export const emptyAnswer = (): Answer => ({ selected: [], text: '', images: [] });

export function answered(a: Answer | undefined): boolean {
  return !!a && (a.selected.length > 0 || a.text.trim().length > 0 || a.images.length > 0);
}

export function briefImageCount(brief: DesignBrief): number {
  return Object.values(brief).reduce((n, a) => n + a.images.length, 0);
}

/** All reference images across the brief, for sending as multimodal context. */
export function briefImages(brief: DesignBrief): string[] {
  return Object.values(brief).flatMap((a) => a.images);
}

function line(q: InterviewQuestion, a: Answer | undefined): string | undefined {
  if (!answered(a)) return undefined;
  const parts: string[] = [];
  if (a!.selected.length) parts.push(a!.selected.join(', '));
  if (a!.text.trim()) parts.push(a!.text.trim());
  if (a!.images.length) parts.push(`(${a!.images.length} reference image${a!.images.length === 1 ? '' : 's'} attached)`);
  return `- ${q.title} ${parts.join(' — ')}`;
}

function briefLines(brief: DesignBrief): string {
  return INTERVIEW_QUESTIONS.map((q) => line(q, brief[q.id]))
    .filter(Boolean)
    .join('\n');
}

function sectionMd(title: string, ids: string[], brief: DesignBrief): string {
  const lines = ids
    .map((id) => {
      const q = INTERVIEW_QUESTIONS.find((x) => x.id === id);
      return q ? line(q, brief[id]) : undefined;
    })
    .filter(Boolean);
  if (lines.length === 0) return '';
  return [`## ${title}`, '', ...lines, ''].join('\n');
}

/** The DESIGN.md seed written right after the interview — the user's intent as
 *  structured guidance every agent reads (via design_dna) before designing or
 *  building, so taste, direction, and hard limits are honored. The agent elevates
 *  this into the full token/motion/brand system. */
export function toBriefMarkdown(brief: DesignBrief): string {
  const sections = [
    sectionMd('Product', ['product', 'audience'], brief),
    sectionMd('Taste & voice', ['mood', 'voice'], brief),
    sectionMd('Visual direction', ['color', 'typography', 'density'], brief),
    sectionMd('Motion', ['motion'], brief),
    sectionMd('References', ['references'], brief),
    sectionMd('Never do', ['avoid'], brief),
  ].filter(Boolean);
  return [
    '# Design DNA',
    '',
    "Living intent for this workspace, captured from a design intake. Read it to understand the",
    "user's taste and direction — treat it as guidance, not a rigid lock, and keep it updated as",
    'their instructions evolve, so future turns and production builds stay true to what they want.',
    '',
    ...(sections.length > 0 ? sections : ['## Brief', '', '- (interview skipped)', '']),
    '## Themes',
    '',
    '- Light and dark are a user preference. Define tokens for both; never hardcode one.',
    '',
  ].join('\n');
}

/** The instruction handed to the agent to author the system end-to-end. Encodes
 *  fundamentals and current trends as knowledge the agent applies — never a
 *  single forced aesthetic. */
export function toAuthoringPrompt(brief: DesignBrief): string {
  return [
    'You are a senior brand and product designer. From the intake brief below, author this',
    "project's design system end to end. Reflect the user's taste — do not impose one default look.",
    '',
    'Intake brief:',
    briefLines(brief) || '- (no answers; ask the user 3-4 sharp questions first)',
    '',
    'Deliverables (write real files in the repo):',
    '1. DESIGN.md — a fenced `design-tokens` JSON block (colors as named roles, type scale, spacing,',
    '   radii, shadows) plus prose rationale. Define tokens for BOTH light and dark themes; light/dark',
    '   is a user preference, never hardcoded.',
    '2. MOTION.md — easing curves, a duration scale, hover/press/enter behavior, and a reduced-motion policy.',
    '3. A brand-guidelines document — a real, responsive brand book (like a designed site, not a plain',
    '   readme): Brand Strategy, Personality, Logo usage & placement, Color, Typography, Art Direction.',
    '   Show real examples (spacing specimens, a type scale, swatches) and explain WHY each choice was',
    '   made. It must render well on desktop, tablet, and mobile.',
    '',
    'Ground every choice in fundamentals:',
    '- Hierarchy first: size, weight, and space carry importance — not decoration.',
    '- Spatial rhythm on a consistent base (e.g. 4/8px); a modular type scale with a deliberate pairing.',
    '- Accessible contrast (WCAG AA+) in both themes; motion easing matched to tone (smooth for luxury,',
    '  snappy for playful); honor prefers-reduced-motion.',
    '- Restraint even in bold or dense directions — expressive, never overwhelming.',
    '',
    'Never ship AI slop: no purple-on-white gradients, no Inter/Roboto/Arial defaults, no generic cards,',
    'sparkles, emoji icons, or glassmorphism. Use real content and ASCII punctuation. Make it feel',
    "designed and specific to this product, and explain the reasoning so it reads like a real team's work.",
  ].join('\n');
}
