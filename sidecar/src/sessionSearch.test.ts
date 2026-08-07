import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  resetSessionSearchCache,
  searchSessionFiles,
  type SessionSearchCandidate,
} from './sessionSearch.js';

// Mirrors the daemon's JSONL message record shape that sessionTranscriptParser
// consumes: a message row holds role-tagged content blocks.
function messageLine(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  ts: number,
  visibility?: string,
): string {
  return JSON.stringify({
    id,
    type: 'message',
    timestamp: new Date(ts).toISOString(),
    message: {
      role,
      ...(visibility ? { visibility } : {}),
      content: [{ type: 'text', text }],
    },
  });
}

function toolUseLine(id: string, input: string, ts: number): string {
  return JSON.stringify({
    id,
    type: 'message',
    timestamp: new Date(ts).toISOString(),
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input }] },
  });
}

const dirs: string[] = [];

function writeSession(id: string, lines: string[]): SessionSearchCandidate {
  const dir = dirs[0] ?? mkdtempSync(join(tmpdir(), 'session-search-'));
  if (dirs.length === 0) dirs.push(dir);
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, lines.join('\n') + '\n');
  const stat = statSync(path);
  return {
    providerSessionId: id,
    appSessionId: id,
    path,
    mtimeMs: stat.mtimeMs,
    sizeBytes: stat.size,
  };
}

test('finds chat text across sessions with case-insensitive snippets', async () => {
  const candidate = writeSession('s1', [
    messageLine('m1', 'user', 'hi bro whatsapp, long time no see', 1000),
    messageLine('m2', 'assistant', 'Hey! All good here.', 2000),
  ]);
  const results = await searchSessionFiles([candidate], 'HI BRO WHATSAPP');
  assert.equal(results.length, 1);
  assert.equal(results[0]?.appSessionId, 's1');
  const match = results[0]?.matches[0];
  assert.equal(match?.author, 'user');
  assert.equal(match?.ts, 1000);
  assert.ok(match?.snippet.includes('hi bro whatsapp'));
});

test('assistant replies match with assistant attribution', async () => {
  const candidate = writeSession('s1', [
    messageLine('m1', 'assistant', 'The WhatsApp bridge is ready.', 5000),
  ]);
  const results = await searchSessionFiles([candidate], 'whatsapp bridge');
  assert.equal(results.length, 1);
  assert.equal(results[0]?.matches[0]?.author, 'assistant');
});

test('snippets are centered on the match and ellipsized at the cut', async () => {
  const candidate = writeSession('s1', [
    messageLine('m1', 'assistant', `${'x'.repeat(120)} needle in a haystack ${'y'.repeat(120)}`, 1),
  ]);
  const snippet = (await searchSessionFiles([candidate], 'needle'))[0]?.matches[0]?.snippet;
  assert.ok(snippet?.startsWith('…'));
  assert.ok(snippet?.endsWith('…'));
  assert.ok(snippet.includes('needle in a haystack'));
  assert.ok(snippet.length < 260);
});

test('returns up to three matches per session, newest first', async () => {
  const candidate = writeSession('s1', [
    messageLine('m1', 'user', 'deploy v1', 1000),
    messageLine('m2', 'assistant', 'deploy v1 done', 2000),
    messageLine('m3', 'user', 'deploy v2', 3000),
    messageLine('m4', 'assistant', 'deploy v2 done', 4000),
    messageLine('m5', 'user', 'deploy v3', 5000),
  ]);
  const matches = (await searchSessionFiles([candidate], 'deploy'))[0]?.matches ?? [];
  assert.equal(matches.length, 3);
  assert.deepEqual(
    matches.map((m) => m.ts),
    [5000, 4000, 3000],
  );
});

test('skips sessions without a match and tool I/O is not searchable', async () => {
  const chat = writeSession('chat', [messageLine('m1', 'user', 'nothing relevant', 1)]);
  const tools = writeSession('tools', [toolUseLine('m2', 'grep needle src/', 2)]);
  const results = await searchSessionFiles([chat, tools], 'needle');
  assert.deepEqual(
    results.map((r) => r.appSessionId),
    [],
  );
});

test('llm-only orchestration context is not searchable', async () => {
  const candidate = writeSession('s1', [
    messageLine('m1', 'user', 'secret handshake', 1, 'llm_only'),
  ]);
  assert.equal((await searchSessionFiles([candidate], 'secret handshake')).length, 0);
});

test('corrupt lines are skipped like the transcript reader does', async () => {
  const candidate = writeSession('s1', [
    '{"type":"message",broken',
    messageLine('m1', 'assistant', 'the answer is forty-two', 1),
  ]);
  const results = await searchSessionFiles([candidate], 'forty-two');
  assert.equal(results.length, 1);
});

test('a blank query never scans anything', async () => {
  const candidate = writeSession('s1', [messageLine('m1', 'user', 'anything', 1)]);
  assert.equal((await searchSessionFiles([candidate], '   ')).length, 0);
});

test('results cap at 25 sessions, keeping the candidates’ recency order', async () => {
  const candidates = Array.from({ length: 30 }, (_, i) =>
    writeSession(`s${String(i)}`, [
      messageLine('m1', 'user', `shared topic ${String(i)}`, 100 + i),
    ]),
  );
  const results = await searchSessionFiles(candidates, 'shared topic');
  assert.equal(results.length, 25);
  assert.equal(results[0]?.appSessionId, 's0');
  assert.equal(results[24]?.appSessionId, 's24');
});

test('extractions are cached by file freshness and re-read after writes', async () => {
  const candidate = writeSession('s1', [messageLine('m1', 'user', 'first version', 1)]);
  assert.equal((await searchSessionFiles([candidate], 'second version')).length, 0);
  assert.equal((await searchSessionFiles([candidate], 'first version')).length, 1);

  // A later write changes mtime+size, so the next query re-reads the file.
  appendFileSync(candidate.path, messageLine('m2', 'user', 'second version', 2) + '\n');
  const stat = statSync(candidate.path);
  const fresh: SessionSearchCandidate = {
    ...candidate,
    mtimeMs: stat.mtimeMs,
    sizeBytes: stat.size,
  };
  const results = await searchSessionFiles([fresh], 'second version');
  assert.equal(results.length, 1);

  resetSessionSearchCache();
});
