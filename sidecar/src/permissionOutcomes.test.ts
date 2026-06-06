import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolConfirmationOutcome } from '@factory/droid-sdk';
import { isApprovalOutcome, normalizePermissionOutcome } from './permissionOutcomes.js';

test('normalizes UI and model permission aliases to Droid SDK outcomes', () => {
  assert.equal(normalizePermissionOutcome('proceed_once'), ToolConfirmationOutcome.ProceedOnce);
  assert.equal(normalizePermissionOutcome('proceed_always'), ToolConfirmationOutcome.ProceedAlways);
  assert.equal(normalizePermissionOutcome('proceed_always_tools'), ToolConfirmationOutcome.ProceedAlways);
  assert.equal(normalizePermissionOutcome('proceed_auto_run'), ToolConfirmationOutcome.ProceedAutoRun);
  assert.equal(normalizePermissionOutcome('cancel'), ToolConfirmationOutcome.Cancel);
});

test('recognizes approval outcomes after normalization', () => {
  assert.equal(isApprovalOutcome('proceed_always_tools'), true);
  assert.equal(isApprovalOutcome('cancel'), false);
});

test('rejects unknown permission outcomes before they reach Droid', () => {
  assert.throws(() => normalizePermissionOutcome('always_yes'), /Unsupported permission outcome/);
});
