import { nearestPaletteColor, nearestScaleValue, parseColor, parsePx } from '../tokens.js';
import type { AuditElement, DesignTokens, FindingRule, ValidatorFinding } from '../types.js';

// Distance in RGB space beyond which a color no longer counts as "the same
// token with antialiasing"; tuned to catch off-brand grays and tints.
const COLOR_TOLERANCE = 12;
const PX_TOLERANCE = 1;
const MAX_PER_RULE = 25;

export interface AuditContext {
  pageId: string;
  viewport: string;
}

export function auditElements(
  elements: AuditElement[],
  tokens: DesignTokens,
  context: AuditContext,
): ValidatorFinding[] {
  const findings: ValidatorFinding[] = [];
  const counts = new Map<FindingRule, number>();
  const push = (finding: Omit<ValidatorFinding, 'id' | 'pageId' | 'viewport'>) => {
    const used = counts.get(finding.rule) ?? 0;
    if (used >= MAX_PER_RULE) return;
    counts.set(finding.rule, used + 1);
    findings.push({
      ...finding,
      id: `${context.pageId}-${context.viewport}-${finding.rule}-${String(findings.length + 1)}`,
      pageId: context.pageId,
      viewport: context.viewport,
    });
  };

  for (const element of elements) {
    if (isAllowed(element, tokens)) continue;
    checkColors(element, tokens, push);
    checkFontSize(element, tokens, push);
    checkRadius(element, tokens, push);
    checkFontFamily(element, tokens, push);
    checkSpacing(element, tokens, push);
  }
  return findings;
}

type Push = (finding: Omit<ValidatorFinding, 'id' | 'pageId' | 'viewport'>) => void;

function checkColors(element: AuditElement, tokens: DesignTokens, push: Push): void {
  if (Object.keys(tokens.colors).length === 0) return;
  for (const property of ['color', 'backgroundColor'] as const) {
    const value = element.styles[property];
    if (!value) continue;
    const parsed = parseColor(value);
    if (!parsed || parsed[3] === 0) continue;
    const match = nearestPaletteColor(value, tokens.colors);
    if (!match || match.distance <= COLOR_TOLERANCE) continue;
    if (allowedValue(element, tokens, property, value)) continue;
    push({
      rule: 'off-palette-color',
      severity: 'error',
      selector: element.selector,
      label: labelFor(element),
      property,
      actual: value,
      expected: `nearest token \`${match.name}\` (${match.value})`,
      box: element.box,
    });
  }
}

function checkFontSize(element: AuditElement, tokens: DesignTokens, push: Push): void {
  if (tokens.typeScale.length === 0) return;
  const actual = parsePx(element.styles.fontSize ?? '');
  if (actual === undefined) return;
  const nearest = nearestScaleValue(actual, tokens.typeScale);
  if (nearest === undefined || Math.abs(nearest - actual) <= PX_TOLERANCE) return;
  if (allowedValue(element, tokens, 'fontSize', element.styles.fontSize ?? '')) return;
  push({
    rule: 'off-scale-font-size',
    severity: 'error',
    selector: element.selector,
    label: labelFor(element),
    property: 'fontSize',
    actual: `${String(actual)}px`,
    expected: `type scale value (nearest ${String(nearest)}px)`,
    box: element.box,
  });
}

function checkRadius(element: AuditElement, tokens: DesignTokens, push: Push): void {
  if (tokens.radii.length === 0) return;
  const raw = (element.styles.borderRadius ?? '').split(/\s+/)[0] ?? '';
  const actual = parsePx(raw);
  if (actual === undefined || actual === 0) return;
  if (actual >= 999) return; // pill shapes are a deliberate idiom
  const nearest = nearestScaleValue(actual, tokens.radii);
  if (nearest === undefined || Math.abs(nearest - actual) <= PX_TOLERANCE) return;
  if (allowedValue(element, tokens, 'borderRadius', raw)) return;
  push({
    rule: 'off-scale-radius',
    severity: 'warning',
    selector: element.selector,
    label: labelFor(element),
    property: 'borderRadius',
    actual: `${String(actual)}px`,
    expected: `radius scale value (nearest ${String(nearest)}px)`,
    box: element.box,
  });
}

function checkFontFamily(element: AuditElement, tokens: DesignTokens, push: Push): void {
  const stacks = Object.values(tokens.fonts).filter(
    (stack): stack is string => typeof stack === 'string',
  );
  if (stacks.length === 0) return;
  const family = firstFamily(element.styles.fontFamily ?? '');
  if (!family) return;
  const known = stacks.some((stack) => stack.toLowerCase().includes(family));
  if (known) return;
  if (allowedValue(element, tokens, 'fontFamily', element.styles.fontFamily ?? '')) return;
  push({
    rule: 'unknown-font-family',
    severity: 'error',
    selector: element.selector,
    label: labelFor(element),
    property: 'fontFamily',
    actual: element.styles.fontFamily ?? '',
    expected: `one of the DNA font stacks (${String(stacks.length)})`,
    box: element.box,
  });
}

function checkSpacing(element: AuditElement, tokens: DesignTokens, push: Push): void {
  if (tokens.spacing.length === 0) return;
  const raw = (element.styles.paddingTop ?? '').trim();
  const actual = parsePx(raw);
  if (actual === undefined || actual === 0) return;
  const nearest = nearestScaleValue(actual, tokens.spacing);
  if (nearest === undefined || Math.abs(nearest - actual) <= PX_TOLERANCE) return;
  if (allowedValue(element, tokens, 'paddingTop', raw)) return;
  push({
    rule: 'off-scale-spacing',
    severity: 'warning',
    selector: element.selector,
    label: labelFor(element),
    property: 'paddingTop',
    actual: `${String(actual)}px`,
    expected: `spacing scale value (nearest ${String(nearest)}px)`,
    box: element.box,
  });
}

function firstFamily(stack: string): string {
  const first = stack
    .split(',')[0]
    ?.trim()
    .replace(/^["']|["']$/g, '')
    .toLowerCase();
  if (!first || first.includes('system-ui') || first.startsWith('-apple')) return '';
  return first;
}

function labelFor(element: AuditElement): string {
  const label = element.label?.slice(0, 60);
  return label && label.length > 0 ? label : `<${element.tag}>`;
}

function isAllowed(element: AuditElement, tokens: DesignTokens): boolean {
  return (tokens.allowlist ?? []).some(
    (rule) =>
      Boolean(rule.selector) &&
      !rule.property &&
      !rule.value &&
      matchesSelector(rule.selector, element.selector),
  );
}

function allowedValue(
  element: AuditElement,
  tokens: DesignTokens,
  property: string,
  value: string,
): boolean {
  return (tokens.allowlist ?? []).some((rule) => {
    if (rule.selector && !matchesSelector(rule.selector, element.selector)) return false;
    if (rule.property && rule.property !== property) return false;
    if (rule.value && rule.value.trim().toLowerCase() !== value.trim().toLowerCase()) return false;
    return Boolean(rule.selector) || Boolean(rule.property) || Boolean(rule.value);
  });
}

function matchesSelector(pattern: string | undefined, selector: string): boolean {
  if (!pattern) return true;
  return selector.includes(pattern);
}
