import type { BrowserTranscriptReference, DesignReference } from '../../types/bridge';

export function browserTranscriptReferenceFromDesignReference(reference: DesignReference): BrowserTranscriptReference | null {
  const id = reference.id ?? reference.element?.ref;
  if (!id) return null;

  const element = reference.element;
  const label = normalizeBrowserReferenceLabel(
    element?.name ??
      element?.attributes['data-testid'] ??
      element?.attributes.id ??
      element?.text ??
      element?.role ??
      element?.tagName,
    reference.kind === 'element' ? element?.tagName ?? 'element' : reference.kind,
  );

  return {
    id,
    kind: reference.kind,
    label,
    url: reference.note,
    selector: element?.selector,
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
