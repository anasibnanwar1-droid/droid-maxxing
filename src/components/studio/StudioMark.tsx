/**
 * The studio mark — two overlapping frames, standing for a canvas of design
 * directions. Deliberately not a generic "sparkle": the outer frame uses
 * currentColor (so callers tint it) and the front frame carries the ember accent.
 */
export default function StudioMark({
  className,
  accent = '#ee6018',
  bg = '#0d0d0d',
}: {
  className?: string;
  accent?: string;
  bg?: string;
}) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <rect
        x="3.5"
        y="3.5"
        width="12"
        height="12"
        rx="3.2"
        stroke="currentColor"
        strokeWidth="1.5"
        opacity="0.45"
      />
      <rect
        x="8.5"
        y="8.5"
        width="12"
        height="12"
        rx="3.2"
        fill={bg}
        stroke={accent}
        strokeWidth="1.6"
      />
    </svg>
  );
}
