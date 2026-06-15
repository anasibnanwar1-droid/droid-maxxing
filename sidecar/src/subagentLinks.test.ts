import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalHome = process.env.HOME;
const home = mkdtempSync(join(tmpdir(), 'droid-subagent-links-'));
process.env.HOME = home;

const { HistoryIndex } = await import('./history.js');

test.after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

test('subagentLinks preserves the exact toolUseId -> workerSessionId mapping with duplicate labels and out-of-order sessions', () => {
  const index = new HistoryIndex();
  // Two spawns share the same label, and the worker sessions resolve in an order
  // that does NOT match the spawn order (order-based pairing would mismatch).
  index.recordSubagentLink('m1', 'tool-A', 'sess-B', 'worker');
  index.recordSubagentLink('m1', 'tool-B', 'sess-A', 'worker');

  const links = index.subagentLinks('m1');
  index.close();

  const byTool = new Map(links.map((l) => [l.toolUseId, l.workerSessionId]));
  assert.equal(byTool.get('tool-A'), 'sess-B');
  assert.equal(byTool.get('tool-B'), 'sess-A');
  assert.equal(links.length, 2);
  assert.ok(links.every((l) => l.label === 'worker'));
});

test('subagentLinks scopes mappings per mission and upserts on repeated toolUseId', () => {
  const index = new HistoryIndex();
  index.recordSubagentLink('m2', 'tool-X', 'sess-old', 'reviewer');
  index.recordSubagentLink('m2', 'tool-X', 'sess-new', 'reviewer'); // re-resolve same spawn
  index.recordSubagentLink('m3', 'tool-Y', 'sess-other', 'builder');

  const m2 = index.subagentLinks('m2');
  const m3 = index.subagentLinks('m3');
  index.close();

  assert.equal(m2.length, 1);
  assert.equal(m2[0].workerSessionId, 'sess-new');
  assert.deepEqual(
    m3.map((l) => l.workerSessionId),
    ['sess-other'],
  );
});
