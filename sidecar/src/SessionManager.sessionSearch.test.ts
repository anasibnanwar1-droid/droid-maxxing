import assert from 'node:assert/strict';
import test from 'node:test';

import type * as Protocol from './protocol.js';
import { createSessionManagerTestContext } from './testing/sessionManagerTestContext.js';

test('sessions.search answers the requester with the history scan results', async () => {
  const ctx = createSessionManagerTestContext();
  try {
    ctx.history.nextSearchResults = [
      {
        appSessionId: 'app-1',
        matches: [{ snippet: '…hi bro whatsapp…', author: 'user', ts: 1_700_000_000_000 }],
      },
    ];

    await ctx.handle({ type: 'sessions.search', requestId: 'req-7', query: 'whatsapp' });

    const reply = ctx.events.find((event) => event.type === 'sessions.searchResults');
    assert.equal(reply?.type, 'sessions.searchResults');
    assert.equal(reply?.requestId, 'req-7');
    assert.equal(ctx.history.lastSearchQuery, 'whatsapp');
    assert.deepEqual(reply?.results, ctx.history.nextSearchResults);
  } finally {
    await ctx.dispose();
  }
});

test('a superseded sessions.search scan does not emit its results', async () => {
  const ctx = createSessionManagerTestContext();
  try {
    // Gate the scan so the newer query lands while the older one is in
    // flight; determinism comes from the gate, not from timing.
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    ctx.history.searchSessions = async (
      _query?: string,
      isStale?: () => boolean,
    ): Promise<Protocol.SessionSearchResult[]> => {
      await gate;
      return isStale?.()
        ? []
        : [{ appSessionId: 'app-1', matches: [{ snippet: 'hit', author: 'user', ts: 1 }] }];
    };

    const first = ctx.handle({ type: 'sessions.search', requestId: 'req-1', query: 'a' });
    const second = ctx.handle({ type: 'sessions.search', requestId: 'req-2', query: 'ab' });
    release();
    await Promise.all([first, second]);

    const replies = ctx.events.filter((event) => event.type === 'sessions.searchResults');
    assert.equal(replies.length, 1);
    assert.equal(replies[0]?.requestId, 'req-2');
  } finally {
    await ctx.dispose();
  }
});
