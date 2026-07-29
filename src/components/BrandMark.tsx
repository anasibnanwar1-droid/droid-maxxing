// The DROIDEX wordmark. Same recipe as the iOS app and portal: Silkscreen
// pixel font, slightly tight tracking, and the DROIDE + X split (so the X can
// be recolored independently later). iOS fixes the color at #FF5722; here the
// mark follows the active theme accent instead.
export function BrandMark({ size = 32, className = '' }: { size?: number; className?: string }) {
  return (
    <span
      aria-label="DROIDEX"
      className={`font-pixel inline-block select-none leading-none text-droid-accent ${className}`}
      style={{ fontSize: size, letterSpacing: `${(size * -0.04).toFixed(2)}px` }}
    >
      DROIDE<span>X</span>
    </span>
  );
}
