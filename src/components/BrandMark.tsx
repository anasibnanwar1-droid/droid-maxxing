// The DROIDEX wordmark. Same recipe as the iOS app and portal: Silkscreen
// pixel font, slightly tight tracking, and the DROIDE + X split (so the X can
// be recolored independently later). The mark carries no color of its own —
// the caller picks it (theme accent on the welcome screen, muted gray as the
// browser placeholder).
export function BrandMark({ size = 32, className = '' }: { size?: number; className?: string }) {
  return (
    <span
      aria-label="DROIDEX"
      className={`font-pixel inline-block leading-none select-none ${className}`}
      style={{ fontSize: size, letterSpacing: `${(size * -0.04).toFixed(2)}px` }}
    >
      DROIDE<span>X</span>
    </span>
  );
}
