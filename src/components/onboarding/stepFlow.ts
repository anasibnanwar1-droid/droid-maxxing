import type { EnvironmentReport } from '../../types/bridge';

// The wizard's step sequence as a pure function of the environment report, so
// the flow can be tested without mounting React.
export type StepId = 'welcome' | 'system' | 'install' | 'signin' | 'preferences' | 'done';

export const STEP_ORDER: StepId[] = [
  'welcome',
  'system',
  'install',
  'signin',
  'preferences',
  'done',
];

export function stepsForEnv(env: EnvironmentReport | null): StepId[] {
  const steps: StepId[] = ['welcome', 'system'];
  if (!env?.cli.present) steps.push('install');
  steps.push('signin', 'preferences', 'done');
  return steps;
}

// When the CLI appears mid-flow the install step vanishes; jump to the next
// still-present step in canonical order instead of snapping back to welcome.
export function advancePastRemovedStep(steps: StepId[], current: StepId): StepId {
  const pos = STEP_ORDER.indexOf(current);
  return steps.find((s) => STEP_ORDER.indexOf(s) >= pos) ?? steps[steps.length - 1];
}
