import {
  useStore,
  type DiffStyle,
  type DiffViewMode,
  type ImagePasteQuality,
  type LiveEnterBehavior,
} from '../hooks/useStore';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronLeft, ChevronDown, Search, Sun, Moon, Monitor, Check, X, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ColorField } from './ColorPicker';
import AutonomySelector from './AutonomySelector';
import { ModelIcon, providerOf } from './ModelIcon';
import type { ModelInfo } from '../types/bridge';
import { useOnboarding } from '../hooks/useOnboarding';
import { Switch } from './Switch';
import { getAppVersion, type AppUpdateInfo } from '../lib/onboarding';
import { refreshAppUpdate, startAppUpdate } from '../lib/appUpdate';
import { applyTheme, paletteForMode, UI_FONTS, PRESET_THEMES } from '../lib/theme';
import { DiagnosticsSettings } from './DiagnosticsSettings';
import { NotificationsSettings } from './NotificationsSettings';
import { WorktreesSettings } from './WorktreesSettings';
import {
  bestTabForQuery,
  searchSettings,
  tabMatchesQuery,
  type SettingsSearchHit,
} from '../lib/settingsSearch';

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

interface NavItem {
  label: string;
}
const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: 'Personal',
    items: [
      { label: 'General' },
      { label: 'Setup & updates' },
      { label: 'Profile' },
      { label: 'Appearance' },
      { label: 'Notifications' },
      { label: 'Configuration' },
      { label: 'Personalization' },
      { label: 'Keyboard shortcuts' },
      { label: 'Usage & billing' },
      { label: 'Privacy & diagnostics' },
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
      type="button"
      aria-pressed={active}
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
          onChange={(e) => {
            onChange(Number(e.target.value));
          }}
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
        onClick={() => {
          onChange(!checked);
        }}
        className={`w-10 h-6 rounded-full transition-colors shrink-0 flex items-center p-0.5 ${checked ? 'bg-droid-accent' : 'bg-droid-border'}`}
      >
        <span
          className={`w-5 h-5 rounded-full shadow-sm transition-transform ${checked ? 'bg-droid-bg translate-x-4' : 'bg-droid-text-secondary translate-x-0'}`}
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
      <div className="py-1.5 text-droid-text-secondary">
        <div className="diff-preview-line diff-preview-del">− accent: &quot;#ff5d2e&quot;,</div>
        <div className="diff-preview-line diff-preview-add">+ accent: &quot;#f2f2f2&quot;,</div>
        <div className="diff-preview-line diff-preview-del">− surface: &quot;#181818&quot;,</div>
        <div className="diff-preview-line diff-preview-add">+ surface: &quot;#111111&quot;,</div>
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
export function AppearanceSection() {
  const { state, dispatch } = useStore();
  const theme = state.theme;
  const updateTheme = (patch: Partial<typeof theme>) => {
    dispatch({ type: 'SET_THEME', theme: patch });
    applyTheme({ ...theme, ...patch });
  };

  return (
    <div className="max-w-2xl mx-auto">
      <SectionTitle title="Appearance" sub="Tune the look and feel of Droid Control." />

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
              onClick={() => {
                updateTheme({ mode: 'light', ...paletteForMode('light') });
              }}
              icon={Sun}
              label="Light"
            />
            <ModeButton
              active={theme.mode === 'dark'}
              onClick={() => {
                updateTheme({ mode: 'dark', ...paletteForMode('dark') });
              }}
              icon={Moon}
              label="Dark"
            />
            <ModeButton
              active={theme.mode === 'system'}
              onClick={() => {
                updateTheme({ mode: 'system', ...paletteForMode('system') });
              }}
              icon={Monitor}
              label="System"
            />
          </div>
        </div>
        <DiffPreview />
      </div>

      <div className="rounded-xl border border-droid-border bg-droid-surface p-4 mb-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[13px] text-droid-text">App icon</div>
            <div className="text-[11px] text-droid-text-muted">
              Match the system, or pick the light or dark DROIDEX icon
            </div>
          </div>
          <div className="flex gap-1" role="group" aria-label="App icon">
            <ModeButton
              active={theme.appIconMode === 'light'}
              onClick={() => {
                updateTheme({ appIconMode: 'light' });
              }}
              icon={Sun}
              label="Light"
            />
            <ModeButton
              active={theme.appIconMode === 'dark'}
              onClick={() => {
                updateTheme({ appIconMode: 'dark' });
              }}
              icon={Moon}
              label="Dark"
            />
            <ModeButton
              active={theme.appIconMode === 'system'}
              onClick={() => {
                updateTheme({ appIconMode: 'system' });
              }}
              icon={Monitor}
              label="System"
            />
          </div>
        </div>
      </div>

      {/* Presets */}
      <GroupLabel>Presets</GroupLabel>
      <div className="grid grid-cols-4 gap-2 mb-6">
        {Object.entries(PRESET_THEMES).map(([name, colors]) => (
          <button
            key={name}
            onClick={() => {
              updateTheme(colors);
            }}
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
            onChange={(v) => {
              updateTheme({ accent: v });
            }}
          />
          <ColorField
            label="App background"
            description="The main window behind everything"
            value={theme.bg}
            onChange={(v) => {
              updateTheme({ bg: v });
            }}
          />
          <ColorField
            label="Text color"
            description="Default color for all text"
            value={theme.fg}
            onChange={(v) => {
              updateTheme({ fg: v });
            }}
          />
          <ColorField
            label="Panel background"
            description="Sidebar, cards and raised surfaces"
            value={theme.surface}
            onChange={(v) => {
              updateTheme({ surface: v });
            }}
          />
          <ColorField
            label="Borders"
            description="Dividers and outlines between sections"
            value={theme.border}
            onChange={(v) => {
              updateTheme({ border: v });
            }}
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
                onClick={() => {
                  updateTheme({ accent: c });
                }}
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
            onChange={(v) => {
              updateTheme({ uiFont: v });
            }}
          />
        </div>
        <Slider
          label="UI font size"
          sub="Base size used across the Droid Control UI"
          value={theme.uiFontSize}
          min={12}
          max={18}
          onChange={(v) => {
            updateTheme({ uiFontSize: v });
          }}
          suffix="px"
        />
        <Slider
          label="Code font size"
          sub="Base size for code across chats and diffs"
          value={theme.codeFontSize}
          min={10}
          max={16}
          onChange={(v) => {
            updateTheme({ codeFontSize: v });
          }}
          suffix="px"
        />
        <Slider
          label="Contrast"
          sub="Adjust overall UI contrast"
          value={theme.contrast}
          min={40}
          max={100}
          onChange={(v) => {
            updateTheme({ contrast: v });
          }}
        />
        <Toggle
          label="Translucent sidebar"
          sub="Blur and lighten the sidebar surface"
          checked={theme.translucentSidebar}
          onChange={(v) => {
            updateTheme({ translucentSidebar: v });
          }}
        />
      </div>
    </div>
  );
}

/* ── compaction token limit helpers ── */
// Format a raw token count for display: 200000 → "200K", 1500000 → "1.5M".
function formatTokenLimit(n: number): string {
  if (n >= 1_000_000) return `${String(Number((n / 1_000_000).toFixed(2)))}M`;
  if (n >= 1_000) return `${String(Number((n / 1_000).toFixed(2)))}K`;
  return String(n);
}

const TOKEN_PRESETS = [
  100_000, 200_000, 250_000, 300_000, 400_000, 500_000, 600_000, 700_000, 800_000, 900_000,
  1_000_000,
];
const RECOMMENDED_LIMIT = 250_000;

// Themed preset picker for compaction token limits. Empty/"Factory default"
// lets Droid use its model-dependent compaction threshold.
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
        onClick={() => {
          choose(n);
        }}
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
        onClick={() => {
          setOpen((v) => !v);
        }}
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
            If a model&apos;s context window is lower than the selected value, the session starts
            with the lower effective limit.
          </p>
        </div>
      )}
    </div>
  );
}

