import { parseColor, parsePx } from './tokens.js';
import type { DesignLibraryItem, DesignTokens } from './types.js';

export interface ExtractedTokens {
  tokens: Partial<DesignTokens>;
  summary: string;
}

// Turn a saved reference's captured computed styles into a token patch the
// user can merge into DESIGN.md.
export function extractTokensFromItem(item: DesignLibraryItem): ExtractedTokens {
  const styles = item.styles ?? {};
  const colors: Record<string, string> = {};
  const color = usableColor(styles.color);
  const background = usableColor(styles.backgroundColor);
  if (color) colors[`${slug(item.name)}-text`] = color;
  if (background) colors[`${slug(item.name)}-bg`] = background;

  const fonts: DesignTokens['fonts'] = {};
  const family = styles.fontFamily?.trim();
  if (family) {
    if (family.toLowerCase().includes('mono')) fonts.mono = family;
    else fonts.sans = family;
  }

  const typeScale: number[] = [];
  const fontSize = parsePx(styles.fontSize ?? '');
  if (fontSize !== undefined) typeScale.push(fontSize);

  const radii: number[] = [];
  const radius = parsePx(firstValue(styles.borderRadius));
  if (radius !== undefined && radius > 0) radii.push(radius);

  const parts = [
    Object.keys(colors).length > 0 ? `${Object.keys(colors).length} colors` : undefined,
    family ? 'font stack' : undefined,
    typeScale.length > 0 ? `${typeScale[0]}px type size` : undefined,
    radii.length > 0 ? `${radii[0]}px radius` : undefined,
  ].filter(Boolean);
  return {
    tokens: { colors, fonts, typeScale, radii },
    summary:
      parts.length > 0
        ? `Extracted ${parts.join(', ')} from "${item.name}".`
        : `No measurable tokens found on "${item.name}".`,
  };
}

function usableColor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = parseColor(value);
  if (!parsed || parsed[3] === 0) return undefined;
  return value;
}

function firstValue(value: string | undefined): string {
  return (value ?? '').split(/\s+/)[0] ?? '';
}

function slug(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return cleaned || 'reference';
}
