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
import type {
  AppUpdateCheckOptions,
  AppUpdateInfo,
  AppUpdateResult,
  OnboardingState,
} from './onboarding';
import type { AppIconMode } from './appIcon';
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
  GithubSetupResult,
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
  appSessionId: string;
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

export type FeedbackCategory = 'bug' | 'bad_result' | 'good_result' | 'safety' | 'other';

export interface FeedbackAttachments {
  sessionLog?: boolean;
  screenshot?: boolean;
  appState?: boolean;
}

export interface FeedbackReportRequest {
  category: FeedbackCategory;
  description: string;
  attachments?: FeedbackAttachments;
  attachmentData?: {
    sessionLog?: { category: string; message: string; level?: string; timestamp: number }[];
    appState?: Record<string, unknown>;
  };
}

export interface FeedbackReportReceipt {
  reportId: string;
  userId: string;
  eventId: string;
}

export interface NotifyOptions {
  /** When true, the OS notification plays without sound. */
  silent?: boolean;
  /** Session to open when the user clicks the notification. */
  appSessionId?: string;
}

export type NotifyResult =
  | { shown: true }
  | {
      shown: false;
      reason: 'unsupported' | 'permission_denied' | 'failed' | 'timeout';
      message?: string;
    };

export type NotificationPermissionResult = 'granted' | 'denied' | 'default' | 'unsupported';

