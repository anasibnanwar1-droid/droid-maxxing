import {
  ToolConfirmationOutcome,
  type RequestPermissionHandlerResult,
} from '@factory/droid-sdk';

const SDK_OUTCOMES = new Set<string>(Object.values(ToolConfirmationOutcome));

const OUTCOME_ALIASES: Record<string, ToolConfirmationOutcome> = {
  proceed_once: ToolConfirmationOutcome.ProceedOnce,
  proceed_always: ToolConfirmationOutcome.ProceedAlways,
  proceed_always_tools: ToolConfirmationOutcome.ProceedAlways,
  proceed_auto_run: ToolConfirmationOutcome.ProceedAutoRun,
  cancel: ToolConfirmationOutcome.Cancel,
};

export function normalizePermissionOutcome(outcome: string): RequestPermissionHandlerResult {
  const normalized = OUTCOME_ALIASES[outcome];
  if (normalized) return normalized;
  if (SDK_OUTCOMES.has(outcome)) return outcome as RequestPermissionHandlerResult;
  throw new Error(`Unsupported permission outcome: ${outcome}`);
}

export function isApprovalOutcome(outcome: string): boolean {
  return normalizePermissionOutcome(outcome) !== ToolConfirmationOutcome.Cancel;
}
