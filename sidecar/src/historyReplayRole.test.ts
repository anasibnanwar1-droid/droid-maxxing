import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalHome = process.env.HOME;
const home = mkdtempSync(join(tmpdir(), 'droid-history-role-'));
process.env.HOME = home;

const { loadSessionPage } = await import('./history.js');

test.after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

function writeTranscript(id: string, start: Record<string, unknown>): void {
  const dir = join(home, '.factory', 'sessions', '2026', '06');
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'session_start', cwd: home, sessionTitle: 'S', ...start }),
    JSON.stringify({
      type: 'message',
      id: 'm1',
      timestamp: '2026-06-12T00:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello from worker' }] },
    }),
  ];
  writeFileSync(join(dir, `${id}.jsonl`), `${lines.join('\n')}\n`);
}

test('loadSessionPage replays a marker-only Task subagent with worker role keyed to its own id', () => {
  writeTranscript('subagent-session', {
    callingSessionId: 'parent-session',
    callingToolUseId: 'tool-1',
  });

  const page = loadSessionPage('subagent-session', undefined, 200, 'mission-app');
  const text = page.events.find((e) => e.kind === 'text');

  assert.ok(text, 'expected a text event');
  // The subagent's transcript must key to its own session id (not 'orchestrator'),
  // otherwise opening the persisted subagent link shows an empty feed.
  assert.equal(text!.agentSessionId, 'subagent-session');
  assert.equal(text!.role, 'worker');
});

test('loadSessionPage still replays a plain session as orchestrator', () => {
  writeTranscript('plain-session', {});

  const page = loadSessionPage('plain-session', undefined, 200, 'plain-session');
  const text = page.events.find((e) => e.kind === 'text');

  assert.ok(text, 'expected a text event');
  assert.equal(text!.agentSessionId, 'orchestrator');
  assert.equal(text!.role, 'orchestrator');
});

test('loadSessionPage replays an orphan Task subagent opened standalone as orchestrator so it renders', () => {
  // Marker-only subagent with no live parent context, opened as its OWN chat
  // (missionId === sessionId) from the sidebar.
  writeTranscript('orphan-standalone', {
    callingSessionId: 'gone-parent',
    callingToolUseId: 'tool-x',
  });

  const page = loadSessionPage('orphan-standalone', undefined, 200, 'orphan-standalone');
  const text = page.events.find((e) => e.kind === 'text');

  assert.ok(text, 'expected a text event');
  // Must replay as orchestrator; otherwise ChatView's main feed filters out the
  // worker-role events and the standalone session shows blank.
  assert.equal(text!.role, 'orchestrator');
  assert.equal(text!.agentSessionId, 'orchestrator');
});
