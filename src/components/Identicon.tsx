export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const PALETTE = ['#a07cff', '#ff5d2e', '#7c9cff', '#ff7a6b', '#5b8def', '#ffa94d', '#9b8cff', '#ff6fae', '#4fd1c5', '#c084fc'];

const NAMES = [
  'Popper', 'Epicurus', 'Dewey', 'Goodall', 'Gauss', 'Newton', 'Curie', 'Turing',
  'Lovelace', 'Bohr', 'Hopper', 'Feynman', 'Darwin', 'Tesla', 'Euler', 'Kepler', 'Planck', 'Pascal',
];

export function agentName(seed: string): string {
  return NAMES[hashStr(seed) % NAMES.length];
}

export function Identicon({ seed, size = 18 }: { seed: string; size?: number }) {
  const h = hashStr(seed);
  const color = PALETTE[h % PALETTE.length];
  const cells = 5;
  const px = size / cells;

  const grid: boolean[][] = [];
  for (let r = 0; r < cells; r++) {
    const left: boolean[] = [];
    for (let c = 0; c < 3; c++) left.push(((h >> (r * 3 + c)) & 1) === 1);
    grid.push([left[0], left[1], left[2], left[1], left[0]]);
  }

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0" aria-hidden>
      {grid.map((row, r) =>
        row.map((on, c) =>
          on ? <rect key={`${r}-${c}`} x={c * px} y={r * px} width={px + 0.4} height={px + 0.4} fill={color} /> : null,
        ),
      )}
    </svg>
  );
}
