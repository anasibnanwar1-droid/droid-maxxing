import type {
  NativeBrowserAgentAction,
  NativeBrowserAgentResult,
  NativeBrowserBounds,
  NativeBrowserBox,
  NativeBrowserCaptureOptions,
  NativeBrowserDesignPrompt,
  NativeBrowserLoadFailed,
  NativeBrowserLoaded,
  NativeBrowserSelection,
} from './nativeBrowser';
import type { EditorId, EditorTarget } from './editorOpen';
import type { RepoStatus } from './repoEnvironment';
import type { AppUpdateInfo, AppUpdateResult, OnboardingState } from './onboarding';
import type {
  CommitOptions,
  CreateBranchOptions,
  CreatePrOptions,
  CreatePrResult,
  CreateWorktreeOptions,
  DiffStatMode,
  GitActionResult,
  GitBranchList,
  GitDiffStat,
  GitEnvironment,
  GitWorktree,
  GithubAvailability,
  PostCommentResult,
  PrChecksResult,
  PrCommentsResult,
  PullRequest,
  PushOptions,
} from '../types/vcs';

interface BridgeInfo {
  port: number;
  token: string;
}

interface DroidControlApi {
  bridgeInfo: () => Promise<BridgeInfo>;
  pickDirectory: () => Promise<string | null>;
  notify: (title: string, body: string) => Promise<void>;
  getApiKey: () => Promise<string | null>;
  setApiKey: (key: string) => Promise<void>;
  clearApiKey: () => Promise<void>;
  listFiles: (dir: string) => Promise<string[]>;
  readFile: (path: string) => Promise<string>;
  repoStatus: (dir: string) => Promise<RepoStatus | null>;
  listEditors: () => Promise<EditorId[]>;
  openProject: (dir: string, editor: EditorId, target: EditorTarget) => Promise<void>;
  gitEnvironment: (dir: string) => Promise<GitEnvironment>;
  gitBranches: (dir: string) => Promise<GitBranchList>;
  gitWorktrees: (dir: string) => Promise<GitWorktree[]>;
  gitDiffStat: (dir: string, options: { mode: DiffStatMode }) => Promise<GitDiffStat>;
  gitCreateBranch: (dir: string, options: CreateBranchOptions) => Promise<GitActionResult>;
  gitCheckout: (
    dir: string,
    options: { ref: string; allowDirty?: boolean },
  ) => Promise<GitActionResult>;
  gitCreateWorktree: (dir: string, options: CreateWorktreeOptions) => Promise<GitActionResult>;
  gitRemoveWorktree: (
    dir: string,
    options: { path: string; force?: boolean },
  ) => Promise<GitActionResult>;
  gitStageAll: (dir: string) => Promise<GitActionResult>;
  gitCommit: (dir: string, options: CommitOptions) => Promise<GitActionResult>;
  gitPush: (dir: string, options: PushOptions) => Promise<GitActionResult>;
  githubAvailable: () => Promise<GithubAvailability>;
  githubDetectPr: (dir: string, options: { branch?: string }) => Promise<PullRequest | null>;
  githubPrChecks: (dir: string, options: { prNumber: number }) => Promise<PrChecksResult>;
  githubPrComments: (dir: string, options: { prNumber: number }) => Promise<PrCommentsResult>;
  githubCreatePr: (dir: string, options: CreatePrOptions) => Promise<CreatePrResult>;
  githubPostComment: (
    dir: string,
    options: { prNumber: number; body: string },
  ) => Promise<PostCommentResult>;
  getOnboarding: () => Promise<OnboardingState>;
  setOnboarding: (patch: Partial<OnboardingState>) => Promise<OnboardingState>;
  appVersion: () => Promise<string>;
  checkAppUpdate: () => Promise<AppUpdateInfo>;
  downloadAppUpdate: (dmgUrl?: string) => Promise<AppUpdateResult>;
  relaunchApp: () => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  nativeBrowserOpen: (
    sessionId: string,
    url: string,
    bounds?: NativeBrowserBounds,
    viewport?: { width: number; height: number; deviceScaleFactor: number },
  ) => Promise<void>;
  nativeBrowserAttach: (
    sessionId: string,
    bounds: NativeBrowserBounds,
    url?: string,
  ) => Promise<void>;
  nativeBrowserDetach: (sessionId?: string) => Promise<void>;
  nativeBrowserSetBounds: (sessionId: string, bounds: NativeBrowserBounds) => Promise<void>;
  nativeBrowserClose: (sessionId: string) => Promise<void>;
  nativeBrowserReload: (sessionId: string) => Promise<void>;
  nativeBrowserSetDesignMode: (sessionId: string, active: boolean) => Promise<void>;
  nativeBrowserSetPencilMode: (sessionId: string, active: boolean) => Promise<void>;
  nativeBrowserAgentAction: (
    request: NativeBrowserAgentAction,
  ) => Promise<NativeBrowserAgentResult | undefined>;
  nativeBrowserCapture: (
    sessionId: string,
    box?: NativeBrowserBox,
    options?: NativeBrowserCaptureOptions,
  ) => Promise<string | undefined>;
  onNativeBrowserSelection: (handler: (selection: NativeBrowserSelection) => void) => () => void;
  onNativeBrowserDesignPrompt: (handler: (prompt: NativeBrowserDesignPrompt) => void) => () => void;
  onNativeBrowserLoaded: (handler: (event: NativeBrowserLoaded) => void) => () => void;
  onNativeBrowserLoadFailed: (handler: (event: NativeBrowserLoadFailed) => void) => () => void;
  onNativeBrowserAgentResult: (handler: (result: NativeBrowserAgentResult) => void) => () => void;
}

