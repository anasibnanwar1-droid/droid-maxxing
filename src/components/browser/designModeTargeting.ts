import type { BrowserBox, BrowserElementRef } from '../../types/bridge';
import type { Point, Size } from '../canvas/canvasMath';

const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'textarea', 'select', 'summary']);
const INTERACTIVE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'menuitem',
  'option',
  'radio',
  'searchbox',
  'switch',
  'tab',
  'textbox',
]);
const TEXT_TAGS = new Set([
  'blockquote',
  'code',
  'em',
  'figcaption',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'label',
  'li',
  'p',
  'pre',
  'small',
  'span',
  'strong',
  'td',
  'th',
]);

export function pickDesignModeTarget(
  refs: BrowserElementRef[],
  point: Point,
  viewport: Size,
): BrowserElementRef | undefined {
  const matches = refs
    .filter((ref) => containsPoint(ref.box, point) && isUsableBox(ref.box))
    .map((ref) => ({ ref, score: targetScore(ref, viewport) }))
    .sort((a, b) => a.score - b.score);

  return matches[0]?.ref;
}

export function labelForBrowserRef(ref: BrowserElementRef): string {
  const label = ref.name || ref.text || ref.role || ref.tagName;
  return `${label} - ${ref.tagName.toLowerCase()}`;
}

function targetScore(ref: BrowserElementRef, viewport: Size): number {
  const boxArea = area(ref.box);
  const viewportArea = Math.max(1, viewport.width * viewport.height);
  const tag = ref.tagName.toLowerCase();
  const role = ref.role?.toLowerCase();
  const hasName = Boolean(ref.name || ref.text);
  const namedContainer = Boolean(
    ref.attributes?.['data-testid'] || ref.attributes?.title || ref.attributes?.['aria-label'],
  );

  let score = 400;
  if (INTERACTIVE_TAGS.has(tag) || (role && INTERACTIVE_ROLES.has(role))) score = 0;
  else if (TEXT_TAGS.has(tag)) score = 80;
  else if (hasName) score = 140;
  else if (namedContainer) score = 190;

  score += Math.min(120, boxArea / 9000);
  if (boxArea > viewportArea * 0.45) score += 500;
  if (boxArea > viewportArea * 0.65) score += 1000;
  if (!hasName && !namedContainer && !role) score += 120;
  return score;
}

function containsPoint(box: BrowserBox, point: Point): boolean {
  return (
    point.x >= box.x &&
    point.y >= box.y &&
    point.x <= box.x + box.width &&
    point.y <= box.y + box.height
  );
}

function isUsableBox(box: BrowserBox): boolean {
  return box.width >= 4 && box.height >= 4 && area(box) >= 16;
}

function area(box: BrowserBox): number {
  return box.width * box.height;
}
