import { useState } from 'react';
import { useStore } from '../hooks/useStore';
import { Plus, Folder, Settings, Zap, GitBranch, Terminal, ArrowRight } from 'lucide-react';
import PaletteShell from './PaletteShell';
import { usePaletteNavigation } from './usePaletteNavigation';

const commands = [
  { id: 'new-thread', label: 'New Thread', shortcut: 'Ctrl+T', icon: Plus, action: 'thread' },
  { id: 'new-mission', label: 'New Mission', shortcut: 'Ctrl+M', icon: Zap, action: 'mission' },
  {
    id: 'switch-project',
    label: 'Switch Project',
    shortcut: 'Ctrl+P',
    icon: Folder,
    action: 'project',
  },
  {
    id: 'toggle-terminal',
    label: 'Toggle Terminal',
    shortcut: 'Ctrl+`',
    icon: Terminal,
    action: 'terminal',
  },
  { id: 'git-status', label: 'Git Status', shortcut: 'Ctrl+G', icon: GitBranch, action: 'git' },
  { id: 'settings', label: 'Settings', shortcut: 'Ctrl+,', icon: Settings, action: 'settings' },
];

export default function CommandPalette() {
  const { dispatch } = useStore();
  const [query, setQuery] = useState('');

  const close = () => {
    dispatch({ type: 'CLOSE_COMMAND_PALETTE' });
  };

  const filtered = commands.filter(
    (c) =>
      c.label.toLowerCase().includes(query.toLowerCase()) || c.id.includes(query.toLowerCase()),
  );

  const runCommand = (cmd: (typeof commands)[0]) => {
    dispatch({ type: 'CLOSE_COMMAND_PALETTE' });
    switch (cmd.action) {
      case 'settings':
        dispatch({ type: 'TOGGLE_SETTINGS' });
        break;
      case 'mission':
        dispatch({ type: 'TOGGLE_MISSION_CONTROL' });
        break;
      // other actions can be wired here
    }
  };

  const { selected, setSelected, handleKeyDown } = usePaletteNavigation(
    query,
    filtered,
    runCommand,
    close,
  );

  return (
    <PaletteShell
      onClose={close}
      query={query}
      onQueryChange={setQuery}
      onKeyDown={handleKeyDown}
      placeholder="Type a command or search..."
      inputAriaLabel="Command palette"
      enterHint="Select"
      footerRight="Droid Control v0.1.0"
    >
      {filtered.length === 0 && (
        <div className="px-4 py-8 text-center text-sm text-droid-text-muted">No commands found</div>
      )}
      {filtered.map((cmd, i) => {
        const Icon = cmd.icon;
        return (
          <button
            key={cmd.id}
            onMouseEnter={() => {
              setSelected(i);
            }}
            onClick={() => {
              runCommand(cmd);
            }}
            className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
              i === selected ? 'bg-droid-accent/10' : 'hover:bg-droid-surface'
            }`}
          >
            <Icon className="w-4 h-4 text-droid-text-muted" />
            <span className="flex-1 text-sm text-droid-text">{cmd.label}</span>
            <span className="text-[10px] text-droid-text-muted font-mono">{cmd.shortcut}</span>
            {i === selected && <ArrowRight className="w-3.5 h-3.5 text-droid-accent" />}
          </button>
        );
      })}
    </PaletteShell>
  );
}
