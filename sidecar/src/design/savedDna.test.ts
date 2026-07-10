import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deleteSavedDna,
  getActiveDnaId,
  getSavedDna,
  listSavedDna,
  saveDnaEntry,
  setActiveDna,
} from './savedDna.js';
import type { DesignTokens } from './types.js';

const tokens: DesignTokens = {
  colors: { brand: '#ee6018', surface: '#111', text: '#fff' },
  fonts: { sans: 'Inter' },
  typeScale: [14, 16, 24],
  spacing: [4, 8, 16],
  radii: [4, 8],
};

test('saveDnaEntry persists, sets active, and list/get work', async () => {
  const baseDir = await mkdtemp(join(tmpdir(), 'droidex-saved-dna-'));
  try {
    const cwd = join(baseDir, 'project');
    const { entry, items } = saveDnaEntry({
      cwd,
      name: 'Halden',
      tagline: 'Quiet precision',
      tokens,
      design: '# Halden\n',
      motion: '# Motion\n',
      source: 'interview',
      baseDir,
    });
    assert.equal(items.length, 1);
    assert.equal(entry.name, 'Halden');
    assert.equal(getActiveDnaId(cwd, baseDir), entry.id);
    assert.equal(listSavedDna(cwd, baseDir)[0]?.id, entry.id);
    assert.equal(getSavedDna(cwd, entry.id, baseDir)?.tagline, 'Quiet precision');
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('deleteSavedDna clears active when the active entry is removed', async () => {
  const baseDir = await mkdtemp(join(tmpdir(), 'droidex-saved-dna-'));
  try {
    const cwd = join(baseDir, 'project');
    const { entry } = saveDnaEntry({
      cwd,
      name: 'A',
      tokens,
      design: '# A\n',
      motion: '',
      source: 'manual',
      baseDir,
    });
    const result = deleteSavedDna(cwd, entry.id, baseDir);
    assert.equal(result.items.length, 0);
    assert.equal(result.activeId, null);
    assert.equal(getActiveDnaId(cwd, baseDir), null);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('setActiveDna can clear or re-point active id', async () => {
  const baseDir = await mkdtemp(join(tmpdir(), 'droidex-saved-dna-'));
  try {
    const cwd = join(baseDir, 'project');
    const a = saveDnaEntry({
      cwd,
      name: 'A',
      tokens,
      design: '# A\n',
      motion: '',
      source: 'scan',
      baseDir,
    }).entry;
    const b = saveDnaEntry({
      cwd,
      name: 'B',
      tokens,
      design: '# B\n',
      motion: '',
      source: 'scan',
      baseDir,
    }).entry;
    assert.equal(getActiveDnaId(cwd, baseDir), b.id);
    setActiveDna(cwd, a.id, baseDir);
    assert.equal(getActiveDnaId(cwd, baseDir), a.id);
    setActiveDna(cwd, null, baseDir);
    assert.equal(getActiveDnaId(cwd, baseDir), null);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
