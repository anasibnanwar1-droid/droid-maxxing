import assert from 'node:assert/strict';
import test from 'node:test';

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
    assert.equal(reply?.query, 'whatsapp');
    assert.deepEqual(reply?.results, ctx.history.nextSearchResults);
  } finally {
    await ctx.dispose();
  }
});
