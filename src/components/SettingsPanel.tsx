import { useStore } from '../hooks/useStore';
import { updateSessionSettings } from '../lib/commands';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronLeft, Search, Sun, Moon, Monitor, Check, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ColorField } from './ColorPicker';
import { ModelIcon, providerOf } from './ModelIcon';

const PRESET_ACCENTS = [
  '#ee6018', '#ef6f2e', '#d15010', '#e8a838', '#4a9e7a',
  '#4ecdc4', '#7a8aaa', '#a78bfa', '#f87171', '#fcfcfc',
];

const PRESET_THEMES = {
  dark: { bg: '#0a0a0a', fg: '#ededed', surface: '#111111', border: '#1f1f1f' },
  light: { bg: '#fafafa', fg: '#1a1a1a', surface: '#f0f0f0', border: '#e0e0e0' },
  midnight: { bg: '#0a0e1a', fg: '#c8d0e0', surface: '#11152a', border: '#1a2040' },
  warm: { bg: '#1a1612', fg: '#d8d0c8', surface: '#221e18', border: '#322a22' },
};

const SYSTEM_FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const UI_FONTS: { id: string; label: string; stack: string }[] = [
  { id: 'system', label: 'System', stack: SYSTEM_FONT_STACK },
  { id: 'inter', label: 'Inter', stack: `"Inter", ${SYSTEM_FONT_STACK}` },
  { id: 'sf', label: 'SF Pro', stack: `"SF Pro Display", "SF Pro Text", ${SYSTEM_FONT_STACK}` },
  { id: 'geist', label: 'Geist', stack: `"Geist", ${SYSTEM_FONT_STACK}` },
  { id: 'helvetica', label: 'Helvetica', stack: `"Helvetica Neue", Helvetica, Arial, sans-serif` },
  { id: 'georgia', label: 'Georgia', stack: `Georgia, "Times New Roman", serif` },
  { id: 'mono', label: 'Mono', stack: `"JetBrains Mono", "Fira Code", ui-monospace, monospace` },
];

export function uiFontStack(id: string): string {
  return UI_FONTS.find((f) => f.id === id)?.stack ?? SYSTEM_FONT_STACK;
}

// Base palette for a theme mode. `system` follows the OS preference.
export function paletteForMode(mode: 'dark' | 'light' | 'system') {
  const resolved = mode === 'system'
    ? (window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : mode;
  return resolved === 'light' ? PRESET_THEMES.light : PRESET_THEMES.dark;
}

type NavItem = { label: string };
const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: 'Personal',
    items: [
      { label: 'General' },
      { label: 'Profile' },
      { label: 'Appearance' },
      { label: 'Configuration' },
      { label: 'Personalization' },
      { label: 'Keyboard shortcuts' },
      { label: 'Usage & billing' },
    ],
  },
  {
    group: 'Integrations',
    items: [
      { label: 'Snapshots' },
      { label: 'MCP servers' },
      { label: 'Browser' },
    ],
  },
  {
    group: 'Coding',
    items: [
      { label: 'Hooks' },
      { label: 'Connections' },
      { label: 'Git' },
      { label: 'Environments' },
      { label: 'Worktrees' },
    ],
  },
  {
    group: 'Archived',
    items: [{ label: 'Archived chats' }],
  },
];

/* ── shared controls ── */
function ColorSwatch({ color, active, onClick }: { color: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`w-6 h-6 rounded-full border-2 transition-transform hover:scale-110 ${
        active ? 'border-droid-text' : 'border-transparent'
      }`}
      style={{ backgroundColor: color }}
    >
      {active && <Check className="w-3 h-3 text-white mx-auto" strokeWidth={3} />}
    </button>
  );
}