declare global {
  interface Window {
    droidControl?: DroidControlApi;
  }
}

export const isDesktop = () => typeof window !== 'undefined' && Boolean(window.droidControl);

export async function getBridgeInfo(): Promise<BridgeInfo> {
  if (!isDesktop()) return { port: 8765, token: '' };
  return window.droidControl!.bridgeInfo();
}

export async function pickDirectory(): Promise<string | null> {
  if (!isDesktop()) return null;
  return window.droidControl!.pickDirectory();
}

export async function notify(title: string, body: string): Promise<void> {
  if (!isDesktop()) return;
  await window.droidControl!.notify(title, body);
}

export async function getApiKey(): Promise<string | null> {
  if (!isDesktop()) return null;
  return window.droidControl!.getApiKey();
}

export async function setApiKey(key: string): Promise<void> {
  if (!isDesktop()) return;
  await window.droidControl!.setApiKey(key);
}

export async function clearApiKey(): Promise<void> {
  if (!isDesktop()) return;
  await window.droidControl!.clearApiKey();
}

export async function listFiles(dir: string): Promise<string[]> {
  if (!isDesktop()) return [];
  try {
    return await window.droidControl!.listFiles(dir);
  } catch {
    return [];
  }
}

export async function readFile(path: string): Promise<string | null> {
  if (!isDesktop()) return null;
  try {
    return await window.droidControl!.readFile(path);
  } catch {
    return null;
  }
}

export async function getRepoStatus(dir: string): Promise<RepoStatus | null> {
  if (!isDesktop()) return null;
  try {
    return await window.droidControl!.repoStatus(dir);
  } catch {
    return null;
  }
}

export async function openProject(
  dir: string,
  editor: EditorId,
  target: EditorTarget,
): Promise<void> {
  if (!isDesktop()) return;
  await window.droidControl!.openProject(dir, editor, target);
}

export async function listEditors(): Promise<EditorId[]> {
  if (!isDesktop()) return [];
  try {
    return await window.droidControl!.listEditors();
  } catch {
    return [];
  }
}
