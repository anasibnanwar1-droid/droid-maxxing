import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { formatDesignPrompt, writeDesignPromptPack } from './designPromptPacks.js';

test('writeDesignPromptPack stores compact JSON on disk', async () => {
  const baseDir = join(tmpdir(), `droid-pack-test-${Date.now()}`);
  const { pack, path } = await writeDesignPromptPack({
    baseDir,
    missionId: 'mission-one',
    browserSessionId: 'browser-one',
    instruction: 'Remove this dot pattern',
    now: () => new Date('2026-06-06T12:00:00.000Z'),
    references: [{
      id: 'ref-one',
      kind: 'region',
      url: 'http://127.0.0.1:1420/',
      viewport: { width: 900, height: 700, deviceScaleFactor: 1 },
      screenshotPath: '/tmp/shot.png',
      scroll: { x: 0, y: 0 },
      box: { x: 10, y: 10, width: 40, height: 40 },
    }],
  });

  assert.equal(pack.createdAt, '2026-06-06T12:00:00.000Z');
  assert.match(path, /mission-one\/pack-2026-06-06T12-00-00-000Z\.json$/);
  const saved = JSON.parse(await readFile(path, 'utf8')) as { instruction: string };
  assert.equal(saved.instruction, 'Remove this dot pattern');
  await rm(baseDir, { recursive: true, force: true });
});

test('formatDesignPrompt returns path-backed context', () => {
  const text = formatDesignPrompt('/tmp/pack.json', 'Make this cleaner', [{
    id: 'ref-one',
    kind: 'region',
    url: 'http://127.0.0.1:1420/',
    viewport: { width: 900, height: 700, deviceScaleFactor: 1 },
    screenshotPath: '/tmp/shot.png',
    scroll: { x: 0, y: 0 },
  }]);

  assert.match(text, /References JSON: \/tmp\/pack\.json/);
  assert.match(text, /User instruction:\nMake this cleaner/);
});
