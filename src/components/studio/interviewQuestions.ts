/**
 * The design intake — the questions a design team actually asks to learn your
 * taste. Each is answerable by picking options, writing freely, or (where noted)
 * pasting reference images. Content lives here as data so the flow stays tiny.
 *
 * Light vs dark is a USER PREFERENCE, not a direction — so we never ask "dark or
 * light"; the system defines tokens for both. Questions encode fundamentals
 * (hierarchy, rhythm, contrast, restraint) without forcing one aesthetic.
 */

interface InterviewOption {
  value: string;
  label: string;
}

export interface InterviewQuestion {
  id: string;
  title: string;
  subtitle?: string;
  multi?: boolean;
  options: InterviewOption[];
  allowText: boolean;
  allowImages?: boolean;
  placeholder?: string;
}

const opt = (label: string): InterviewOption => ({ value: label, label });

export const INTERVIEW_QUESTIONS: InterviewQuestion[] = [
  {
    id: 'product',
    title: 'What are you designing?',
    subtitle: 'The kind of product shapes everything downstream.',
    options: [
      opt('SaaS dashboard'),
      opt('Marketing site'),
      opt('Mobile app'),
      opt('Developer tool'),
      opt('E-commerce'),
      opt('Portfolio'),
      opt('Docs / content'),
    ],
    allowText: true,
    placeholder: 'or describe the product in your own words…',
  },
  {
    id: 'audience',
    title: 'Who is it for?',
    subtitle: 'Design decisions serve a specific person.',
    options: [
      opt('Developers'),
      opt('Consumers'),
      opt('Enterprise buyers'),
      opt('Creatives / designers'),
      opt('Operators / power users'),
      opt('General public'),
    ],
    allowText: true,
    placeholder: 'or describe your audience…',
  },
  {
    id: 'mood',
    title: 'How should it feel?',
    subtitle: 'Pick the adjectives that fit — a few is fine.',
    multi: true,
    options: [
      opt('Minimal & calm'),
      opt('Editorial'),
      opt('Bold & expressive'),
      opt('Playful'),
      opt('Technical & precise'),
      opt('Warm & human'),
      opt('Luxurious'),
      opt('Brutalist / raw'),
      opt('Retro-futuristic'),
      opt('Maximalist'),
    ],
    allowText: true,
    placeholder: 'or name the feeling yourself…',
  },
  {
    id: 'references',
    title: 'Anything you love the look of?',
    subtitle: 'Paste screenshots, a moodboard, or links. The more the better.',
    options: [],
    allowText: true,
    allowImages: true,
    placeholder: 'Paste images, links, or describe references and why they work for you…',
  },
  {
    id: 'color',
    title: 'Color direction',
    subtitle: 'Palette character — light and dark are a user preference, so both get tokens.',
    options: [
      opt('Mono + one accent'),
      opt('Two-tone'),
      opt('Vibrant & high-energy'),
      opt('Muted & earthy'),
      opt('High-contrast'),
      opt('Soft & pastel'),
    ],
    allowText: true,
    placeholder: 'any colors you love or must avoid…',
  },
  {
    id: 'typography',
    title: 'Typography feel',
    subtitle: 'Type carries most of the voice.',
    multi: true,
    options: [
      opt('Geometric sans'),
      opt('Humanist sans'),
      opt('Editorial serif'),
      opt('Mono / technical'),
      opt('Expressive display'),
    ],
    allowText: true,
    placeholder: 'any typefaces you have in mind…',
  },
  {
    id: 'density',
    title: 'Information density',
    subtitle: 'How much breathing room the interface wants.',
    options: [opt('Airy & spacious'), opt('Balanced'), opt('Dense & data-rich')],
    allowText: false,
  },
  {
    id: 'motion',
    title: 'Motion personality',
    subtitle: 'Match the movement to the tone.',
    options: [
      opt('Quiet & subtle'),
      opt('Smooth & luxurious'),
      opt('Snappy & playful'),
      opt('Minimal / reduced'),
    ],
    allowText: true,
    placeholder: 'how motion should feel…',
  },
  {
    id: 'voice',
    title: 'Brand voice',
    subtitle: 'Personality in a few words.',
    multi: true,
    options: [
      opt('Confident'),
      opt('Friendly'),
      opt('Precise'),
      opt('Rebellious'),
      opt('Trustworthy'),
      opt('Witty'),
      opt('Understated'),
    ],
    allowText: true,
    placeholder: 'or describe the voice…',
  },
  {
    id: 'avoid',
    title: 'Anything it must never do?',
    subtitle: 'Your hard no-gos. This is how we keep it from feeling generic.',
    options: [],
    allowText: true,
    placeholder: 'e.g. no purple gradients, no stock-photo look, no emoji, no clutter…',
  },
];
