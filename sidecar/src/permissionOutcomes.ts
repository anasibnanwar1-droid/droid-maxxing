import {
  ToolConfirmationOutcome,
} from '@factory/droid-sdk';

const SDK_OUTCOMES = new Set<string>(Object.values(ToolConfirmationOutcome));

const OUTCOME_ALIASES: Record<string, ToolConfirmationOutcome> = {
  proceed_once: ToolConfirmationOutcome.ProceedOnce,
  proceed_always: ToolConfirmationOutcome.ProceedAlways,
  proceed_always_tools: ToolConfirmationOutcome.ProceedAlways,
  proceed_auto_run: ToolConfirmationOutcome.ProceedAutoRun,
  proceed_auto_run_low: ToolConfirmationOutcome.ProceedAutoRunLow,
  proceed_auto_run_medium: ToolConfirmationOutcome.ProceedAutoRunMedium,
  proceed_auto_run_high: ToolConfirmationOutcome.ProceedAutoRunHigh,
  proceed_new_session: ToolConfirmationOutcome.ProceedNewSession,
  proceed_new_session_low: ToolConfirmationOutcome.ProceedNewSessionLow,
  proceed_new_session_medium: ToolConfirmationOutcome.ProceedNewSessionMedium,
  proceed_new_session_high: ToolConfirmationOutcome.ProceedNewSessionHigh,
  proceed_edit: ToolConfirmationOutcome.ProceedEdit,
  cancel: ToolConfirmationOutcome.Cancel,
};

export function normalizePermissionOutcome(outcome: string): ToolConfirmationOutcome {
  const normalized = OUTCOME_ALIASES[outcome];
  if (normalized) return normalized;
  if (SDK_OUTCOMES.has(outcome)) return outcome as ToolConfirmationOutcome;
  throw new Error(`Unsupported permission outcome: ${outcome}`);
}

export function isApprovalOutcome(outcome: string): boolean {
  return normalizePermissionOutcome(outcome) !== ToolConfirmationOutcome.Cancel;
}
