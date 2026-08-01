import { INTERVIEW_QUESTIONS, type InterviewQuestion } from './interviewQuestions';
import type { BrowserTranscriptReference } from '../../types/bridge';

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

export interface BriefImageReference {
  id: string;
  name: string;
  dataUrl: string;
  transcript: BrowserTranscriptReference;
}

export function briefImageReferences(
  brief: DesignBrief,
  createId: () => string,
): BriefImageReference[] {
  return briefImages(brief).map((dataUrl, index) => {
    const id = `canvas-intake-${createId()}`;
    const name = `Intake reference ${String(index + 1)}`;
    return {
      id,
      name,
      dataUrl,
      transcript: {
        id,
        label: name,
        kind: 'region',
        url: `droidex://canvas/${id}`,
        imageDataUrl: dataUrl,
      },
    };
  });
}

function line(q: InterviewQuestion, a: Answer | undefined): string | undefined {
  if (!a || !answered(a)) return undefined;
  const parts: string[] = [];
  if (a.selected.length) parts.push(a.selected.join(', '));
  if (a.text.trim()) parts.push(a.text.trim());
  if (a.images.length) {
    parts.push(
      `(${String(a.images.length)} reference image${a.images.length === 1 ? '' : 's'} attached)`,
    );
  }
  return `- ${q.title} ${parts.join(' — ')}`;
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
    'Living intent for this workspace, captured from a design intake. Read it to understand the',
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

/** The visible kickoff goal for the authoring session. The user's intake (the
 *  gathered brief) is READ from DESIGN.md, never embedded here — so the CLI shows
 *  the task, not a forced brief. Fundamentals are stated as knowledge to apply,
 *  not a single forced aesthetic. */
export function authoringInstruction(directions = 3, referenceIds: readonly string[] = []): string {
  const n = Math.max(1, Math.min(4, directions));
  const many = n > 1;
  return [
    "Author this project's design system. The user's intake is captured in DESIGN.md —",
    'read it first (design_dna tool) to understand their taste and direction, and read design_guidelines.',
    ...(referenceIds.length > 0
      ? [
          `The user supplied visual references saved as ${referenceIds.join(', ')}. Call design_reference_library`,
          'with these ids before proposing directions so you inspect the actual images at model-safe quality.',
        ]
      : []),
    '',
    ...(many
      ? [
          `First, explore ${String(n)} genuinely distinct visual directions that each honor the intake — different`,
          'type pairings, palettes, and personalities, not one idea at three intensities. For EACH direction',
          'write a self-contained one-page HTML specimen (inline CSS/JS): name it, show its palette, type',
          'scale, sample components (button, card, input in default/hover states), and a motion sample that',
          'actually runs. Preview every specimen on the canvas with design_preview, named "Direction N — <name>",',
          'so the user compares them side by side. Then ask the user which direction to make the DNA (or what',
          'to blend) and WAIT for their pick.',
          '',
          'Once picked, build out that direction for real:',
        ]
      : ['Then write real files in the repo:']),
    '1. DESIGN.md — a fenced `design-tokens` JSON block (color roles, type scale, spacing, radii, shadows)',
    '   with tokens for BOTH light and dark (theme is a user preference), plus prose rationale.',
    '2. MOTION.md — easing curves, a duration scale, hover/press/enter behavior, and a reduced-motion policy.',
    '3. A responsive brand-guidelines page — a real brand book (not a plain readme): Brand Strategy,',
    '   Personality, Logo usage, Color, Typography, Art Direction, with real examples (spacing specimens,',
    '   a type scale, swatches) and the reasoning behind each choice; it must work on desktop, tablet, mobile.',
    '',
    'Ground it in fundamentals: hierarchy via size/weight/space; a consistent spatial base (4/8px) and a',
    'modular type scale with a deliberate pairing; accessible contrast (WCAG AA+) in both themes; motion',
    "easing matched to tone; restraint even in bold directions. Reflect the user's taste, and make every",
    'font/color/effect choice for a stated reason rather than as a generator default. Use real content and',
    'explain the reasoning like a real design team.',
  ].join('\n');
}
