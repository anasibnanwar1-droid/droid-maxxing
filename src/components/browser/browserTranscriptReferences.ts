import type { BrowserTranscriptReference, DesignReference } from '../../types/bridge';

export function browserTranscriptReferenceFromDesignReference(reference: DesignReference): BrowserTranscriptReference | null {
  const anchor = reference.anchor;
  const id = reference.id ?? anchor?.id;
  if (!id || !anchor) return null;

  const attributes = reference.detail?.attributes;
  const label = normalizeBrowserReferenceLabel(
    anchor.name ??
      attributes?.['data-testid'] ??
      attributes?.id ??
      anchor.text ??
      anchor.role ??
      anchor.tag,
    anchor.kind === 'element' ? anchor.tag ?? 'element' : anchor.kind,
  );

  return {
    id,
    kind: anchor.kind,
    label,
    url: reference.url,
    selector: reference.detail?.selector,
  };
}

export function browserTranscriptReferencesFromDesignReferences(references: DesignReference[]): BrowserTranscriptReference[] {
  return references
    .map(browserTranscriptReferenceFromDesignReference)
    .filter((reference): reference is BrowserTranscriptReference => Boolean(reference));
}

export function normalizeBrowserReferenceLabel(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? fallback)
    .replace(/^@+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const readable = cleaned || fallback;
  const compact = readable
    .replace(/^@+/, '')
    .replace(/[^a-zA-Z0-9._ -]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 36)
    .replace(/[._-]+$/g, '');
  return compact || fallback.replace(/^@+/, '') || 'reference';
}
