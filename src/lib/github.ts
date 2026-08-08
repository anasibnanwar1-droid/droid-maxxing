import type {
  CreatePrOptions,
  CreatePrResult,
  DetectPrResult,
  GithubAvailability,
  GithubSetupResult,
  PostCommentResult,
  PrCheck,
  PrChecksResult,
  PrCommentsResult,
  PullRequest,
} from '../types/vcs';

function githubApi() {
  return typeof window === 'undefined' ? undefined : window.droidControl;
}

const unavailableSetup = (): GithubSetupResult => ({
  ok: false,
  reason: 'not_desktop',
  message: 'GitHub setup is available in the desktop app.',
});

export async function getGithubAvailability(): Promise<GithubAvailability> {
  const api = githubApi();
  if (!api) {
    return { installed: false, authenticated: false, installMethod: 'manual' };
  }
  try {
    return await api.githubAvailable();
  } catch {
    return { installed: false, authenticated: false, installMethod: 'manual' };
  }
}

export async function installGithubCli(): Promise<GithubSetupResult> {
  const api = githubApi();
  if (!api) return unavailableSetup();
  try {
    return await api.githubInstall();
  } catch {
    return {
      ok: false,
      reason: 'install_failed',
      message: 'DROIDEX could not start GitHub CLI installation.',
    };
  }
}

export async function authenticateGithubCli(): Promise<GithubSetupResult> {
  const api = githubApi();
  if (!api) return unavailableSetup();
  try {
    return await api.githubAuthenticate();
  } catch {
    return {
      ok: false,
      reason: 'auth_failed',
      message: 'DROIDEX could not start GitHub sign-in.',
    };
  }
}

export async function cancelGithubSetup(): Promise<void> {
  const api = githubApi();
  if (!api) return;
  try {
    await api.githubCancelSetup();
  } catch {
    // The in-flight authentication result owns the user-visible failure state.
  }
}

export function onGithubAuthCode(handler: (code: string) => void): () => void {
  const api = githubApi();
  if (!api) return () => undefined;
  return api.onGithubAuthCode((payload) => {
    if (typeof payload !== 'object' || payload === null) return;
    const code: unknown = Reflect.get(payload, 'code');
    if (typeof code !== 'string') return;
    if (/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) handler(code);
  });
}

export async function detectPullRequest(dir: string, branch?: string): Promise<DetectPrResult> {
  const api = githubApi();
  if (!api || !dir) return { ok: true, pr: null };
  try {
    return await api.githubDetectPr(dir, { branch });
  } catch {
    return { ok: false, pr: null };
  }
}

export async function getPrChecks(dir: string, prNumber: number): Promise<PrChecksResult> {
  const api = githubApi();
  if (!api) return { ok: false, reason: 'not_desktop', checks: [] };
  try {
    return await api.githubPrChecks(dir, { prNumber });
  } catch {
    return { ok: false, reason: 'error', checks: [] };
  }
}

export async function getPrComments(dir: string, prNumber: number): Promise<PrCommentsResult> {
  const api = githubApi();
  if (!api) return { ok: false, reason: 'not_desktop', comments: [] };
  try {
    return await api.githubPrComments(dir, { prNumber });
  } catch {
    return { ok: false, reason: 'error', comments: [] };
  }
}

export async function createPullRequest(
  dir: string,
  options: CreatePrOptions,
): Promise<CreatePrResult> {
  const api = githubApi();
  if (!api) return { ok: false, reason: 'not_desktop' };
  try {
    return await api.githubCreatePr(dir, options);
  } catch {
    return { ok: false, reason: 'error' };
  }
}

export async function postPrComment(
  dir: string,
  prNumber: number,
  body: string,
): Promise<PostCommentResult> {
  const api = githubApi();
  if (!api) return { ok: false, reason: 'not_desktop' };
  try {
    return await api.githubPostComment(dir, { prNumber, body });
  } catch {
    return { ok: false, reason: 'error' };
  }
}

// ---- Pure helpers (unit-tested) -------------------------------------------

export type PrKind = 'open' | 'draft' | 'merged' | 'closed';

export function prKind(pr: Pick<PullRequest, 'state' | 'isDraft'>): PrKind {
  const state = (pr.state || '').toLowerCase();
  if (state === 'merged') return 'merged';
  if (state === 'closed') return 'closed';
  if (pr.isDraft) return 'draft';
  return 'open';
}

export function prKindLabel(kind: PrKind): string {
  switch (kind) {
    case 'merged':
      return 'Merged';
    case 'closed':
      return 'Closed';
    case 'draft':
      return 'Draft';
    default:
      return 'Open';
  }
}

export type CheckStatus = 'success' | 'failure' | 'pending' | 'neutral';

export function bucketToStatus(bucket: string): CheckStatus {
  switch ((bucket || '').toLowerCase()) {
    case 'pass':
    case 'success':
      return 'success';
    case 'fail':
    case 'failure':
    case 'cancel':
      return 'failure';
    case 'pending':
      return 'pending';
    default:
      return 'neutral';
  }
}

export interface ChecksSummary {
  total: number;
  pass: number;
  fail: number;
  pending: number;
  status: CheckStatus | 'none';
}

export function checksSummary(checks: PrCheck[]): ChecksSummary {
  const summary: ChecksSummary = {
    total: checks.length,
    pass: 0,
    fail: 0,
    pending: 0,
    status: 'none',
  };
  for (const check of checks) {
    const status = bucketToStatus(check.bucket);
    if (status === 'success') summary.pass += 1;
    else if (status === 'failure') summary.fail += 1;
    else if (status === 'pending') summary.pending += 1;
  }
  if (summary.total === 0) summary.status = 'none';
  else if (summary.fail > 0) summary.status = 'failure';
  else if (summary.pending > 0) summary.status = 'pending';
  else if (summary.pass > 0) summary.status = 'success';
  else summary.status = 'neutral';
  return summary;
}
