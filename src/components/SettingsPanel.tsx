import { useStore, type LiveEnterBehavior } from '../hooks/useStore';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronLeft, ChevronDown, Search, Sun, Moon, Monitor, Check, X, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ColorField } from './ColorPicker';
import { ModelIcon, providerOf } from './ModelIcon';
import type { ModelInfo } from '../types/bridge';
import { useOnboarding } from '../hooks/useOnboarding';
import { getAppVersion, type AppUpdateInfo } from '../lib/onboarding';
import { refreshAppUpdate, startAppUpdate } from '../lib/appUpdate';

const PRESET_ACCENTS = [
  '#ee6018',
  '#ef6f2e',
  '#d15010',
  '#e8a838',
  '#4a9e7a',
  '#4ecdc4',
  '#7a8aaa',
  '#a78bfa',
  '#f87171',
  '#fcfcfc',
];

const PRESET_THEMES = {
  dark: { bg: '#0a0a0a', fg: '#ededed', surface: '#111111', border: '#1f1f1f' },
  light: { bg: '#fcfcfc', fg: '#141414', surface: '#f3f3f3', border: '#eeeeee' },
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
  const resolved =
    mode === 'system'
      ? window.matchMedia?.('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : mode;
  return resolved === 'light' ? PRESET_THEMES.light : PRESET_THEMES.dark;
}

type NavItem = { label: string };
const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: 'Personal',
    items: [
      { label: 'General' },
      { label: 'Setup & updates' },
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
    items: [{ label: 'Snapshots' }, { label: 'MCP servers' }, { label: 'Browser' }],
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
function ColorSwatch({
  color,
  active,
  onClick,
}: {
  color: string;
  active: boolean;
  onClick: () => void;
}) {
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

function ModeButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ElementType;
  label: string;
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

function Slider({
  label,
  sub,
  value,
  min,
  max,
  onChange,
  suffix = '',
}: {
  label: string;
  sub?: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  suffix?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 border-b border-droid-border">
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
        <span className="font-mono text-[11px] text-droid-text-muted w-8 text-right">
          {value}
          {suffix}
        </span>
      </div>
    </div>
  );
}

function Toggle({
  label,
  sub,
  checked,
  onChange,
}: {
  label: string;
  sub?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-droid-border">
      <div>
        <div className="text-[13px] text-droid-text">{label}</div>
        {sub && <div className="text-[11px] text-droid-text-muted">{sub}</div>}
      </div>
      <button
        onClick={() => onChange(!checked)}
        className={`w-10 h-6 rounded-full transition-colors shrink-0 flex items-center p-0.5 ${checked ? 'bg-droid-accent' : 'bg-droid-border'}`}
      >
        <span
          className={`w-5 h-5 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-4' : 'translate-x-0'}`}
        />
      </button>
    </div>
  );
}

function DiffPreview() {
  return (
    <div className="rounded-lg border border-droid-border overflow-hidden font-mono text-[11px] leading-5">
      <div className="px-3 py-1.5 bg-droid-elevated border-b border-droid-border text-droid-text-muted">
        themePreview.ts
      </div>
      <div className="px-3 py-1.5">
        <div style={{ backgroundColor: 'rgba(176,106,74,0.12)', color: 'var(--droid-orange)' }}>
          − accent: "#ff5d2e",
        </div>
        <div style={{ backgroundColor: 'rgba(106,138,106,0.12)', color: 'var(--droid-green)' }}>
          + accent: "#ee6018",
        </div>
        <div style={{ backgroundColor: 'rgba(176,106,74,0.12)', color: 'var(--droid-orange)' }}>
          − surface: "#181818",
        </div>
        <div style={{ backgroundColor: 'rgba(106,138,106,0.12)', color: 'var(--droid-green)' }}>
          + surface: "#111111",
        </div>
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
  return (
    <div className="text-[11px] font-medium text-droid-text-muted uppercase tracking-wider mb-2 mt-1">
      {children}
    </div>
  );
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
    <div className="max-w-2xl mx-auto">
      <SectionTitle title="Appearance" sub="Tune the look and feel of Mission Control." />

      {/* Theme mode + preview */}
      <div className="rounded-xl border border-droid-border bg-droid-surface p-4 mb-6">
        <div className="flex items-start justify-between mb-3">
          <div>
            <div className="text-[13px] text-droid-text">Theme</div>
            <div className="text-[11px] text-droid-text-muted">
              Use light, dark, or match your system
            </div>
          </div>
          <div className="flex gap-1">
            <ModeButton
              active={theme.mode === 'light'}
              onClick={() => updateTheme({ mode: 'light', ...paletteForMode('light') })}
              icon={Sun}
              label="Light"
            />
            <ModeButton
              active={theme.mode === 'dark'}
              onClick={() => updateTheme({ mode: 'dark', ...paletteForMode('dark') })}
              icon={Moon}
              label="Dark"
            />
            <ModeButton
              active={theme.mode === 'system'}
              onClick={() => updateTheme({ mode: 'system', ...paletteForMode('system') })}
              icon={Monitor}
              label="System"
            />
          </div>
        </div>
        <DiffPreview />
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
            <div
              className="w-full h-8 rounded-md border border-droid-border"
              style={{ backgroundColor: colors.bg }}
            />
            <span className="text-[10px] text-droid-text-muted capitalize">{name}</span>
          </button>
        ))}
      </div>

      {/* Colors */}
      <GroupLabel>Colors</GroupLabel>
      <div className="rounded-xl border border-droid-border bg-droid-surface p-4 mb-6">
        <div className="space-y-3">
          <ColorField
            label="Accent"
            description="Highlights, active states, send button & design-mode controls"
            value={theme.accent}
            onChange={(v) => updateTheme({ accent: v })}
          />
          <ColorField
            label="App background"
            description="The main window behind everything"
            value={theme.bg}
            onChange={(v) => updateTheme({ bg: v })}
          />
          <ColorField
            label="Text color"
            description="Default color for all text"
            value={theme.fg}
            onChange={(v) => updateTheme({ fg: v })}
          />
          <ColorField
            label="Panel background"
            description="Sidebar, cards and raised surfaces"
            value={theme.surface}
            onChange={(v) => updateTheme({ surface: v })}
          />
          <ColorField
            label="Borders"
            description="Dividers and outlines between sections"
            value={theme.border}
            onChange={(v) => updateTheme({ border: v })}
          />
        </div>
        <div className="mt-3.5 pt-3.5 border-t border-droid-border">
          <div className="text-[10.5px] text-droid-text-muted mb-2">Quick accents</div>
          <div className="flex flex-wrap gap-1.5">
            {PRESET_ACCENTS.map((c) => (
              <ColorSwatch
                key={c}
                color={c}
                active={theme.accent.toLowerCase() === c.toLowerCase()}
                onClick={() => updateTheme({ accent: c })}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Typography + behavior */}
      <GroupLabel>Typography & behavior</GroupLabel>
      <div className="rounded-xl border border-droid-border bg-droid-surface px-4 [&>*:last-child]:border-b-0">
        <div className="flex items-center justify-between py-2.5 border-b border-droid-border">
          <div>
            <div className="text-[13px] text-droid-text">UI font</div>
            <div className="text-[11px] text-droid-text-muted">
              Typeface for the whole app (defaults to your OS font)
            </div>
          </div>
          <Dropdown
            value={theme.uiFont}
            width="w-44"
            options={UI_FONTS.map((f) => ({ value: f.id, label: f.label }))}
            onChange={(v) => updateTheme({ uiFont: v })}
          />
        </div>
        <Slider
          label="UI font size"
          sub="Base size used for the Mission Control UI"
          value={theme.uiFontSize}
          min={12}
          max={18}
          onChange={(v) => updateTheme({ uiFontSize: v })}
          suffix="px"
        />
        <Slider
          label="Code font size"
          sub="Base size for code across chats and diffs"
          value={theme.codeFontSize}
          min={10}
          max={16}
          onChange={(v) => updateTheme({ codeFontSize: v })}
          suffix="px"
        />
        <Slider
          label="Contrast"
          sub="Adjust overall UI contrast"
          value={theme.contrast}
          min={40}
          max={100}
          onChange={(v) => updateTheme({ contrast: v })}
        />
        <Toggle
          label="Translucent sidebar"
          sub="Blur and lighten the sidebar surface"
          checked={theme.translucentSidebar}
          onChange={(v) => updateTheme({ translucentSidebar: v })}
        />
      </div>
    </div>
  );
}

/* ── compaction token limit helpers ── */
// Format a raw token count for display: 200000 → "200K", 1500000 → "1.5M".
function formatTokenLimit(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(2))}M`;
  if (n >= 1_000) return `${Number((n / 1_000).toFixed(2))}K`;
  return String(n);
}

const TOKEN_PRESETS = [
  100_000, 200_000, 250_000, 300_000, 400_000, 500_000, 600_000, 700_000, 800_000, 900_000,
  1_000_000,
];
const RECOMMENDED_LIMIT = 250_000;

// Themed preset picker for the context window. Empty/"Factory default" lets
// Droid Control use Factory's model-dependent policy.
function TokenLimitSelect({
  value,
  onSelect,
  width = 'w-40',
}: {
  value?: number;
  onSelect: (n?: number) => void;
  width?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const label = value === undefined ? 'Factory default' : formatTokenLimit(value);

  const choose = (n?: number) => {
    onSelect(n);
    setOpen(false);
  };

  const Row = ({ n, l, sub }: { n?: number; l: string; sub?: string }) => {
    const active = value === n;
    return (
      <button
        onClick={() => choose(n)}
        className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
          active ? 'bg-droid-elevated' : 'hover:bg-droid-elevated/50'
        }`}
      >
        <span className="flex-1 font-mono text-[12.5px] text-droid-text">{l}</span>
        {sub && <span className="text-[10.5px] text-droid-text-muted">{sub}</span>}
        {active && (
          <Check
            className="w-3.5 h-3.5 shrink-0"
            style={{ color: 'var(--droid-accent)' }}
            strokeWidth={3}
          />
        )}
      </button>
    );
  };

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`${width} flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-[12px] transition-colors ${
          open
            ? 'border-droid-border-hover bg-droid-elevated text-droid-text'
            : 'border-droid-border bg-droid-bg/60 text-droid-text hover:border-droid-border-hover'
        }`}
      >
        <span className="truncate font-mono">{label}</span>
        <ChevronDown
          className={`w-3.5 h-3.5 text-droid-text-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-64 rounded-xl border border-droid-border bg-droid-surface p-2 shadow-2xl shadow-black/50">
          <div className="max-h-72 overflow-y-auto space-y-0.5">
            <Row l="Factory default" sub="model-dependent" />
            {TOKEN_PRESETS.map((n) => (
              <Row
                key={n}
                n={n}
                l={formatTokenLimit(n)}
                sub={n === RECOMMENDED_LIMIT ? 'recommended' : undefined}
              />
            ))}
          </div>
          <p className="mt-2 border-t border-droid-border px-1.5 pt-2 text-[10.5px] leading-[1.5] text-droid-text-muted">
            If a model's maximum context is lower than the selected value, the session uses that
            model maximum.
          </p>
        </div>
      )}
    </div>
  );
}

/* ── generic in-app dropdown (replaces native <select>) ── */
type DropdownOption = { value: string; label: string; icon?: React.ReactNode };
function Dropdown({
  value,
  options,
  onChange,
  placeholder = 'Select…',
  triggerIcon,
  width = 'w-44',
  align = 'right',
}: {
  value: string;
  options: DropdownOption[];
  onChange: (v: string) => void;
  placeholder?: string;
  triggerIcon?: React.ReactNode;
  width?: string;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const sel = options.find((o) => o.value === value);

  return (
    <div className={`relative ${width === 'w-full' ? 'w-full' : 'shrink-0'}`} ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`${width} flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-[12px] transition-colors ${
          open
            ? 'border-droid-border-hover bg-droid-elevated text-droid-text'
            : 'border-droid-border bg-droid-bg/60 text-droid-text hover:border-droid-border-hover'
        }`}
      >
        <span className="flex min-w-0 items-center gap-2">
          {triggerIcon ?? sel?.icon}
          <span className="truncate">{sel?.label ?? placeholder}</span>
        </span>
        <ChevronDown
          className={`w-3.5 h-3.5 shrink-0 text-droid-text-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          className={`absolute ${align === 'right' ? 'right-0' : 'left-0'} top-full z-50 mt-1.5 min-w-full rounded-xl border border-droid-border bg-droid-surface p-2 shadow-2xl shadow-black/50`}
        >
          <div className="max-h-72 overflow-y-auto space-y-0.5">
            {options.map((o) => {
              const active = o.value === value;
              return (
                <button
                  key={o.value}
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                    active ? 'bg-droid-elevated' : 'hover:bg-droid-elevated/50'
                  }`}
                >
                  {o.icon}
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-droid-text">
                    {o.label}
                  </span>
                  {active && (
                    <Check
                      className="w-3.5 h-3.5 shrink-0"
                      style={{ color: 'var(--droid-accent)' }}
                      strokeWidth={3}
                    />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── compaction model picker (collapsed trigger + searchable popover) ── */
function CompactionModelPicker({
  selected,
  models,
  onSelect,
}: {
  selected: string;
  models: ModelInfo[];
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const isCurrent = selected === 'current-model';
  const selModel = isCurrent ? undefined : models.find((m) => m.id === selected);
  const label = isCurrent ? 'Current model' : (selModel?.displayName ?? selected);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? models.filter(
        (m) => m.displayName.toLowerCase().includes(q) || m.id.toLowerCase().includes(q),
      )
    : models;

  const choose = (id: string) => {
    onSelect(id);
    setOpen(false);
    setQuery('');
  };

  const Option = ({
    id,
    label: l,
    sub,
    current,
  }: {
    id: string;
    label: string;
    sub?: string;
    current?: boolean;
  }) => {
    const active = selected === id;
    return (
      <button
        onClick={() => choose(id)}
        className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
          active ? 'bg-droid-elevated' : 'hover:bg-droid-elevated/50'
        }`}
      >
        {!current && (
          <ModelIcon
            provider={providerOf(
              models.find((m) => m.id === id),
              id,
            )}
            size={16}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] text-droid-text truncate">{l}</div>
          {sub && <div className="text-[10.5px] text-droid-text-muted truncate">{sub}</div>}
        </div>
        {active && (
          <Check
            className="w-3.5 h-3.5 shrink-0"
            style={{ color: 'var(--droid-accent)' }}
            strokeWidth={3}
          />
        )}
      </button>
    );
  };

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[12px] transition-colors ${
          open
            ? 'border-droid-border-hover bg-droid-elevated text-droid-text'
            : 'border-droid-border bg-droid-bg/60 text-droid-text hover:border-droid-border-hover'
        }`}
      >
        {!isCurrent && <ModelIcon provider={providerOf(selModel, selected)} size={14} />}
        <span className="max-w-[160px] truncate">{label}</span>
        <ChevronDown
          className={`w-3.5 h-3.5 text-droid-text-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-72 rounded-xl border border-droid-border bg-droid-surface p-2 shadow-2xl shadow-black/50">
          <div className="mb-2 flex items-center gap-2 h-8 rounded-md bg-droid-bg/60 border border-droid-border px-2.5">
            <Search className="w-3.5 h-3.5 text-droid-text-muted" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models…"
              className="w-full bg-transparent text-[12px] text-droid-text placeholder:text-droid-text-muted focus:outline-none"
            />
          </div>
          <div className="max-h-64 overflow-y-auto space-y-0.5">
            <Option
              id="current-model"
              label="Current model"
              sub="Use whatever model the session runs"
              current
            />
            {filtered.map((m) => (
              <Option key={m.id} id={m.id} label={m.displayName} sub={m.provider} />
            ))}
            {filtered.length === 0 && (
              <div className="px-2.5 py-4 text-center text-[12px] text-droid-text-muted">
                No models match.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── settings row: label + description on the left, control on the right ── */
function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="text-[13px] text-droid-text">{label}</div>
        {description && (
          <div className="text-[11px] text-droid-text-muted mt-0.5">{description}</div>
        )}
      </div>
      {children}
    </div>
  );
}

/* ── general content ── */
function GeneralSection() {
  const { state, dispatch } = useStore();
  const selected = state.compactionModel || 'current-model';

  const setCompaction = (value: string) => {
    dispatch({ type: 'SET_COMPACTION_MODEL_GLOBAL', compactionModel: value });
  };

  const setGlobalLimit = (limit?: number) => {
    dispatch({ type: 'SET_COMPACTION_TOKEN_LIMIT_GLOBAL', limit });
  };

  const setModelLimit = (modelId: string, limit?: number) => {
    dispatch({ type: 'SET_COMPACTION_TOKEN_LIMIT_FOR_MODEL', modelId, limit });
  };

  const overrideEntries = Object.entries(state.compactionTokenLimitPerModel);
  const availableForOverride = state.models.filter(
    (m) => !(m.id in state.compactionTokenLimitPerModel),
  );
  const modelLabel = (id: string) => state.models.find((m) => m.id === id)?.displayName ?? id;

  return (
    <div className="max-w-2xl mx-auto">
      <SectionTitle title="General" sub="Defaults that apply across all chats and missions." />

      <GroupLabel>Composer</GroupLabel>
      <div className="rounded-xl border border-droid-border bg-droid-surface divide-y divide-droid-border mb-8">
        <SettingRow
          label="Enter while working"
          description="Choose what plain Enter does during an active model turn. Cmd/Ctrl+Enter does the opposite."
        >
          <Dropdown
            value={state.liveEnterBehavior}
            width="w-44"
            options={[
              { value: 'queue', label: 'Queue message' },
              { value: 'interrupt', label: 'Send now' },
            ]}
            onChange={(behavior) =>
              dispatch({ type: 'SET_LIVE_ENTER_BEHAVIOR', behavior: behavior as LiveEnterBehavior })
            }
          />
        </SettingRow>
      </div>

      {/* Compaction */}
      <GroupLabel>Compaction</GroupLabel>
      <div className="rounded-xl border border-droid-border bg-droid-surface divide-y divide-droid-border mb-8">
        <SettingRow
          label="Compaction model"
          description="Model that summarizes a conversation when it is compacted."
        >
          <CompactionModelPicker
            selected={selected}
            models={state.models}
            onSelect={setCompaction}
          />
        </SettingRow>
        <SettingRow
          label="Context window"
          description="Displayed context budget for the session; Factory compacts before it fills."
        >
          <TokenLimitSelect value={state.compactionTokenLimit} onSelect={setGlobalLimit} />
        </SettingRow>
      </div>

      {/* Per-model context windows */}
      <GroupLabel>Per-model context windows</GroupLabel>
      <p className="text-[12px] text-droid-text-muted mb-3">
        Override the context window for specific models.
      </p>
      <div className="rounded-xl border border-droid-border bg-droid-surface p-3">
        {overrideEntries.length === 0 && (
          <div className="text-[12px] text-droid-text-muted px-1 py-1.5">
            No overrides — every model uses the default context window.
          </div>
        )}

        <div className="space-y-1.5">
          {overrideEntries.map(([id, limit]) => (
            <div
              key={id}
              className="flex items-center gap-2.5 rounded-lg border border-droid-border bg-droid-bg/40 px-2.5 py-2"
            >
              <ModelIcon
                provider={providerOf(
                  state.models.find((m) => m.id === id),
                  id,
                )}
                size={16}
              />
              <span className="text-[12px] text-droid-text truncate flex-1">{modelLabel(id)}</span>
              <TokenLimitSelect value={limit} onSelect={(n) => setModelLimit(id, n)} width="w-32" />
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

        {availableForOverride.length > 0 && (
          <div className="mt-2.5">
            <Dropdown
              value=""
              placeholder="Add a model override…"
              triggerIcon={<Plus className="w-3.5 h-3.5 text-droid-text-muted" />}
              width="w-full"
              align="left"
              options={availableForOverride.map((m) => ({
                value: m.id,
                label: m.displayName,
                icon: <ModelIcon provider={providerOf(m, m.id)} size={16} />,
              }))}
              onChange={(id) => setModelLimit(id, state.compactionTokenLimit ?? 200_000)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function Switch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`w-10 h-6 rounded-full transition-colors shrink-0 flex items-center p-0.5 ${checked ? 'bg-droid-accent' : 'bg-droid-border'}`}
    >
      <span
        className={`w-5 h-5 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-4' : 'translate-x-0'}`}
      />
    </button>
  );
}

function SetupSection({ onClose }: { onClose: () => void }) {
  const onboard = useOnboarding();
  const { env, onboarding, installing } = onboard;
  const [appVersion, setAppVersion] = useState('');
  const [update, setUpdate] = useState<AppUpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    void getAppVersion().then(setAppVersion);
  }, []);

  const cliAuto = onboarding?.cliAutoUpdate ?? true;
  const appAuto = onboarding?.appAutoUpdate ?? true;
  const signedIn = Boolean(env?.auth.loginPresent || env?.auth.apiKeyConfigured);

  const runCheck = async () => {
    setChecking(true);
    // Publish to the shared store so a found update also lights up the sidebar
    // pill, while keeping the full result locally for the up-to-date/error text.
    const info = await refreshAppUpdate();
    setUpdate(info);
    setChecking(false);
  };

  // The main process returns an empty `latest` when the manifest fetch fails;
  // surface that as an error rather than a successful "Up to date" result.
  const updateStatus = !update
    ? `Installed v${appVersion}`
    : update.updateAvailable
      ? `${update.latest} available`
      : update.latest
        ? 'Up to date'
        : "Couldn't check for updates";

  return (
    <div className="max-w-2xl mx-auto">
      <SectionTitle
        title="Setup & updates"
        sub="Manage the Droid CLI, your sign-in, and app updates."
      />

      <GroupLabel>Droid CLI</GroupLabel>
      <div className="rounded-xl border border-droid-border bg-droid-surface divide-y divide-droid-border mb-8">
        <SettingRow
          label="CLI status"
          description={env?.cli.present ? env.cli.path : 'Not detected on this machine.'}
        >
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-mono text-droid-text-muted">
              {env?.cli.present ? (env.cli.version ?? 'installed') : 'missing'}
            </span>
            <button
              onClick={() => onboard.update(onboarding?.installChannel)}
              disabled={!!installing || !env?.cli.present}
              className="px-2.5 h-7 rounded-md bg-droid-elevated border border-droid-border text-[12px] text-droid-text hover:border-droid-border-hover transition-colors disabled:opacity-40"
            >
              {installing === 'update' ? 'Updating…' : 'Update'}
            </button>
          </div>
        </SettingRow>
        <SettingRow label="Keep the CLI up to date" description="Updates silently on launch.">
          <Switch checked={cliAuto} onChange={(v) => void onboard.patch({ cliAutoUpdate: v })} />
        </SettingRow>
        <SettingRow
          label="Sign-in"
          description={
            signedIn
              ? 'Connected to Factory.'
              : env?.cli.present
                ? 'Sign in so models can run.'
                : 'Install the Droid CLI before signing in.'
          }
        >
          {signedIn ? (
            <span className="text-[12px] text-droid-green">Signed in</span>
          ) : (
            <button
              onClick={() => onboard.login()}
              disabled={!env?.cli.present}
              title={env?.cli.present ? undefined : 'The Droid CLI must be installed first.'}
              className="px-2.5 h-7 rounded-md bg-droid-elevated border border-droid-border text-[12px] text-droid-text hover:border-droid-border-hover transition-colors disabled:opacity-40"
            >
              Sign in
            </button>
          )}
        </SettingRow>
      </div>

      <GroupLabel>DROIDEX app</GroupLabel>
      <div className="rounded-xl border border-droid-border bg-droid-surface divide-y divide-droid-border mb-8">
        <SettingRow label="Current version" description={updateStatus}>
          <div className="flex items-center gap-2">
            <button
              onClick={runCheck}
              disabled={checking}
              className="px-2.5 h-7 rounded-md bg-droid-elevated border border-droid-border text-[12px] text-droid-text hover:border-droid-border-hover transition-colors disabled:opacity-40"
            >
              {checking ? 'Checking…' : 'Check for updates'}
            </button>
            {update?.updateAvailable && (
              <button
                onClick={() => {
                  void startAppUpdate(update);
                }}
                className="px-2.5 h-7 rounded-md bg-droid-accent text-white text-[12px] hover:opacity-90 transition-opacity"
              >
                Restart & update
              </button>
            )}
          </div>
        </SettingRow>
        <SettingRow label="Auto-update DROIDEX" description="Installs new builds and restarts.">
          <Switch checked={appAuto} onChange={(v) => void onboard.patch({ appAutoUpdate: v })} />
        </SettingRow>
      </div>

      <GroupLabel>Onboarding</GroupLabel>
      <div className="rounded-xl border border-droid-border bg-droid-surface divide-y divide-droid-border">
        <SettingRow label="Run setup again" description="Re-open the first-run setup tour.">
          <button
            onClick={() => {
              window.dispatchEvent(new CustomEvent('droid:open-onboarding'));
              onClose();
            }}
            className="px-2.5 h-7 rounded-md bg-droid-elevated border border-droid-border text-[12px] text-droid-text hover:border-droid-border-hover transition-colors"
          >
            Run setup
          </button>
        </SettingRow>
      </div>
    </div>
  );
}

function PlaceholderSection({ title }: { title: string }) {
  return (
    <div className="max-w-2xl mx-auto">
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
                    <div className="text-[10px] font-medium text-droid-text-muted uppercase tracking-wider px-2 mb-1">
                      {group}
                    </div>
                    {filtered.map(({ label }) => (
                      <button
                        key={label}
                        onClick={() => setActive(label)}
                        className={`flex items-center w-full px-2 h-8 rounded-md text-[12px] transition-colors ${
                          active === label
                            ? 'bg-droid-elevated text-droid-text'
                            : 'text-droid-text-secondary hover:text-droid-text hover:bg-droid-elevated/50'
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
              ) : active === 'Setup & updates' ? (
                <SetupSection onClose={close} />
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
  // separators read as gentle hairlines rather than hard lines. Dark themes need
  // a stronger blend: at low luminance the same edge reads as a harsh outline, so
  // we push it closer to the background to keep the subtle look light mode has.
  const bgIsDark = colorLuminance(theme.bg) < 0.4;
  root.style.setProperty('--droid-border', mixHex(theme.border, theme.bg, bgIsDark ? 0.72 : 0.6));
  root.style.setProperty(
    '--droid-border-hover',
    mixHex(theme.border, theme.bg, bgIsDark ? 0.4 : 0.2),
  );
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
  // Light surfaces sit over a dark macOS vibrancy material, so a low-opacity
  // fill plus a strong saturation boost lets the wallpaper bleed through as a
  // muddy tint. Keep light themes mostly opaque with gentle saturation so the
  // sidebar stays a clean frosted white; dark themes can show more through.
  root.setAttribute('data-translucent', theme.translucentSidebar ? 'true' : 'false');
  const sidebarAlpha = bgIsDark ? '99' : 'f2';
  const sidebarSaturate = bgIsDark ? 'saturate(150%)' : 'saturate(108%)';
  root.style.setProperty(
    '--sidebar-bg',
    theme.translucentSidebar ? `${theme.surface}${sidebarAlpha}` : theme.surface,
  );
  root.style.setProperty(
    '--sidebar-blur',
    theme.translucentSidebar ? `blur(6px) ${sidebarSaturate}` : 'none',
  );

  // Apply contrast as a filter only below 100% so it never creates a stacking
  // context that would defeat the sidebar's backdrop blur at the default value.
  const rootEl = document.getElementById('root');
  if (rootEl) rootEl.style.filter = theme.contrast >= 100 ? '' : `contrast(${theme.contrast}%)`;
}

/* ── tiny color utils ── */
// Relative luminance (0 = black, 1 = white) used to tell dark themes from light.
function colorLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

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
  const parse = (h: string) => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];
  const [r1, g1, b1] = parse(hex);
  const [r2, g2, b2] = parse(target);
  const mix = (a: number, b: number) => Math.round(a * (1 - t) + b * t);
  const toHex = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  return `#${toHex(mix(r1, r2))}${toHex(mix(g1, g2))}${toHex(mix(b1, b2))}`;
}
