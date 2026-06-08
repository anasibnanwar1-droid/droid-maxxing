import type { EditorId } from '../lib/editorOpen';

// Small brand marks for each launch target. Colors are baked in so the icons
// read as real app glyphs rather than monochrome UI icons.
export function EditorIcon({ editor, size = 16 }: { editor: EditorId; size?: number }) {
  const s = { width: size, height: size };

  if (editor === 'vscode')
    return (
      <svg {...s} viewBox="0 0 24 24" className="shrink-0" aria-hidden>
        <path
          fill="#0098FF"
          d="M23.15 2.587 18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352Zm-5.146 14.861L10.826 12l7.178-5.448Z"
        />
      </svg>
    );

  if (editor === 'cursor')
    return (
      <svg {...s} viewBox="0 0 24 24" className="shrink-0 text-droid-text" aria-hidden>
        <path
          fill="currentColor"
          d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23"
        />
      </svg>
    );

  if (editor === 'finder')
    return (
      <svg {...s} viewBox="0 0 24 24" className="shrink-0" aria-hidden>
        <rect x="2" y="2.5" width="20" height="19" rx="5" fill="#1FA2FF" />
        <path d="M12 2.5h5a5 5 0 0 1 5 5v9a5 5 0 0 1-5 5h-5Z" fill="#0B79E6" />
        <line x1="8" y1="8" x2="8" y2="10.5" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" />
        <line x1="16" y1="8" x2="16" y2="10.5" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" />
        <path d="M8.5 15.5c1.3 1.3 5.7 1.3 7 0" stroke="#fff" strokeWidth="1.4" fill="none" strokeLinecap="round" />
      </svg>
    );

  if (editor === 'terminal')
    return (
      <svg {...s} viewBox="0 0 24 24" className="shrink-0" aria-hidden>
        <rect x="2" y="3.5" width="20" height="17" rx="4" fill="#26262A" />
        <path d="M6 9.5 9 12l-3 2.5" stroke="#43D17E" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        <line x1="11.5" y1="14.5" x2="16" y2="14.5" stroke="#E6E6E6" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );

  if (editor === 'xcode')
    return (
      <svg {...s} viewBox="0 0 24 24" className="shrink-0" aria-hidden>
        <rect x="2" y="2.5" width="20" height="19" rx="5" fill="#1C8AFF" />
        <path
          fill="#fff"
          d="m14.7 6.1 3.2 3.2-1.5 1.5-.9-.9-4.9 4.9.9.9-1.5 1.5-3.2-3.2 1.5-1.5.9.9 4.9-4.9-.9-.9 1.5-1.5Z"
        />
      </svg>
    );

  return (
    <svg {...s} viewBox="0 0 24 24" className="shrink-0 text-droid-text-muted" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="4" fill="currentColor" opacity="0.25" />
    </svg>
  );
}
