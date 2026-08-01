// Shared types for the design platform: DNA files, curated libraries, the
// style validator, the reference library, prototypes, and the component shelf.

export interface DesignTokens {
  colors: Record<string, string>;
  fonts: { sans?: string; mono?: string; display?: string };
  typeScale: number[];
  spacing: number[];
  radii: number[];
  shadows?: string[];
  allowlist?: TokenAllowRule[];
}

export type MotionDuration = number | [number, number];

export interface MotionTokens {
  durations: Record<string, MotionDuration>;
  easings: Record<string, string>;
  pressScale?: number;
  reducedMotion: 'disable' | 'reduce';
}

// Suppress findings for matching elements. Every provided field must match.
interface TokenAllowRule {
  selector?: string;
  property?: string;
  value?: string;
  note?: string;
}

export interface DnaFileState {
  path: string;
  exists: boolean;
  content: string;
}

export interface DnaState {
  cwd: string;
  design: DnaFileState;
  motion: DnaFileState;
  tokens?: DesignTokens;
  motionTokens?: MotionTokens;
  /** Id of the saved DNA entry currently applied, if any. */
  activeSavedId?: string | null;
}

/** A user-finalized design direction, re-applicable from the Libraries tab. */
export interface SavedDnaEntry {
  id: string;
  name: string;
  tagline?: string;
  createdAt: string;
  tokens: DesignTokens;
  design: string;
  motion: string;
  source: 'scan' | 'interview' | 'library' | 'manual';
  sourceLibraryId?: string;
}

export interface DnaLibrarySummary {
  id: string;
  name: string;
  tagline: string;
  colors: string[];
  fonts: string[];
}

export interface DnaLibrary extends DnaLibrarySummary {
  design: string;
  motion: string;
}

export interface DnaDraft {
  cwd: string;
  content: string;
  motion: string;
  tokens: DesignTokens;
  sources: string[];
}

// ── Validator ────────────────────────────────────────────────────────

export interface ValidatorPage {
  id: string;
  url: string;
  label?: string;
}

export interface ValidatorConfig {
  pages: ValidatorPage[];
  viewports: ('desktop' | 'laptop' | 'tablet' | 'mobile')[];
  // Prompt prefix used when handing findings to an agent for fixes.
  fixPrompt?: string;
  runAfterDesignPrompt?: boolean;
}

type FindingSeverity = 'error' | 'warning';

export type FindingRule =
  | 'off-palette-color'
  | 'off-scale-font-size'
  | 'off-scale-radius'
  | 'unknown-font-family'
  | 'off-scale-spacing';

export interface ValidatorFinding {
  id: string;
  rule: FindingRule;
  severity: FindingSeverity;
  pageId: string;
  viewport: string;
  selector: string;
  label: string;
  property: string;
  actual: string;
  expected: string;
  box?: { x: number; y: number; width: number; height: number };
}

export interface ValidatorReport {
  cwd: string;
  startedAt: string;
  finishedAt: string;
  pagesAudited: number;
  elementsAudited: number;
  findings: ValidatorFinding[];
}

// One element sampled by the in-page audit collector.
export interface AuditElement {
  selector: string;
  tag: string;
  label?: string;
  box: { x: number; y: number; width: number; height: number };
  styles: Record<string, string>;
}

// ── Reference library ────────────────────────────────────────────────

export interface DesignLibraryItem {
  id: string;
  name: string;
  note?: string;
  url: string;
  createdAt: string;
  screenshotPath?: string;
  mimeType?: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  category?: 'moodboard' | 'inspiration' | 'reference';
  selector?: string;
  source?: { component?: string; file?: string; line?: number };
  styles?: Record<string, string>;
  html?: string;
}

// ── Prototypes (multi-frame canvas) ──────────────────────────────────

export interface PrototypeInfo {
  id: string;
  name: string;
  path: string;
  updatedAt: string;
  html: string;
}

// ── Component shelf ──────────────────────────────────────────────────

export interface ComponentRegistryEntry {
  name: string;
  file: string;
  line: number;
  exportKind: 'default' | 'named';
  props?: string;
}