/* ── generic in-app dropdown (replaces native <select>) ── */
interface DropdownOption {
  value: string;
  label: string;
  icon?: React.ReactNode;
}
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
        onClick={() => {
          setOpen((v) => !v);
        }}
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
        onClick={() => {
          choose(id);
        }}
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
        onClick={() => {
          setOpen((v) => !v);
        }}
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
              onChange={(e) => {
                setQuery(e.target.value);
              }}
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
  const defaultLimitLabel =
    state.compactionTokenLimit !== undefined
      ? `the ${formatTokenLimit(state.compactionTokenLimit)}-token default limit`
      : "Factory's model-dependent default limit";

  return (
    <div className="max-w-2xl mx-auto">
      <SectionTitle
        title="General"
        sub="Defaults that apply across chats and Mission Control sessions."
      />

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
            onChange={(behavior) => {
              dispatch({
                type: 'SET_LIVE_ENTER_BEHAVIOR',
                behavior: behavior as LiveEnterBehavior,
              });
            }}
          />
        </SettingRow>
        <SettingRow
          label="Image paste quality"
          description="How pasted or dropped images are encoded for the model. Original keeps the exact pixels; smaller tiers save context tokens."
        >
          <Dropdown
            value={state.imagePasteQuality}
            width="w-52"
            options={[
              { value: 'original', label: 'Original · exact bytes' },
              { value: 'high', label: 'High · 2048px PNG' },
              { value: 'compact', label: 'Compact · 1568px JPEG' },
            ]}
            onChange={(quality) => {
              dispatch({
                type: 'SET_IMAGE_PASTE_QUALITY',
                quality: quality as ImagePasteQuality,
              });
            }}
          />
        </SettingRow>
      </div>

      <GroupLabel>Diff display</GroupLabel>
      <div className="rounded-xl border border-droid-border bg-droid-surface divide-y divide-droid-border mb-8">
        <SettingRow
          label="Diff view"
          description="How file diffs render in the Review tab — one column or side-by-side."
        >
          <Dropdown
            value={state.diffView}
            width="w-44"
            options={[
              { value: 'unified', label: 'Unified' },
              { value: 'split', label: 'Split' },
            ]}
            onChange={(mode) => {
              dispatch({ type: 'SET_DIFF_VIEW', mode: mode as DiffViewMode });
            }}
          />
        </SettingRow>
        <SettingRow
          label="Diff theme"
          description="Choose a softer GitHub-style tint or a stronger focused change treatment."
        >
          <Dropdown
            value={state.theme.diffStyle}
            width="w-44"
            options={[
              { value: 'soft', label: 'Soft contrast' },
              { value: 'focused', label: 'Focused contrast' },
            ]}
            onChange={(value) => {
              const diffStyle = value as DiffStyle;
              const theme = { ...state.theme, diffStyle };
              dispatch({ type: 'SET_THEME', theme: { diffStyle } });
              applyTheme(theme);
            }}
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
          label="Token limit"
          description="Compact once a conversation passes this size. Empty uses Factory's model-dependent default."
        >
          <TokenLimitSelect value={state.compactionTokenLimit} onSelect={setGlobalLimit} />
        </SettingRow>
      </div>

      {/* Per-model token limits */}
      <GroupLabel>Per-model token limits</GroupLabel>
      <p className="text-[12px] text-droid-text-muted mb-3">
        Override the compaction limit for specific models. Models without an override use{' '}
        {defaultLimitLabel}.
      </p>
      <div className="rounded-xl border border-droid-border bg-droid-surface p-3">
        {overrideEntries.length === 0 && (
          <div className="text-[12px] text-droid-text-muted px-1 py-1.5">
            No overrides — every model uses {defaultLimitLabel}.
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
              <TokenLimitSelect
                value={limit}
                onSelect={(n) => {
                  setModelLimit(id, n);
                }}
                width="w-32"
              />
              <button
                onClick={() => {
                  setModelLimit(id, undefined);
                }}
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
              onChange={(id) => {
                setModelLimit(id, state.compactionTokenLimit ?? 200_000);
              }}
            />
          </div>
        )}
      </div>
    </div>
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
  const signedIn = Boolean(env?.auth.loginPresent) || Boolean(env?.auth.apiKeyConfigured);

  const runCheck = async () => {
    setChecking(true);
    // Publish to the shared store so a found update also lights up the sidebar
    // pill, while keeping the full result locally for the up-to-date/error text.
    const info = await refreshAppUpdate({ interactive: true, automaticChecks: appAuto });
    setUpdate(info);
    setChecking(false);
  };

  // Sparkle owns its asynchronous result window. electron-updater returns the
  // manifest version directly, including an empty value when its fetch fails.
  const updateStatus = !update
    ? `Installed v${appVersion}`
    : update.installMode === 'sparkle'
      ? 'Update window opened'
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
              onClick={() => {
                onboard.update(onboarding?.installChannel);
              }}
              disabled={!!installing || !env?.cli.present}
              className="px-2.5 h-7 rounded-md bg-droid-elevated border border-droid-border text-[12px] text-droid-text hover:border-droid-border-hover transition-colors disabled:opacity-40"
            >
              {installing === 'update' ? 'Updating…' : 'Update'}
            </button>
          </div>
        </SettingRow>
        <SettingRow label="Keep the CLI up to date" description="Updates silently on launch.">
          <Switch
            label="Keep the CLI up to date"
            checked={cliAuto}
            onChange={(v) => void onboard.patch({ cliAutoUpdate: v })}
          />
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
              onClick={onboard.refreshEnv}
              disabled={!env?.cli.present}
              title={env?.cli.present ? undefined : 'The Droid CLI must be installed first.'}
              className="px-2.5 h-7 rounded-md bg-droid-elevated border border-droid-border text-[12px] text-droid-text hover:border-droid-border-hover transition-colors disabled:opacity-40"
            >
              Refresh status
            </button>
          )}
        </SettingRow>
      </div>

      <GroupLabel>DROIDEX app</GroupLabel>
      <div className="rounded-xl border border-droid-border bg-droid-surface divide-y divide-droid-border mb-8">
        <SettingRow label="Current version" description={updateStatus}>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                void runCheck();
              }}
              disabled={checking}
              className="px-2.5 h-7 rounded-md bg-droid-elevated border border-droid-border text-[12px] text-droid-text hover:border-droid-border-hover transition-colors disabled:opacity-40"
            >
              {checking ? 'Checking…' : 'Check for updates'}
            </button>
            {update?.updateAvailable && update.installMode !== 'sparkle' && (
              <button
                onClick={() => {
                  void startAppUpdate(update);
                }}
                className="px-2.5 h-7 rounded-md bg-droid-accent text-droid-bg text-[12px] hover:opacity-90 transition-opacity"
              >
                Download update…
              </button>
            )}
          </div>
        </SettingRow>
        <SettingRow
          label="Check for DROIDEX updates"
          description="Checks automatically. Installation always requires your approval."
        >
          <Switch
            label="Check for DROIDEX updates"
            checked={appAuto}
            onChange={(v) => void onboard.patch({ appAutoUpdate: v })}
          />
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

