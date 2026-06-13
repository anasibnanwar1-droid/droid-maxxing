import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageFeed } from './chat';
import type { TranscriptEvent } from '../types/bridge';

function ev(id: string, kind: TranscriptEvent['kind'], text: string, extra: Partial<TranscriptEvent> = {}): TranscriptEvent {
  return {
    id,
    missionId: 'm1',
    agentSessionId: extra.agentSessionId ?? 'orchestrator',
    role: extra.role ?? 'orchestrator',
    ts: extra.ts ?? Date.now(),
    kind,
    text,
    ...extra,
  };
}

test('final assistant answer stays visible when compaction follows it', () => {
  const html = renderToStaticMarkup(createElement(MessageFeed, {
    events: [
      ev('u1', 'text', 'Run the task', { author: 'user', ts: 1 }),
      ev('t1', 'thinking', 'Checking files', { ts: 2 }),
      ev('a1', 'text', 'Final answer that must stay visible', { ts: 3 }),
      ev('c1', 'status', 'Compacting conversation...', { compactType: 'auto', ts: 4 }),
      ev('c2', 'status', 'Compaction complete. Removed 4 messages.', { compactType: 'auto', ts: 5 }),
    ],
    pending: false,
  }));

  assert.match(html, /Final answer that must stay visible/);
  assert.match(html, /Context automatically compacted/);
  assert.doesNotMatch(html, /Compacting conversation/);
});
