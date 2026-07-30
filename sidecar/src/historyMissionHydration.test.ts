import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SessionSummary } from './protocol.js';

const originalHome = process.env.HOME;
const home = mkdtempSync(join(tmpdir(), 'droid-mission-history-'));
process.env.HOME = home;

const { HistoryIndex, hydrateHistoricalSession } = await import('./history.js');

test.after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

test('Mission hydration restores logical child progress beneath the exact parent', () => {
  const missionDir = join(home, '.factory', 'missions', 'mission-1');
  mkdirSync(missionDir, { recursive: true });
  writeFileSync(
    join(missionDir, 'state.json'),
    JSON.stringify({
      missionId: 'mission-1',
      baseSessionId: 'parent-app',
      state: 'completed',
    }),
  );
  writeFileSync(
    join(missionDir, 'progress_log.jsonl'),
    [
      {
        type: 'worker_started',
        timestamp: '2026-07-29T00:00:00.000Z',
        workerSessionId: 'provider-old',
        spawnId: 'spawn-1',
      },
      {
        type: 'worker_completed',
        timestamp: '2026-07-29T00:01:00.000Z',
        workerSessionId: 'provider-old',
        featureId: 'feature-1',
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
  );

  const history = new HistoryIndex();
  history.syncSummaries([missionSummary()]);
  history.upsertChildSession({
    parentAppSessionId: 'parent-app',
    childSessionId: 'child-stable',
    providerSessionId: 'provider-current',
    role: 'worker',
    status: 'completed',
    modelId: 'model',
    spawnLink: { kind: 'spawn', id: 'spawn-1' },
    transcriptAvailable: true,
    updatedAt: 2,
  });
  history.upsertChildSession({
    parentAppSessionId: 'other-parent',
    childSessionId: 'child-stable',
    providerSessionId: 'provider-old',
    role: 'worker',
    status: 'completed',
    modelId: 'model',
    spawnLink: { kind: 'spawn', id: 'other-spawn' },
    transcriptAvailable: true,
    updatedAt: 2,
  });
  history.close();

  const hydrated = hydrateHistoricalSession('mission-1');
  assert.deepEqual(
    hydrated.progress.map((entry) => entry.workerChildSessionId),
    ['child-stable', 'child-stable'],
  );
  assert.equal(JSON.stringify(hydrated.progress).includes('provider-old'), false);
  assert.equal(JSON.stringify(hydrated.progress).includes('spawn-1'), false);
});

function missionSummary(): SessionSummary {
  return {
    appSessionId: 'parent-app',
    providerSessionId: 'parent-provider',
    missionId: 'mission-1',
    sessionPurpose: 'mission-control',
    interactionMode: 'agi',
    role: 'primary',
    title: 'Mission',
    goal: 'Ship',
    cwd: '',
    workspaceKind: 'none',
    autonomy: 'medium',
    phase: 'completed',
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 1,
    updatedAt: 2,
  };
}