function ModeButton({ active, onClick, icon: Icon, label }: {
  active: boolean; onClick: () => void; icon: React.ElementType; label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] transition-colors ${
        active
          ? 'bg-droid-elevated text-droid-text border border-droid-border'
          : 'text-droid-text-muted hover:text-droid-text'
      }`}
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
    </button>
  );
}

function Slider({ label, sub, value, min, max, onChange, suffix = '' }: {
  label: string; sub?: string; value: number; min: number; max: number; onChange: (v: number) => void; suffix?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 border-b border-droid-border/60">
      <div>
        <div className="text-[13px] text-droid-text">{label}</div>
        {sub && <div className="text-[11px] text-droid-text-muted">{sub}</div>}
      </div>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-32 h-1 rounded-full cursor-pointer"
          style={{ accentColor: 'var(--droid-accent)' }}
        />
        <span className="font-mono text-[11px] text-droid-text-muted w-8 text-right">{value}{suffix}</span>
      </div>
    </div>
  );
}

function Toggle({ label, sub, checked, onChange }: { label: string; sub?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-droid-border/60">
      <div>
        <div className="text-[13px] text-droid-text">{label}</div>
        {sub && <div className="text-[11px] text-droid-text-muted">{sub}</div>}
      </div>
      <button
        onClick={() => onChange(!checked)}
        className={`w-10 h-6 rounded-full transition-colors shrink-0 flex items-center p-0.5 ${checked ? 'bg-droid-accent' : 'bg-droid-border'}`}
      >
        <span className={`w-5 h-5 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-4' : 'translate-x-0'}`} />
      </button>
    </div>
  );
}

function SegmentRow({ label, sub, options, value, onChange }: {
  label: string; sub?: string; options: { v: string; t: string }[]; value: string; onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-droid-border/60">
      <div>
        <div className="text-[13px] text-droid-text">{label}</div>
        {sub && <div className="text-[11px] text-droid-text-muted">{sub}</div>}
      </div>
      <div className="flex gap-1">
        {options.map((o) => (
          <button
            key={o.v}
            onClick={() => onChange(o.v)}
            className={`px-2.5 py-1 rounded-md text-[11px] transition-colors ${
              value === o.v ? 'bg-droid-elevated text-droid-text border border-droid-border' : 'text-droid-text-muted hover:text-droid-text'
            }`}
          >
            {o.t}
          </button>
        ))}
      </div>
    </div>
  );
}

function DiffPreview({ diffStyle }: { diffStyle: 'color' | 'symbol' }) {
  const addBg = diffStyle === 'color' ? 'rgba(106,138,106,0.12)' : 'transparent';
  const delBg = diffStyle === 'color' ? 'rgba(176,106,74,0.12)' : 'transparent';
  const addPrefix = diffStyle === 'symbol' ? '+' : '';
  const delPrefix = diffStyle === 'symbol' ? '-' : '';
  return (
    <div className="rounded-lg border border-droid-border overflow-hidden font-mono text-[11px] leading-5">
      <div className="px-3 py-1.5 bg-droid-elevated border-b border-droid-border text-droid-text-muted">themePreview.ts</div>
      <div className="px-3 py-1.5">
        <div style={{ backgroundColor: delBg, color: 'var(--droid-orange)' }}>{delPrefix}  accent: "#ff5d2e",</div>
        <div style={{ backgroundColor: addBg, color: 'var(--droid-green)' }}>{addPrefix}  accent: "#ee6018",</div>
        <div style={{ backgroundColor: delBg, color: 'var(--droid-orange)' }}>{delPrefix}  surface: "#181818",</div>
        <div style={{ backgroundColor: addBg, color: 'var(--droid-green)' }}>{addPrefix}  surface: "#111111",</div>
      </div>
    </div>
  );
}

function SectionTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-[15px] font-semibold text-droid-text">{title}</h2>
      {sub && <p className="text-[12px] text-droid-text-muted mt-0.5">{sub}</p>}
    </div>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] font-medium text-droid-text-muted uppercase tracking-wider mb-2 mt-1">{children}</div>;
}