/* ── configuration content ── */
function ConfigurationSection() {
  const { state, dispatch } = useStore();
  return (
    <div className="max-w-2xl mx-auto">
      <SectionTitle title="Configuration" />
      <GroupLabel>Sessions</GroupLabel>
      <div className="rounded-xl border border-droid-border bg-droid-surface divide-y divide-droid-border mb-8">
        <SettingRow
          label="Default autonomy"
          description="How much new sessions may do without asking. The composer can override it for a single session."
        >
          <AutonomySelector
            scope="settings"
            value={state.defaultAutonomy}
            placement="down"
            onSelect={(level) => {
              dispatch({ type: 'SET_DEFAULT_AUTONOMY', autonomy: level });
            }}
          />
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

/** Soft jump list above the active section while a search is active. */
function SettingsSearchResults({
  hits,
  activeTab,
  onOpen,
}: {
  hits: SettingsSearchHit[];
  activeTab: string;
  onOpen: (hit: SettingsSearchHit) => void;
}) {
  return (
    <div className="mx-auto mb-8 max-w-2xl">
      <div className="mb-2.5 px-0.5 text-[11px] text-droid-text-muted">
        {hits.length === 1 ? '1 match' : `${String(hits.length)} matches`}
      </div>
      <div className="flex flex-col gap-1">
        {hits.map((hit) => {
          const onActiveTab = hit.tab === activeTab;
          return (
            <button
              key={`${hit.tab}::${hit.label}`}
              type="button"
              onClick={() => {
                onOpen(hit);
              }}
              className={`group flex w-full items-center justify-between gap-3 rounded-2xl px-3.5 py-2.5 text-left transition-colors ${
                onActiveTab
                  ? 'bg-droid-active/70 text-droid-text'
                  : 'text-droid-text-secondary hover:bg-droid-elevated/45 hover:text-droid-text'
              }`}
            >
              <div className="min-w-0">
                <div className="truncate text-[13px] font-medium tracking-tight text-droid-text">
                  {hit.label}
                </div>
                <div className="mt-0.5 truncate text-[11px] text-droid-text-muted">{hit.tab}</div>
              </div>
              <span
                className={`shrink-0 text-[11px] transition-opacity ${
                  onActiveTab
                    ? 'text-droid-text-muted'
                    : 'text-droid-text-muted/0 group-hover:text-droid-text-muted'
                }`}
              >
                {onActiveTab ? 'Here' : 'Open'}
              </span>
            </button>
          );
        })}
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
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [dispatch]);

  // Content-aware search: typing "play sound" jumps to Notifications so the
  // matching controls are on screen (nav filter alone only matched tab titles).
  useEffect(() => {
    const next = bestTabForQuery(query);
    if (next) setActive(next);
  }, [query]);

  const close = () => {
    dispatch({ type: 'TOGGLE_SETTINGS' });
  };
  const q = query.trim();
  const hits = q ? searchSettings(q) : [];

  let content: React.ReactNode;
  switch (active) {
    case 'Appearance':
      content = <AppearanceSection />;
      break;
    case 'General':
      content = <GeneralSection />;
      break;
    case 'Setup & updates':
      content = <SetupSection onClose={close} />;
      break;
    case 'Worktrees':
      content = <WorktreesSettings />;
      break;
    case 'Configuration':
      content = <ConfigurationSection />;
      break;
    case 'Notifications':
      content = <NotificationsSettings highlightQuery={q} />;
      break;
    case 'Privacy & diagnostics':
      content = <DiagnosticsSettings />;
      break;
    default:
      content = <PlaceholderSection title={active} />;
  }

  const openHit = (hit: SettingsSearchHit) => {
    setActive(hit.tab);
  };

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
            <div className="px-3 pb-3">
              <div className="flex h-9 items-center gap-2 rounded-2xl bg-droid-elevated/70 px-3 ring-1 ring-inset ring-droid-border/70 transition-[box-shadow,background-color] focus-within:bg-droid-elevated focus-within:ring-droid-border-hover">
                <Search className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
                <input
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                  }}
                  placeholder="Search settings…"
                  className="w-full bg-transparent text-[12.5px] text-droid-text placeholder:text-droid-text-muted/80 focus:outline-none"
                />
                {q ? (
                  <button
                    type="button"
                    aria-label="Clear search"
                    onClick={() => {
                      setQuery('');
                    }}
                    className="rounded-full p-0.5 text-droid-text-muted transition-colors hover:text-droid-text"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>
            </div>
            <nav className="flex-1 space-y-4 overflow-y-auto px-2.5 pb-3">
              {NAV.map(({ group, items }) => {
                const filtered = items.filter((it) => tabMatchesQuery(it.label, q));
                if (filtered.length === 0) return null;
                return (
                  <div key={group}>
                    <div className="mb-1 px-2.5 text-[10px] font-medium uppercase tracking-wider text-droid-text-muted/80">
                      {group}
                    </div>
                    <div className="flex flex-col gap-0.5">
                      {filtered.map(({ label }) => (
                        <button
                          key={label}
                          onClick={() => {
                            setActive(label);
                          }}
                          className={`flex h-8 w-full items-center rounded-xl px-2.5 text-left text-[12.5px] transition-colors ${
                            active === label
                              ? 'bg-droid-active text-droid-text'
                              : 'text-droid-text-secondary hover:bg-droid-elevated/40 hover:text-droid-text'
                          }`}
                        >
                          <span className="truncate">{label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
              {q && hits.length === 0 && (
                <div className="px-2.5 py-4 text-[12px] leading-relaxed text-droid-text-muted">
                  No matching settings.
                </div>
              )}
            </nav>
          </aside>

          {/* Content */}
          <div className="flex-1 overflow-y-auto">
            <div className="px-10 py-8">
              {q && hits.length > 0 && (
                <SettingsSearchResults hits={hits} activeTab={active} onOpen={openHit} />
              )}
              {content}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* theme application lives in ../lib/theme (imported above) */
