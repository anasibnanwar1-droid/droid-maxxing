import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { recordSessionStreamingState } from './dnaRefresh';

const designSessionSource = readFileSync(new URL('./useDesignSession.ts', import.meta.url), 'utf8');
const dnaShelfSource = readFileSync(new URL('./DnaShelf.tsx', import.meta.url), 'utf8');
const studioShellSource = readFileSync(new URL('./StudioShell.tsx', import.meta.url), 'utf8');

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

test('Studio reuses one add-frame callback across canvas state updates', () => {
  assert.match(studioShellSource, /const requestAddFrame = useCallback/);
  assert.equal(studioShellSource.match(/onRequestAddFrame=\{requestAddFrame\}/g)?.length, 2);
});

test('DNA refresh follows each session across thread switches', () => {
  const previousBySession = new Map<string, boolean>();
  assert.equal(recordSessionStreamingState(previousBySession, 'session-a', true), false);
  assert.equal(recordSessionStreamingState(previousBySession, 'session-b', false), false);
  assert.equal(recordSessionStreamingState(previousBySession, 'session-a', false), true);
  assert.equal(recordSessionStreamingState(previousBySession, 'session-a', false), false);
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