/* ── appearance content ── */
function AppearanceSection() {
  const { state, dispatch } = useStore();
  const theme = state.theme;
  const updateTheme = (patch: Partial<typeof theme>) => {
    dispatch({ type: 'SET_THEME', theme: patch });
    applyTheme({ ...theme, ...patch });
  };

  return (
    <div className="max-w-2xl">
      <SectionTitle title="Appearance" sub="Tune the look and feel of Mission Control." />

      {/* Theme mode + preview */}
      <div className="rounded-xl border border-droid-border bg-droid-surface p-4 mb-6">
        <div className="flex items-start justify-between mb-3">
          <div>
            <div className="text-[13px] text-droid-text">Theme</div>
            <div className="text-[11px] text-droid-text-muted">Use light, dark, or match your system</div>
          </div>
          <div className="flex gap-1">
            <ModeButton active={theme.mode === 'light'} onClick={() => updateTheme({ mode: 'light', ...paletteForMode('light') })} icon={Sun} label="Light" />
            <ModeButton active={theme.mode === 'dark'} onClick={() => updateTheme({ mode: 'dark', ...paletteForMode('dark') })} icon={Moon} label="Dark" />
            <ModeButton active={theme.mode === 'system'} onClick={() => updateTheme({ mode: 'system', ...paletteForMode('system') })} icon={Monitor} label="System" />
          </div>
        </div>
        <DiffPreview diffStyle={theme.diffStyle} />
      </div>

      {/* Presets */}
      <GroupLabel>Presets</GroupLabel>
      <div className="grid grid-cols-4 gap-2 mb-6">
        {Object.entries(PRESET_THEMES).map(([name, colors]) => (
          <button
            key={name}
            onClick={() => updateTheme(colors)}
            className="flex flex-col items-center gap-1.5 p-2 rounded-lg border border-droid-border hover:border-droid-border-hover transition-colors"
          >
            <div className="w-full h-8 rounded-md border border-droid-border" style={{ backgroundColor: colors.bg }} />
            <span className="text-[10px] text-droid-text-muted capitalize">{name}</span>
          </button>
        ))}
      </div>

      {/* Colors */}
      <GroupLabel>Colors</GroupLabel>
      <div className="space-y-2.5 mb-3">
        <ColorField label="Accent" description="Highlights, active states, send button & design-mode controls" value={theme.accent} onChange={(v) => updateTheme({ accent: v })} />
        <ColorField label="App background" description="The main window behind everything" value={theme.bg} onChange={(v) => updateTheme({ bg: v })} />
        <ColorField label="Text color" description="Default color for all text" value={theme.fg} onChange={(v) => updateTheme({ fg: v })} />
        <ColorField label="Panel background" description="Sidebar, cards and raised surfaces" value={theme.surface} onChange={(v) => updateTheme({ surface: v })} />
        <ColorField label="Borders" description="Dividers and outlines between sections" value={theme.border} onChange={(v) => updateTheme({ border: v })} />
      </div>
      <div className="flex flex-wrap gap-1.5 mb-6">
        {PRESET_ACCENTS.map((c) => (
          <ColorSwatch key={c} color={c} active={theme.accent.toLowerCase() === c.toLowerCase()} onClick={() => updateTheme({ accent: c })} />
        ))}
      </div>

      {/* Typography + behavior */}
      <GroupLabel>Typography & behavior</GroupLabel>
      <div>
        <div className="flex items-center justify-between py-2.5 border-b border-droid-border/60">
          <div>
            <div className="text-[13px] text-droid-text">UI font</div>
            <div className="text-[11px] text-droid-text-muted">Typeface for the whole app (defaults to your OS font)</div>
          </div>
          <select
            value={theme.uiFont}
            onChange={(e) => updateTheme({ uiFont: e.target.value })}
            className="bg-droid-elevated border border-droid-border rounded-md px-2 py-1 text-[12px] text-droid-text focus:outline-none focus:border-droid-border-hover cursor-pointer"
            style={{ fontFamily: uiFontStack(theme.uiFont) }}
          >
            {UI_FONTS.map((f) => (
              <option key={f.id} value={f.id}>{f.label}</option>
            ))}
          </select>
        </div>
        <Slider label="UI font size" sub="Base size used for the Mission Control UI" value={theme.uiFontSize} min={12} max={18} onChange={(v) => updateTheme({ uiFontSize: v })} suffix="px" />
        <Slider label="Code font size" sub="Base size for code across chats and diffs" value={theme.codeFontSize} min={10} max={16} onChange={(v) => updateTheme({ codeFontSize: v })} suffix="px" />
        <Slider label="Contrast" sub="Adjust overall UI contrast" value={theme.contrast} min={40} max={100} onChange={(v) => updateTheme({ contrast: v })} />
        <Toggle label="Translucent sidebar" sub="Blur and lighten the sidebar surface" checked={theme.translucentSidebar} onChange={(v) => updateTheme({ translucentSidebar: v })} />
        <SegmentRow
          label="Diff markers"
          sub="Colored bars or +/- symbols on each changed line"
          options={[{ v: 'color', t: 'Color' }, { v: 'symbol', t: '+/-' }]}
          value={theme.diffStyle}
          onChange={(v) => updateTheme({ diffStyle: v as 'color' | 'symbol' })}
        />
      </div>
    </div>
  );
}

