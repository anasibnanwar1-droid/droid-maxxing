import assert from 'node:assert/strict';
import test from 'node:test';

import { ReasoningEffort } from '@factory/droid-sdk';

import { FakeFactoryRuntime, type RecordedCall } from './fakeFactoryRuntime.js';

test('created sessions expose their requested settings', async () => {
  const calls: RecordedCall[] = [];
  const runtime = new FakeFactoryRuntime(calls);

  const session = await runtime.createSession({
    cwd: '/workspace',
    interactionMode: 'spec',
    modelId: 'model-requested',
    reasoningEffort: 'high',
  });

  assert.deepEqual(session.initResult.settings, {
    modelId: 'model-requested',
    reasoningEffort: ReasoningEffort.High,
    interactionMode: 'spec',
  });
});