interface DroidControlApi {
  bridgeInfo: () => Promise<BridgeInfo>;
  pickDirectory: () => Promise<string | null>;
  pickFiles: () => Promise<string[]>;
  saveImage: (dataUrl: string) => Promise<string>;
  discardImage: (path: string) => Promise<void>;
  notify: (title: string, body: string, options?: NotifyOptions) => Promise<NotifyResult>;
  onNotificationActivate: (handler: (payload: { appSessionId: string }) => void) => () => void;
  takePendingNotificationSession: () => Promise<{ appSessionId: string } | null>;
  ackNotificationActivate: (appSessionId: string) => Promise<{ ok: boolean }>;
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
    options: { mode: DiffScope; appSessionId?: string },
  ) => Promise<DiffFileList>;
  gitFileDiff: (
    dir: string,
    options: { mode: DiffScope; path: string; ignoreWhitespace?: boolean; appSessionId?: string },
  ) => Promise<FileDiffResult>;
  gitMarkTurnStart: (
    dir: string,
    appSessionId?: string,
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
  githubInstall: () => Promise<GithubSetupResult>;
  githubAuthenticate: () => Promise<GithubSetupResult>;
  githubCancelSetup: () => Promise<{ ok: true }>;
  onGithubAuthCode: (handler: (payload: unknown) => void) => () => void;
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
  checkAppUpdate: (options: AppUpdateCheckOptions) => Promise<AppUpdateInfo>;
  downloadAppUpdate: () => Promise<AppUpdateResult>;
  submitFeedbackReport: (report: FeedbackReportRequest) => Promise<FeedbackReportReceipt>;
  relaunchApp: () => Promise<void>;
  setAppIcon: (mode: AppIconMode) => Promise<AppIconMode>;
  openExternal: (url: string) => Promise<void>;
  terminalCreate: (options: {
    appSessionId: string;
    cwd: string;
    cols: number;
    rows: number;
  }) => Promise<TerminalSessionInfo>;
  terminalWrite: (id: string, data: string) => Promise<void>;
  terminalResize: (id: string, cols: number, rows: number) => Promise<void>;
  terminalKill: (id: string) => Promise<void>;
  terminalList: (appSessionId: string) => Promise<TerminalSessionInfo[]>;
  terminalSubscribe: (id: string) => Promise<void>;
  terminalUnsubscribe: (id: string) => Promise<void>;
  onTerminalEvent: (handler: (event: TerminalEvent) => void) => () => void;
  filesAuthorizeRoot: (root: string) => Promise<string>;
  filesList: (accessToken: string, relative: string) => Promise<FilesListing>;
  filesPreview: (accessToken: string, relative: string) => Promise<FilePreviewPayload>;
  filesOpen: (accessToken: string, relative: string) => Promise<void>;
  filesReveal: (accessToken: string, relative: string) => Promise<void>;
  nativeBrowserOpen: (
    browserSessionId: string,
    url: string,
    bounds?: NativeBrowserBounds,
    viewport?: { width: number; height: number; deviceScaleFactor: number },
  ) => Promise<void>;
  nativeBrowserAttach: (
    browserSessionId: string,
    bounds: NativeBrowserBounds,
    url?: string,
  ) => Promise<void>;
  nativeBrowserDetach: (browserSessionId?: string) => Promise<void>;
  nativeBrowserSetBounds: (browserSessionId: string, bounds: NativeBrowserBounds) => Promise<void>;
  nativeBrowserSetVisible: (browserSessionId: string, visible: boolean) => Promise<void>;
  nativeBrowserClose: (browserSessionId: string) => Promise<void>;
  nativeBrowserReload: (browserSessionId: string) => Promise<void>;
  nativeBrowserGoBack: (browserSessionId: string) => Promise<boolean>;
  nativeBrowserGoForward: (browserSessionId: string) => Promise<boolean>;
  nativeBrowserSetDesignMode: (browserSessionId: string, active: boolean) => Promise<void>;
  nativeBrowserSetPencilMode: (browserSessionId: string, active: boolean) => Promise<void>;
  nativeBrowserAgentAction: (
    request: NativeBrowserAgentAction,
  ) => Promise<NativeBrowserAgentResult | undefined>;
  nativeBrowserCapture: (
    browserSessionId: string,
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

function desktopApi(): DroidControlApi | undefined {
  return typeof window !== 'undefined' ? window.droidControl : undefined;
}

export const isDesktop = () => Boolean(desktopApi());

function requireDesktopApi(message: string): DroidControlApi {
  const api = desktopApi();
  if (!api) throw new Error(message);
  return api;
}

export async function getBridgeInfo(): Promise<BridgeInfo> {
  const api = desktopApi();
  if (!api) return { port: 8765, token: '' };
  return api.bridgeInfo();
}

export async function pickDirectory(): Promise<string | null> {
  const api = desktopApi();
  if (!api) return null;
  return api.pickDirectory();
}

export async function pickFiles(): Promise<string[]> {
  const api = desktopApi();
  if (!api) return [];
  try {
    return await api.pickFiles();
  } catch {
    return [];
  }
}

// Persists an image data URL into the temp attachments dir; the returned path
// is what the prompt @-mentions. Only the desktop app can write to disk.
export async function saveImage(dataUrl: string): Promise<string> {
  return requireDesktopApi('Image attachments need the desktop app.').saveImage(dataUrl);
}

export async function discardImage(path: string): Promise<void> {
  const api = desktopApi();
  if (!api) return;
  try {
    await api.discardImage(path);
  } catch {
    /* already gone */
  }
}

export async function notify(
  title: string,
  body: string,
  options: NotifyOptions = {},
): Promise<NotifyResult> {
  const api = desktopApi();
  if (!api) return { shown: false, reason: 'unsupported' };
  return api.notify(title, body, options);
}

export async function requestNotificationPermission(): Promise<NotificationPermissionResult> {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const permission = await Notification.requestPermission();
    if (permission === 'granted' || permission === 'denied') return permission;
    return 'default';
  } catch {
    return 'unsupported';
  }
}

/** Subscribe to notification clicks that should open a specific chat. */
export function onNotificationActivate(
  handler: (payload: { appSessionId: string }) => void,
): () => void {
  const api = desktopApi();
  if (!api) return () => undefined;
  return api.onNotificationActivate(handler);
}

/** Pull a pending open-session request queued by a notification click. */
export async function takePendingNotificationSession(): Promise<{
  appSessionId: string;
} | null> {
  const api = desktopApi();
  if (!api) return null;
  const pending = await api.takePendingNotificationSession();
  if (!pending || typeof pending.appSessionId !== 'string' || !pending.appSessionId.trim()) {
    return null;
  }
  return { appSessionId: pending.appSessionId.trim() };
}

export async function ackNotificationActivate(appSessionId: string): Promise<void> {
  const api = desktopApi();
  if (!api) return;
  try {
    await api.ackNotificationActivate(appSessionId);
  } catch {
    /* ignore */
  }
}

export async function getApiKey(): Promise<string | null> {
  const api = desktopApi();
  if (!api) return null;
  return api.getApiKey();
}

export async function setApiKey(key: string): Promise<void> {
  const api = desktopApi();
  if (!api) return;
  await api.setApiKey(key);
}

export async function clearApiKey(): Promise<void> {
  const api = desktopApi();
  if (!api) return;
  await api.clearApiKey();
}

export async function setAppIcon(mode: AppIconMode): Promise<void> {
  const api = desktopApi();
  if (!api) return;
  await api.setAppIcon(mode);
}

export async function createTerminal(options: {
  appSessionId: string;
  cwd: string;
  cols: number;
  rows: number;
}): Promise<TerminalSessionInfo> {
  return requireDesktopApi('Terminal is only available in the desktop app.').terminalCreate(
    options,
  );
}

export async function writeTerminal(id: string, data: string): Promise<void> {
  const api = desktopApi();
  if (!api) return;
  await api.terminalWrite(id, data);
}

export async function resizeTerminal(id: string, cols: number, rows: number): Promise<void> {
  const api = desktopApi();
  if (!api) return;
  await api.terminalResize(id, cols, rows);
}

export async function killTerminal(id: string): Promise<void> {
  const api = desktopApi();
  if (!api) return;
  await api.terminalKill(id);
}

export async function listTerminals(appSessionId: string): Promise<TerminalSessionInfo[]> {
  const api = desktopApi();
  if (!api) return [];
  return api.terminalList(appSessionId);
}

export async function subscribeTerminal(id: string): Promise<void> {
  const api = desktopApi();
  if (!api) return;
  await api.terminalSubscribe(id);
}

export async function unsubscribeTerminal(id: string): Promise<void> {
  const api = desktopApi();
  if (!api) return;
  await api.terminalUnsubscribe(id);
}

export function onTerminalEvent(handler: (event: TerminalEvent) => void): () => void {
  const api = desktopApi();
  if (!api) return () => undefined;
  return api.onTerminalEvent(handler);
}

export async function authorizeFilesRoot(root: string): Promise<string> {
  return requireDesktopApi('Files are only available in the desktop app.').filesAuthorizeRoot(root);
}

export async function listDirectory(accessToken: string, relative = ''): Promise<FilesListing> {
  return requireDesktopApi('Files are only available in the desktop app.').filesList(
    accessToken,
    relative,
  );
}

export async function readFilePreview(
  accessToken: string,
  relative: string,
): Promise<FilePreviewPayload> {
  return requireDesktopApi('Files are only available in the desktop app.').filesPreview(
    accessToken,
    relative,
  );
}

export async function openFileDefault(accessToken: string, relative: string): Promise<void> {
  const api = desktopApi();
  if (!api) return;
  await api.filesOpen(accessToken, relative);
}

export async function revealFile(accessToken: string, relative: string): Promise<void> {
  const api = desktopApi();
  if (!api) return;
  await api.filesReveal(accessToken, relative);
}

export async function listFiles(dir: string): Promise<string[]> {
  const api = desktopApi();
  if (!api) return [];
  try {
    return await api.listFiles(dir);
  } catch {
    return [];
  }
}

export async function readFile(path: string): Promise<string | null> {
  const api = desktopApi();
  if (!api) return null;
  try {
    return await api.readFile(path);
  } catch {
    return null;
  }
}

export async function getRepoStatus(dir: string): Promise<RepoStatus | null> {
  const api = desktopApi();
  if (!api) return null;
  try {
    return await api.repoStatus(dir);
  } catch {
    return null;
  }
}

export async function openProject(
  dir: string,
  editor: EditorId,
  target: EditorTarget,
): Promise<void> {
  const api = desktopApi();
  if (!api) return;
  await api.openProject(dir, editor, target);
}

export async function listEditors(): Promise<EditorId[]> {
  const api = desktopApi();
  if (!api) return [];
  try {
    return await api.listEditors();
  } catch {
    return [];
  }
}
