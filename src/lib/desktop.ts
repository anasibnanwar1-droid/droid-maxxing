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
  DetectPrResult,
  DiffFileList,
  DiffScope,
  DiffStatMode,
  FileDiffResult,
  GitActionResult,
  GitBranchList,
  GitDiffStat,
  GitEnvironment,
  GitWorktree,
  GithubAvailability,
  PostCommentResult,
  PrChecksResult,
  PrCommentsResult,
  PushOptions,
} from '../types/vcs';

interface BridgeInfo {
  port: number;
  token: string;
}

export interface TerminalSessionInfo {
  id: string;
  missionId: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  exited?: boolean;
  exitCode?: number | null;
}

export type TerminalEvent =
  | {
      terminalId: string;
      kind: 'replay';
      data: string;
      sequence: number;
      truncated: boolean;
      droppedBytes: number;
    }
  | {
      terminalId: string;
      kind: 'data';
      data: string;
      sequence: number;
      byteOffset: number;
    }
  | {
      terminalId: string;
      kind: 'exit';
      sequence: number;
      exitCode: number | null;
      signal: number | null;
    };

export interface FilesEntry {
  name: string;
  kind: 'directory' | 'file';
  size: number;
  mtimeMs: number;
}

export interface FilesListing {
  root: string;
  relative: string;
  entries: FilesEntry[];
  totalSeen: number;
  capped: boolean;
  permissionDenied: boolean;
}

export interface FilePreviewPayload {
  category: 'text' | 'image' | 'pdf' | 'docx' | 'xlsx' | 'external';
  totalSize: number;
  sizeCapBytes: number;
  previewable: boolean;
  oversize?: boolean;
  reason?: string;
  encoding?: 'utf8' | 'binary';
  text?: string;
  data?: Uint8Array;
  path: { root: string; relative: string };
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
  gitDiffFiles: (
    dir: string,
    options: { mode: DiffScope; sessionId?: string },
  ) => Promise<DiffFileList>;
  gitFileDiff: (
    dir: string,
    options: { mode: DiffScope; path: string; ignoreWhitespace?: boolean; sessionId?: string },
  ) => Promise<FileDiffResult>;
  gitMarkTurnStart: (
    dir: string,
    sessionId?: string,
  ) => Promise<{ ok: boolean; baseline?: string | null }>;
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
  gitCommit: (dir: string, options: CommitOptions) => Promise<GitActionResult>;
  gitPush: (dir: string, options: PushOptions) => Promise<GitActionResult>;
  gitFetch: (dir: string) => Promise<GitActionResult>;
  githubAvailable: () => Promise<GithubAvailability>;
  githubDetectPr: (dir: string, options: { branch?: string }) => Promise<DetectPrResult>;
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
  terminalCreate: (options: {
    missionId: string;
    cwd: string;
    cols: number;
    rows: number;
  }) => Promise<TerminalSessionInfo>;
  terminalWrite: (id: string, data: string) => Promise<void>;
  terminalResize: (id: string, cols: number, rows: number) => Promise<void>;
  terminalKill: (id: string) => Promise<void>;
  terminalList: (missionId: string) => Promise<TerminalSessionInfo[]>;
  terminalSubscribe: (id: string) => Promise<void>;
  terminalUnsubscribe: (id: string) => Promise<void>;
  onTerminalEvent: (handler: (event: TerminalEvent) => void) => () => void;
  filesList: (root: string, relative: string) => Promise<FilesListing>;
  filesPreview: (root: string, relative: string) => Promise<FilePreviewPayload>;
  filesOpen: (root: string, relative: string) => Promise<void>;
  filesReveal: (root: string, relative: string) => Promise<void>;
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
  nativeBrowserSetVisible: (sessionId: string, visible: boolean) => Promise<void>;
  nativeBrowserClose: (sessionId: string) => Promise<void>;
  nativeBrowserReload: (sessionId: string) => Promise<void>;
  nativeBrowserGoBack: (sessionId: string) => Promise<boolean>;
  nativeBrowserGoForward: (sessionId: string) => Promise<boolean>;
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

export async function createTerminal(options: {
  missionId: string;
  cwd: string;
  cols: number;
  rows: number;
}): Promise<TerminalSessionInfo> {
  if (!isDesktop()) throw new Error('Terminal is only available in the desktop app.');
  return window.droidControl!.terminalCreate(options);
}

export async function writeTerminal(id: string, data: string): Promise<void> {
  if (!isDesktop()) return;
  await window.droidControl!.terminalWrite(id, data);
}

export async function resizeTerminal(id: string, cols: number, rows: number): Promise<void> {
  if (!isDesktop()) return;
  await window.droidControl!.terminalResize(id, cols, rows);
}

export async function killTerminal(id: string): Promise<void> {
  if (!isDesktop()) return;
  await window.droidControl!.terminalKill(id);
}

export async function listTerminals(missionId: string): Promise<TerminalSessionInfo[]> {
  if (!isDesktop()) return [];
  return window.droidControl!.terminalList(missionId);
}

export async function subscribeTerminal(id: string): Promise<void> {
  if (!isDesktop()) return;
  await window.droidControl!.terminalSubscribe(id);
}

export async function unsubscribeTerminal(id: string): Promise<void> {
  if (!isDesktop()) return;
  await window.droidControl!.terminalUnsubscribe(id);
}

export function onTerminalEvent(handler: (event: TerminalEvent) => void): () => void {
  if (!isDesktop()) return () => {};
  return window.droidControl!.onTerminalEvent(handler);
}

export async function listDirectory(root: string, relative = ''): Promise<FilesListing> {
  if (!isDesktop()) throw new Error('Files are only available in the desktop app.');
  return window.droidControl!.filesList(root, relative);
}

export async function readFilePreview(root: string, relative: string): Promise<FilePreviewPayload> {
  if (!isDesktop()) throw new Error('Files are only available in the desktop app.');
  return window.droidControl!.filesPreview(root, relative);
}

export async function openFileDefault(root: string, relative: string): Promise<void> {
  if (!isDesktop()) return;
  await window.droidControl!.filesOpen(root, relative);
}

export async function revealFile(root: string, relative: string): Promise<void> {
  if (!isDesktop()) return;
  await window.droidControl!.filesReveal(root, relative);
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
