import { useState, useEffect, useRef } from 'react';
import { useStore } from '../hooks/useStore';
import { motion } from 'framer-motion';
import {
  Search, Plus, Folder, Settings, Zap,
  GitBranch, Terminal, X, ArrowRight
} from 'lucide-react';

const commands = [
  { id: 'new-thread', label: 'New Thread', shortcut: 'Ctrl+T', icon: Plus, action: 'thread' },
  { id: 'new-mission', label: 'New Mission', shortcut: 'Ctrl+M', icon: Zap, action: 'mission' },
  { id: 'switch-project', label: 'Switch Project', shortcut: 'Ctrl+P', icon: Folder, action: 'project' },
  { id: 'toggle-terminal', label: 'Toggle Terminal', shortcut: 'Ctrl+`', icon: Terminal, action: 'terminal' },
  { id: 'git-status', label: 'Git Status', shortcut: 'Ctrl+G', icon: GitBranch, action: 'git' },
  { id: 'settings', label: 'Settings', shortcut: 'Ctrl+,', icon: Settings, action: 'settings' },
];

export default function CommandPalette() {
  const { dispatch } = useStore();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  const filtered = commands.filter(c =>
    c.label.toLowerCase().includes(query.toLowerCase()) ||
    c.id.includes(query.toLowerCase())
  );

  const runCommand = (cmd: typeof commands[0]) => {
    dispatch({ type: 'CLOSE_COMMAND_PALETTE' });
    switch (cmd.action) {
      case 'settings':
        dispatch({ type: 'TOGGLE_SETTINGS' });
        break;
      case 'mission':
        dispatch({ type: 'TOGGLE_MISSION_MODE' });
        break;
      // other actions can be wired here
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected(prev => (prev + 1) % filtered.length);
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected(prev => (prev - 1 + filtered.length) % filtered.length);
    }
    if (e.key === 'Enter' && filtered[selected]) {
      runCommand(filtered[selected]);
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      dispatch({ type: 'CLOSE_COMMAND_PALETTE' });
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/40 backdrop-blur-sm"
      onClick={() => dispatch({ type: 'CLOSE_COMMAND_PALETTE' })}
    >
      <motion.div
        initial={{ scale: 0.96, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.96, opacity: 0 }}
        transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-[560px] bg-droid-elevated border border-droid-border rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search Input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-droid-border">
          <Search className="w-4 h-4 text-droid-text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a command or search..."
            className="flex-1 bg-transparent text-sm text-droid-text placeholder-droid-text-muted focus:outline-none"
          />
          <button
            onClick={() => dispatch({ type: 'CLOSE_COMMAND_PALETTE' })}
            className="p-1 rounded-md text-droid-text-muted hover:text-droid-text hover:bg-droid-surface transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Results */}
        <div className="py-2 max-h-[400px] overflow-y-auto">
          {filtered.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-droid-text-muted">
              No commands found
            </div>
          )}
          {filtered.map((cmd, i) => {
            const Icon = cmd.icon;
            return (
              <button
                key={cmd.id}
                onMouseEnter={() => setSelected(i)}
                onClick={() => runCommand(cmd)}
                className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                  i === selected ? 'bg-droid-accent/10' : 'hover:bg-droid-surface'
                }`}
              >
                <Icon className="w-4 h-4 text-droid-text-muted" />
                <span className="flex-1 text-sm text-droid-text">{cmd.label}</span>
                <span className="text-[10px] text-droid-text-muted font-mono">{cmd.shortcut}</span>
                {i === selected && (
                  <ArrowRight className="w-3.5 h-3.5 text-droid-accent" />
                )}
              </button>
            );
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2 border-t border-droid-border bg-droid-surface/50">
          <div className="flex items-center gap-3 text-[10px] text-droid-text-muted">
            <span className="flex items-center gap-1">
              <span className="px-1 py-0.5 rounded bg-droid-elevated border border-droid-border font-mono text-[9px]">↑↓</span>
              Navigate
            </span>
            <span className="flex items-center gap-1">
              <span className="px-1 py-0.5 rounded bg-droid-elevated border border-droid-border font-mono text-[9px]">↵</span>
              Select
            </span>
          </div>
          <div className="text-[10px] text-droid-text-muted">
            Droid Control v0.1.0
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
