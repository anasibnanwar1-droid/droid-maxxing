import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalHome = process.env.HOME;
const home = mkdtempSync(join(tmpdir(), 'droid-history-resume-'));
process.env.HOME = home;

const { loadSessionPage } = await import('./history.js');
const { RESUME_NUDGE } = await import('./autoCompaction.js');

test.after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

function writeTranscript(id: string, userTexts: string[]): void {
  const dir = join(home, '.factory', 'sessions', '2026', '06');
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'session_start', cwd: home, sessionTitle: 'S' }),
    ...userTexts.map((text, i) =>
      JSON.stringify({
        type: 'message',
        id: `u${i}`,
        timestamp: '2026-06-12T00:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text }] },
      }),
    ),
  ];
  writeFileSync(join(dir, `${id}.jsonl`), `${lines.join('\n')}\n`);
}

test('history replay drops the hidden auto-compaction resume nudge but keeps real user prompts', () => {
  writeTranscript('resume-nudge-session', ['What is the status?', RESUME_NUDGE, 'And next?']);

  const page = loadSessionPage('resume-nudge-session', undefined, 200, 'resume-nudge-session');
  const userTexts = page.events
    .filter((e) => e.kind === 'text' && e.author === 'user')
    .map((e) => e.text);

  // The synthetic resume nudge never appears in the reloaded transcript...
  assert.equal(userTexts.includes(RESUME_NUDGE), false);
  // ...while the user's real prompts around it are preserved.
  assert.deepEqual(userTexts, ['What is the status?', 'And next?']);
});
