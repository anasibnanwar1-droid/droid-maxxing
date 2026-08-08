// AgentAvatar — a deterministic pixel-creature identity for a subagent, in the
// spirit of the DROIDEX silkscreen pixel brand. A 5×5 mirrored grid is hashed
// from the agent's stable id and tinted from a fixed palette. While the agent
// is working, its pixels run a diagonal shimmer sweep (CSS-only, compositor
// cheap); otherwise the creature sits still.

const PALETTE = [
  '#a07cff',
  '#ff5d2e',
  '#7c9cff',
  '#ff7a6b',
  '#5b8def',
  '#ffa94d',
  '#9b8cff',
  '#ff6fae',
  '#4fd1c5',
  '#c084fc',
];

const CELLS = 5;

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

interface Creature {
  grid: boolean[][];
  color: string;
  lit: number;
}

function creatureFromHash(h: number): Creature {
  const grid: boolean[][] = [];
  let lit = 0;
  for (let r = 0; r < CELLS; r += 1) {
    const left: boolean[] = [];
    for (let c = 0; c < 3; c += 1) {
      const on = ((h >> (r * 3 + c)) & 1) === 1;
      left.push(on);
      if (on) lit += 1;
    }
    // Mirror the three hashed columns so the grid reads as a creature.
    grid.push([left[0], left[1], left[2], left[1], left[0]]);
  }
  return { grid, color: PALETTE[h % PALETTE.length], lit };
}

// Re-hash sparse seeds so every creature reads as a shape, not noise.
function buildCreature(seed: string): Creature {
  const first = creatureFromHash(hashStr(seed));
  if (first.lit >= 4) return first;
  const second = creatureFromHash(hashStr(`${seed}#2`));
  if (second.lit >= 4) return second;
  const third = creatureFromHash(hashStr(`${seed}#3`));
  return [first, second, third].reduce((a, b) => (b.lit > a.lit ? b : a));
}

export function AgentAvatar({
  seed,
  size = 16,
  working = false,
}: {
  seed: string;
  size?: number;
  working?: boolean;
}) {
  const { grid, color } = buildCreature(seed);
  const px = size / CELLS;
  // Cells overlap by 0.4px so no hairline seams show between lit pixels.
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${String(size)} ${String(size)}`}
      className="block"
      aria-hidden
    >
      {grid.map((row, r) =>
        row.map((on, c) =>
          on ? (
            <rect
              key={`${String(r)}-${String(c)}`}
              x={c * px}
              y={r * px}
              width={px + 0.4}
              height={px + 0.4}
              rx={0.6}
              fill={color}
              className={working ? 'agent-avatar-pixel' : undefined}
              style={working ? { animationDelay: `${String((r + c) * 90)}ms` } : undefined}
            />
          ) : null,
        ),
      )}
    </svg>
  );
}