/* ── compaction token limit helpers ── */
// Parse a user-typed limit ("200k", "1.5M", "200000") into a raw token count.
// Returns undefined for empty/invalid input — meaning "use the model window".
function parseTokenLimit(input: string): number | undefined {
  const trimmed = input.trim().toLowerCase().replace(/,/g, '');
  if (!trimmed) return undefined;
  const m = trimmed.match(/^(\d+(?:\.\d+)?)\s*([km])?$/);
  if (!m) return undefined;
  const base = Number(m[1]);
  if (!Number.isFinite(base) || base <= 0) return undefined;
  const mult = m[2] === 'm' ? 1_000_000 : m[2] === 'k' ? 1_000 : 1;
  const value = Math.floor(base * mult);
  return value > 0 ? value : undefined;
}

// Format a raw token count for display: 200000 → "200K", 1500000 → "1.5M".
function formatTokenLimit(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(2))}M`;
  if (n >= 1_000) return `${Number((n / 1_000).toFixed(2))}K`;
  return String(n);
}

function TokenLimitInput({
  value,
  onCommit,
  placeholder = 'Default',
  width = 'w-28',
}: {
  value?: number;
  onCommit: (n?: number) => void;
  placeholder?: string;
  width?: string;
}) {
  const [text, setText] = useState(value !== undefined ? formatTokenLimit(value) : '');

  useEffect(() => {
    setText(value !== undefined ? formatTokenLimit(value) : '');
  }, [value]);

  const commit = () => {
    const parsed = parseTokenLimit(text);
    onCommit(parsed);
    setText(parsed !== undefined ? formatTokenLimit(parsed) : '');
  };

  return (
    <input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        }
      }}
      placeholder={placeholder}
      className={`${width} bg-droid-bg/60 border border-droid-border rounded-md px-2.5 py-1 text-[12px] font-mono text-droid-text placeholder:text-droid-text-muted text-right focus:outline-none focus:border-droid-border-hover`}
    />
  );
}

/* ── general content ── */
function GeneralSection() {
  const { state, dispatch } = useStore();
  const selected = state.compactionModel || 'current-model';
  const [query, setQuery] = useState('');
  const [addModelId, setAddModelId] = useState('');

  // Push a compaction settings patch to every loaded session so behavior stays
  // consistent across open chats and missions.
  const applyToLiveSessions = (patch: {
    compactionModel?: string | null;
    compactionTokenLimit?: number | null;
    compactionTokenLimitPerModel?: Record<string, number>;
  }) => {
    for (const id of state.missionOrder) {
      const m = state.missions[id];
      if (m?.sessionId) updateSessionSettings({ sessionId: m.sessionId, ...patch });
    }
  };

  const setCompaction = (value: string) => {
    dispatch({ type: 'SET_COMPACTION_MODEL_GLOBAL', compactionModel: value });
    applyToLiveSessions({ compactionModel: value === 'current-model' ? null : value });
  };

  const setGlobalLimit = (limit?: number) => {
    dispatch({ type: 'SET_COMPACTION_TOKEN_LIMIT_GLOBAL', limit });
    applyToLiveSessions({
      compactionTokenLimit: limit ?? null,
      compactionTokenLimitPerModel: state.compactionTokenLimitPerModel,
    });
  };

  const setModelLimit = (modelId: string, limit?: number) => {
    dispatch({ type: 'SET_COMPACTION_TOKEN_LIMIT_FOR_MODEL', modelId, limit });
    const next = { ...state.compactionTokenLimitPerModel };
    if (limit === undefined) delete next[modelId];
    else next[modelId] = limit;
    applyToLiveSessions({
      compactionTokenLimit: state.compactionTokenLimit ?? null,
      compactionTokenLimitPerModel: next,
    });
  };

  const q = query.trim().toLowerCase();
  const models = q
    ? state.models.filter((m) => m.displayName.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))
    : state.models;

  const overrideEntries = Object.entries(state.compactionTokenLimitPerModel);
  const availableForOverride = state.models.filter((m) => !(m.id in state.compactionTokenLimitPerModel));
  const modelLabel = (id: string) => state.models.find((m) => m.id === id)?.displayName ?? id;

  const Row = ({ id, label, sub }: { id: string; label: string; sub?: string }) => {
    const active = selected === id;
    return (
      <button
        onClick={() => setCompaction(id)}
        className={`flex items-center gap-2.5 w-full px-3 py-2.5 rounded-lg border transition-colors text-left ${
          active ? 'border-transparent bg-droid-elevated' : 'border-droid-border hover:bg-droid-elevated/50'
        }`}
        style={active ? { boxShadow: 'inset 0 0 0 1px var(--droid-accent)' } : undefined}
      >
        {id !== 'current-model' && <ModelIcon provider={providerOf(state.models.find((m) => m.id === id), id)} size={16} />}
        <div className="min-w-0 flex-1">
          <div className="text-[13px] text-droid-text truncate">{label}</div>
          {sub && <div className="text-[11px] text-droid-text-muted truncate">{sub}</div>}
        </div>
        {active && <Check className="w-4 h-4 shrink-0" style={{ color: 'var(--droid-accent)' }} />}
      </button>
    );
  };

  return (
    <div className="max-w-2xl">
      <SectionTitle title="General" sub="Defaults that apply across all chats and missions." />

      <GroupLabel>Compaction model</GroupLabel>
      <p className="text-[12px] text-droid-text-muted mb-3">
        Choose which model summarizes a conversation when it is compacted.
      </p>

      <div className="rounded-xl border border-droid-border bg-droid-surface p-3 mb-8">
        <Row id="current-model" label="Current model" sub="Compact with whatever model the session is using" />

        <div className="flex items-center gap-2 px-2.5 my-2 h-8 rounded-md bg-droid-bg/60 border border-droid-border">
          <Search className="w-3.5 h-3.5 text-droid-text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search models..."
            className="bg-transparent text-[12px] text-droid-text placeholder:text-droid-text-muted focus:outline-none w-full"
          />
        </div>

        <div className="max-h-72 overflow-y-auto space-y-1.5">
          {models.map((m) => (
            <Row key={m.id} id={m.id} label={m.displayName} sub={m.provider} />
          ))}
          {models.length === 0 && (
            <div className="px-3 py-4 text-center text-[12px] text-droid-text-muted">No models match.</div>
          )}
        </div>
      </div>

      <GroupLabel>Compaction token limit</GroupLabel>
      <p className="text-[12px] text-droid-text-muted mb-3">
        Compact a conversation once it grows past this many tokens. Leave empty to use each model&apos;s
        full context window. Accepts values like <span className="font-mono">200K</span> or <span className="font-mono">1.5M</span>.
      </p>

      <div className="rounded-xl border border-droid-border bg-droid-surface p-3">
        {/* Global default */}
        <div className="flex items-center justify-between gap-3 px-1 py-1.5">
          <div className="min-w-0">
            <div className="text-[13px] text-droid-text">Default limit</div>
            <div className="text-[11px] text-droid-text-muted">Applies to every model without an override</div>
          </div>
          <TokenLimitInput value={state.compactionTokenLimit} onCommit={setGlobalLimit} placeholder="Model window" width="w-32" />
        </div>

        <div className="h-px bg-droid-border/60 my-2" />

        {/* Per-model overrides */}
        <div className="px-1">
          <div className="text-[11px] font-medium text-droid-text-muted mb-2">Per-model overrides</div>

          {overrideEntries.length === 0 && (
            <div className="text-[12px] text-droid-text-muted py-1.5">No overrides — every model uses the default limit.</div>
          )}

          <div className="space-y-1.5">
            {overrideEntries.map(([id, limit]) => (
              <div key={id} className="flex items-center gap-2.5 rounded-lg border border-droid-border bg-droid-bg/40 px-2.5 py-2">
                <ModelIcon provider={providerOf(state.models.find((m) => m.id === id), id)} size={16} />
                <span className="text-[12px] text-droid-text truncate flex-1">{modelLabel(id)}</span>
                <TokenLimitInput value={limit} onCommit={(n) => setModelLimit(id, n)} />
                <button
                  onClick={() => setModelLimit(id, undefined)}
                  className="p-1 rounded-md text-droid-text-muted hover:text-droid-text hover:bg-droid-elevated transition-colors shrink-0"
                  title="Remove override"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>

          {/* Add override */}
          {availableForOverride.length > 0 && (
            <div className="flex items-center gap-2 mt-2.5">
              <select
                value={addModelId}
                onChange={(e) => {
                  const id = e.target.value;
                  if (!id) return;
                  setModelLimit(id, state.compactionTokenLimit ?? 200_000);
                  setAddModelId('');
                }}
                className="flex-1 bg-droid-bg/60 border border-droid-border rounded-md px-2 py-1.5 text-[12px] text-droid-text focus:outline-none focus:border-droid-border-hover cursor-pointer"
              >
                <option value="">Add a model override…</option>
                {availableForOverride.map((m) => (
                  <option key={m.id} value={m.id}>{m.displayName}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PlaceholderSection({ title }: { title: string }) {
  return (
    <div className="max-w-2xl">
      <SectionTitle title={title} />
      <div className="rounded-xl border border-dashed border-droid-border bg-droid-surface/40 p-10 text-center">
        <p className="text-[13px] text-droid-text-secondary">{title} settings are coming soon.</p>
      </div>
    </div>
  );
}

/* ── main full-page settings ── */
export default function SettingsPanel() {
  const { state, dispatch } = useStore();
  const [active, setActive] = useState('Appearance');
  const [query, setQuery] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dispatch({ type: 'TOGGLE_SETTINGS' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dispatch]);

  const close = () => dispatch({ type: 'TOGGLE_SETTINGS' });
  const q = query.trim().toLowerCase();

  return (
    <AnimatePresence>
      {state.settingsOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          className="fixed inset-0 z-50 bg-droid-bg flex"
        >
          {/* Left nav */}
          <aside className="w-60 shrink-0 border-r border-droid-border flex flex-col bg-droid-surface/40">
            {/* Traffic-light clearance */}
            <div data-electron-drag-region className="h-9 shrink-0" />
            <button
              onClick={close}
              className="flex items-center gap-1.5 px-4 h-10 text-[12px] text-droid-text-secondary hover:text-droid-text transition-colors shrink-0"
            >
              <ChevronLeft className="w-4 h-4" /> Back to app
            </button>
            <div className="px-3 pb-2">
              <div className="flex items-center gap-2 px-2.5 h-8 rounded-md bg-droid-elevated border border-droid-border">
                <Search className="w-3.5 h-3.5 text-droid-text-muted" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search settings..."
                  className="bg-transparent text-[12px] text-droid-text placeholder:text-droid-text-muted focus:outline-none w-full"
                />
              </div>
            </div>
            <nav className="flex-1 overflow-y-auto px-3 py-2 space-y-4">
              {NAV.map(({ group, items }) => {
                const filtered = items.filter((it) => !q || it.label.toLowerCase().includes(q));
                if (filtered.length === 0) return null;
                return (
                  <div key={group}>
                    <div className="text-[10px] font-medium text-droid-text-muted uppercase tracking-wider px-2 mb-1">{group}</div>
                    {filtered.map(({ label }) => (
                      <button
                        key={label}
                        onClick={() => setActive(label)}
                        className={`flex items-center w-full px-2 h-8 rounded-md text-[12px] transition-colors ${
                          active === label ? 'bg-droid-elevated text-droid-text' : 'text-droid-text-secondary hover:text-droid-text hover:bg-droid-elevated/50'
                        }`}
                      >
                        <span className="truncate">{label}</span>
                      </button>
                    ))}
                  </div>
                );
              })}
            </nav>
          </aside>

          {/* Content */}
          <div className="flex-1 overflow-y-auto">
            <div className="px-10 py-8">
              {active === 'Appearance' ? (
                <AppearanceSection />
              ) : active === 'General' ? (
                <GeneralSection />
              ) : (
                <PlaceholderSection title={active} />
              )}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ── apply CSS variables to document ── */
export function applyTheme(theme: ReturnType<typeof useStore>['state']['theme']) {
  const root = document.documentElement;
  root.style.setProperty('--droid-bg', theme.bg);
  root.style.setProperty('--droid-surface', theme.surface);
  root.style.setProperty('--droid-elevated', adjustColor(theme.surface, 6));
  // Soften resting borders by blending toward the background so panel/section
  // separators read as gentle hairlines rather than hard lines. Keep the original
  // border value for hover so interactive elements still gain definition.
  root.style.setProperty('--droid-border', mixHex(theme.border, theme.bg, 0.5));
  root.style.setProperty('--droid-border-hover', theme.border);
  root.style.setProperty('--droid-text', theme.fg);
  root.style.setProperty('--droid-text-secondary', adjustColor(theme.fg, -30));
  root.style.setProperty('--droid-text-muted', adjustColor(theme.fg, -50));
  root.style.setProperty('--droid-accent', theme.accent);
  root.style.setProperty('--droid-green', adjustColor(theme.accent, -10));
  root.style.setProperty('--droid-orange', adjustColor(theme.accent, 10));

  root.style.setProperty('--ui-font-family', uiFontStack(theme.uiFont));
  root.style.setProperty('--ui-font-size', `${theme.uiFontSize}px`);
  // The UI is built with fixed px text sizes, so scale the whole app relative
  // to the 14px baseline to make the size slider take visible effect.
  root.style.setProperty('--ui-zoom', `${theme.uiFontSize / 14}`);
  root.style.setProperty('--code-font-size', `${theme.codeFontSize}px`);

  // Dedicated sidebar surface so translucency only affects the sidebar. When
  // enabled, the window becomes transparent (see index.css + Electron vibrancy)
  // and the sidebar uses a semi-transparent fill so the wallpaper behind the
  // window shows through a little — frosted, not fully clear.
  root.setAttribute('data-translucent', theme.translucentSidebar ? 'true' : 'false');
  root.style.setProperty('--sidebar-bg', theme.translucentSidebar ? `${theme.surface}99` : theme.surface);
  root.style.setProperty('--sidebar-blur', theme.translucentSidebar ? 'blur(6px) saturate(150%)' : 'none');

  // Apply contrast as a filter only below 100% so it never creates a stacking
  // context that would defeat the sidebar's backdrop blur at the default value.
  const rootEl = document.getElementById('root');
  if (rootEl) rootEl.style.filter = theme.contrast >= 100 ? '' : `contrast(${theme.contrast}%)`;
}

/* ── tiny color utils ── */
function adjustColor(hex: string, lighten: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const clamp = (n: number) => Math.max(0, Math.min(255, n + lighten));
  const toHex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${toHex(clamp(r))}${toHex(clamp(g))}${toHex(clamp(b))}`;
}

// Blend `hex` toward `target` by t (0..1).
function mixHex(hex: string, target: string, t: number): string {
  const parse = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const [r1, g1, b1] = parse(hex);
  const [r2, g2, b2] = parse(target);
  const mix = (a: number, b: number) => Math.round(a * (1 - t) + b * t);
  const toHex = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  return `#${toHex(mix(r1, r2))}${toHex(mix(g1, g2))}${toHex(mix(b1, b2))}`;
}
