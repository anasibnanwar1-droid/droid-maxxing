import fs from 'node:fs';
import path from 'node:path';
import { activeDnaFile, savedDnaFile } from './designPaths.js';
import type { DesignTokens, SavedDnaEntry } from './types.js';

const MAX_ENTRIES = 48;

export type SavedDnaSource = SavedDnaEntry['source'];

export function listSavedDna(cwd: string, baseDir?: string): SavedDnaEntry[] {
  try {
    const raw = fs.readFileSync(savedDnaFile(cwd, baseDir), 'utf8');
    const parsed = JSON.parse(raw) as { items?: SavedDnaEntry[] };
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

export function getSavedDna(cwd: string, id: string, baseDir?: string): SavedDnaEntry | undefined {
  return listSavedDna(cwd, baseDir).find((entry) => entry.id === id);
}

export function getActiveDnaId(cwd: string, baseDir?: string): string | null {
  try {
    const raw = fs.readFileSync(activeDnaFile(cwd, baseDir), 'utf8');
    const parsed = JSON.parse(raw) as { id?: string | null };
    return typeof parsed.id === 'string' ? parsed.id : null;
  } catch {
    return null;
  }
}

export function setActiveDna(cwd: string, id: string | null, baseDir?: string): void {
  const file = activeDnaFile(cwd, baseDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ id }, null, 2), 'utf8');
}

export interface SaveDnaInput {
  cwd: string;
  name: string;
  tagline?: string;
  tokens: DesignTokens;
  design: string;
  motion: string;
  source: SavedDnaSource;
  sourceLibraryId?: string;
  baseDir?: string;
}

export function saveDnaEntry(input: SaveDnaInput): {
  items: SavedDnaEntry[];
  entry: SavedDnaEntry;
} {
  const id = `dna-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const entry: SavedDnaEntry = {
    id,
    name: input.name.trim() || 'Direction',
    tagline: input.tagline?.trim() || undefined,
    createdAt: new Date().toISOString(),
    tokens: input.tokens,
    design: input.design,
    motion: input.motion,
    source: input.source,
    sourceLibraryId: input.sourceLibraryId,
  };
  const items = [entry, ...listSavedDna(input.cwd, input.baseDir)].slice(0, MAX_ENTRIES);
  writeItems(input.cwd, items, input.baseDir);
  setActiveDna(input.cwd, entry.id, input.baseDir);
  return { items, entry };
}

export function deleteSavedDna(
  cwd: string,
  id: string,
  baseDir?: string,
): { items: SavedDnaEntry[]; activeId: string | null } {
  const items = listSavedDna(cwd, baseDir).filter((entry) => entry.id !== id);
  writeItems(cwd, items, baseDir);
  const activeId = getActiveDnaId(cwd, baseDir);
  if (activeId === id) {
    setActiveDna(cwd, null, baseDir);
    return { items, activeId: null };
  }
  return { items, activeId };
}

function writeItems(cwd: string, items: SavedDnaEntry[], baseDir?: string): void {
  const file = savedDnaFile(cwd, baseDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ items }, null, 2), 'utf8');
}
