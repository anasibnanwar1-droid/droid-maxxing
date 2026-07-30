import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const designSessionSource = readFileSync(new URL('./useDesignSession.ts', import.meta.url), 'utf8');
const dnaShelfSource = readFileSync(new URL('./DnaShelf.tsx', import.meta.url), 'utf8');

test('Studio leaves queued prompt delivery to the app-level queue owner', () => {
  for (const duplicateOwnerMarker of [
    'REMOVE_QUEUED_PROMPT',
    'markGitTurnStart',
    'previousLiveRef',
    'resumeSession',
  ]) {
    assert.equal(
      designSessionSource.includes(duplicateOwnerMarker),
      false,
      `useDesignSession must not own ${duplicateOwnerMarker}`,
    );
  }
});

test('the Libraries shelf reuses the Agent panel design session', () => {
  assert.equal(dnaShelfSource.includes('useDesignSession'), false);
});

test('new Studio sessions carry the same model and compaction settings as chat', () => {
  for (const setting of [
    'state.agentConfig.primary.modelId',
    'state.agentConfig.primary.reasoning',
    'state.compactionModel',
    'state.compactionTokenLimit',
    'state.compactionTokenLimitPerModel',
  ]) {
    assert.equal(
      designSessionSource.includes(setting),
      true,
      `useDesignSession must include ${setting}`,
    );
  }
});
