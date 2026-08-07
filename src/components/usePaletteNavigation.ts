import { useEffect, useState } from 'react';

// Shared arrow-key navigation for the command-palette overlays (⌘K command
// palette, sidebar session search): selection wraps around, resets whenever
// the query changes, Enter activates the selected entry, Escape closes.
export function usePaletteNavigation<Entry>(
  query: string,
  entries: Entry[],
  onEnter: (entry: Entry) => void,
  onClose: () => void,
): {
  selected: number;
  setSelected: (index: number) => void;
  handleKeyDown: (e: React.KeyboardEvent) => void;
} {
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (entries.length > 0) setSelected((prev) => (prev + 1) % entries.length);
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (entries.length > 0) setSelected((prev) => (prev - 1 + entries.length) % entries.length);
    }
    if (e.key === 'Enter') {
      const entry = entries.at(selected);
      if (entry) onEnter(entry);
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return { selected, setSelected, handleKeyDown };
}
