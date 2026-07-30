import { useState, useRef, useEffect, useMemo, type SetStateAction } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useStore } from '../hooks/useStore';
import type { QueuedPrompt } from '../hooks/useStore';
import { useSessionLive } from '../hooks/useSessionLive';
import {
  sendSessionPrompt,
  sendToChild,
  sendToChildNow,
  createSession,
  interruptVisibleSession,
  compactSession,
  updateSessionSettings,
  newClientRef,
  listSkills,
} from '../lib/commands';
import { pickDirectory, pickFiles, listFiles, isDesktop } from '../lib/desktop';
import { type AttachedImage, useImageAttachments } from '../hooks/useImageAttachments';
import { useImageFileDrop } from '../hooks/useImageFileDrop';
import { ImageChip } from './composer/ImageChip';
import { ImageViewerModal } from './composer/ImageViewerModal';
import PlanSteps from './composer/PlanSteps';
import { markGitTurnStart } from '../lib/git';
import {
  createLocalUserTranscriptEvent,
  newQueueId,
  shouldQueueSessionPrompt,
  type SessionPromptMode,
} from '../lib/promptQueue';
import { composePrompt } from '../lib/composePrompt';
import { resolveReasoningEffortDisplay } from '../lib/reasoningEffort';
import { compactionSettingsSnapshot } from '../lib/compactionSettings';
import { resetComposerAfterSubmit } from '../lib/composerReset';
import {
  childRuntimeSubmitTarget,
  childSessionLabel,
  commitChildPromptAfterBaseline,
  orderedChildSessions,
  visibleSessionCanCompact,
  visibleSessionTarget,
  type VisibleSessionTarget,
} from '../lib/childSessions';
import {
  ChevronDown,
  Plus,
  SlidersHorizontal,
  FileText,
  X,
  ListPlus,
  GripVertical,
  Pencil,
  MousePointerSquareDashed,
} from 'lucide-react';
import ComposerMenu, { type MenuItem, type SlashCommand } from './ComposerMenu';
import ModelSelectorPopover from './ModelSelectorPopover';
import {
  buildVisibleChildSettingsTarget,
  childSettingsReadinessLabel,
} from '../lib/exactChildSettings';
import ContextStatusCluster from './ContextStatusCluster';
import PermissionInline from './PermissionInline';
import PlanApprovalInline from './PlanApprovalInline';
import { ModelIcon, providerOf } from './ModelIcon';
import SessionComposer from './SessionComposer';
import { StartInBar } from './environment/StartInBar';
import type { SkillInfo } from '../types/bridge';

const ACCENT = 'var(--droid-accent)';
const accentMix = (pct: number) => `color-mix(in srgb, var(--droid-accent) ${pct}%, transparent)`;

interface Trigger {
  kind: 'slash' | 'file';
  query: string;
  start: number;
  end: number;
}

function getTrigger(text: string, caret: number): Trigger | null {
  const upto = text.slice(0, caret);
  const m = upto.match(/(^|\s)([/@][^\s]*)$/);
  if (!m) return null;
  const token = m[2];
  const start = caret - token.length;
  return { kind: token[0] === '/' ? 'slash' : 'file', query: token.slice(1), start, end: caret };
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

const COMPACT_COMMANDS = new Set(['/compact', '/compaction', '/compression']);

export default function PromptInput({
  rightInset = false,
  compact = false,
  onOverlayChange,
}: {
  rightInset?: boolean;
  compact?: boolean;
  onOverlayChange?: (open: boolean) => void;
}) {
  const { state, dispatch } = useStore();
  const composerRevisionRef = useRef(0);
  const [input, setInputState] = useState('');
  const setInput = (value: SetStateAction<string>) => {
    composerRevisionRef.current += 1;
    setInputState(value);
  };
  const [caret, setCaret] = useState(0);
  // Shell-style prompt history: null while composing, otherwise an index into
  // promptHistory. The draft is stashed so ArrowDown past the newest restores it.
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const draftBeforeHistory = useRef('');
  const [modelsOpen, setModelsOpen] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  const [filesCwd, setFilesCwd] = useState<string | null>(null);
  const [attachedFiles, setAttachedFilesState] = useState<string[]>([]);
  const setAttachedFiles = (value: SetStateAction<string[]>) => {
    composerRevisionRef.current += 1;
    setAttachedFilesState(value);
  };
  const imageAttachments = useImageAttachments(state.imagePasteQuality);
  const fileDrop = useImageFileDrop(imageAttachments.addBlob);
  const [viewerImageId, setViewerImageId] = useState<string | null>(null);
  const [activeSkills, setActiveSkillsState] = useState<SkillInfo[]>([]);
  const setActiveSkills = (value: SetStateAction<SkillInfo[]>) => {
    composerRevisionRef.current += 1;
    setActiveSkillsState(value);
  };
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [actionOverlayOpen, setActionOverlayOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const submittingRef = useRef(false);
  const pendingCaret = useRef<number | null>(null);
  const activeSession = state.activeAppSessionId ? state.sessions[state.activeAppSessionId] : null;
  const primaryIsLive = useSessionLive(state.activeAppSessionId);

  // The user's own prompts in this conversation, oldest to newest, for ArrowUp
  // recall (reuse a previous prompt). Consecutive duplicates are collapsed.
  const promptHistory = useMemo(() => {
    const events = activeSession ? (state.transcripts[activeSession.appSessionId] ?? []) : [];
    const out: string[] = [];
    for (const ev of events) {
      if (ev.author !== 'user' || ev.kind !== 'text') continue;
      const text = ev.text ?? '';
      if (!text.trim()) continue;
      if (out[out.length - 1] !== text) out.push(text);
    }
    return out;
  }, [activeSession?.appSessionId, state.transcripts]);
  // For an existing chat session the mode is whatever the session actually is
  // (so a chat reopened in spec mode shows Spec); only fall back to the global
  // compose flag while drafting a brand-new chat.
  const isSpecMode =
    activeSession?.sessionPurpose !== 'mission-control'
      ? activeSession?.interactionMode === 'spec' || (!activeSession && state.specMode)
      : false;
  const selectedChild = state.selectedChild;
  const visibleTarget: VisibleSessionTarget = visibleSessionTarget(
    activeSession?.appSessionId,
    selectedChild,
    state.childSessions,
    state.childAccess,
  );
  const visibleTargetRef = useRef(visibleTarget);
  visibleTargetRef.current = visibleTarget;
  const targetChild = visibleTarget.kind === 'child' ? visibleTarget.child : undefined;
  const targetChildSessionId = targetChild?.childSessionId ?? null;
  const targetChildIndex =
    visibleTarget.kind === 'child' && activeSession
      ? orderedChildSessions(
          Object.values(state.childSessions[activeSession.appSessionId] ?? {}),
        ).findIndex((childSession) => childSession.childSessionId === visibleTarget.childSessionId)
      : -1;
  const childSettingsTarget = buildVisibleChildSettingsTarget(
    visibleTarget,
    targetChild ? childSessionLabel(targetChild, Math.max(0, targetChildIndex)) : 'Child session',
  );
  const childActionsEnabled = visibleTarget.kind !== 'child' || visibleTarget.canSend;
  const primaryActionsEnabled = visibleSessionCanCompact(visibleTarget);
  const isLive = visibleTarget.kind === 'child' ? visibleTarget.canInterrupt : primaryIsLive;

  const cwd = activeSession?.cwd ?? state.draftChat?.cwd ?? null;
  const skillsProviderSessionId = activeSession?.providerSessionId ?? null;
  const pendingSkillsRequest = useRef<{
    providerSessionId: string | null;
    requestedAt: number;
  } | null>(null);

  // Toggle spec mode. When a live chat session exists, switch its interaction
  // mode for real (not just the compose flag used for brand-new chats).
  const toggleSpec = () => {
    if (activeSession && activeSession.sessionPurpose !== 'mission-control') {
      // Existing live chat: flip the session's real interaction mode and
      // optimistically update its interaction mode so the toggle reflects immediately.
      const turningOn = !isSpecMode;
      dispatch({
        type: 'SESSION_SET_INTERACTION_MODE',
        appSessionId: activeSession.appSessionId,
        interactionMode: turningOn ? 'spec' : 'auto',
      });
      updateSessionSettings({
        appSessionId: activeSession.appSessionId,
        interactionMode: turningOn ? 'spec' : 'auto',
      });
    } else {
      // Brand-new draft chat with no session yet: just flip the compose flag.
      dispatch({ type: 'TOGGLE_SPEC_MODE' });
    }
  };

  const slashCommands: SlashCommand[] = [
    {
      cmd: '/mission',
      desc: 'Enter Mission Control',
      run: () => dispatch({ type: 'TOGGLE_MISSION_CONTROL' }),
    },
    { cmd: '/model', desc: 'Open model selector', run: () => setModelsOpen(true) },
    {
      cmd: '/compact',
      desc: 'Compact current session',
      run: () =>
        primaryActionsEnabled && activeSession && compactSession(activeSession.appSessionId),
    },
    {
      cmd: '/compaction',
      desc: 'Compact current session',
      run: () =>
        primaryActionsEnabled && activeSession && compactSession(activeSession.appSessionId),
    },
    {
      cmd: '/compression',
      desc: 'Compact current session',
      run: () =>
        primaryActionsEnabled && activeSession && compactSession(activeSession.appSessionId),
    },
    { cmd: '/spec', desc: 'Toggle spec mode', run: () => toggleSpec() },
    { cmd: '/settings', desc: 'Open settings', run: () => dispatch({ type: 'TOGGLE_SETTINGS' }) },
  ];

  const trigger = useMemo(() => getTrigger(input, caret), [input, caret]);
  const overlayOpen = Boolean(trigger || modelsOpen || actionOverlayOpen);

  useEffect(() => {
    onOverlayChange?.(overlayOpen);
  }, [onOverlayChange, overlayOpen]);

  useEffect(
    () => () => {
      onOverlayChange?.(false);
    },
    [onOverlayChange],
  );

  const invocableSkills = useMemo(
    () =>
      state.skillsProviderSessionId === skillsProviderSessionId
        ? state.skills.filter((s) => s.userInvocable !== false && s.enabled !== false)
        : [],
    [skillsProviderSessionId, state.skills, state.skillsProviderSessionId],
  );

  useEffect(() => {
    if (trigger?.kind !== 'slash') {
      pendingSkillsRequest.current = null;
      return;
    }
    if (state.skillsProviderSessionId === skillsProviderSessionId) {
      pendingSkillsRequest.current = null;
      return;
    }
    const pending = pendingSkillsRequest.current;
    const now = Date.now();
    if (pending?.providerSessionId === skillsProviderSessionId && now - pending.requestedAt < 2_000)
      return;
    pendingSkillsRequest.current = {
      providerSessionId: skillsProviderSessionId,
      requestedAt: now,
    };
    listSkills(activeSession?.providerSessionId);
  }, [
    activeSession?.providerSessionId,
    skillsProviderSessionId,
    state.skillsProviderSessionId,
    trigger?.kind,
    trigger?.query,
    trigger?.start,
  ]);

  const menuItems = useMemo<MenuItem[]>(() => {
    if (!trigger) return [];
    const q = trigger.query.toLowerCase();
    if (trigger.kind === 'slash') {
      const cmds: MenuItem[] = slashCommands
        .filter((c) => c.cmd.slice(1).toLowerCase().includes(q))
        .map((command) => ({ type: 'command', command }));
      const skills: MenuItem[] = invocableSkills
        .filter(
          (s) =>
            s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q),
        )
        .slice(0, 40)
        .map((skill) => ({ type: 'skill', skill }));
      return [...cmds, ...skills];
    }
    // file mode
    const matches = files
      .filter((f) => f.toLowerCase().includes(q))
      .sort((a, b) => {
        const aw = basename(a).toLowerCase().startsWith(q) ? 0 : 1;
        const bw = basename(b).toLowerCase().startsWith(q) ? 0 : 1;
        return aw - bw || a.length - b.length;
      })
      .slice(0, 50)
      .map<MenuItem>((path) => ({ type: 'file', path }));
    return matches;
  }, [trigger, files, invocableSkills, slashCommands]);

  const menuOpen = !!trigger && menuItems.length > 0;

  // Lazy-load files when an @-trigger is active and cwd changed.
  useEffect(() => {
    if (!trigger || trigger.kind !== 'file' || !cwd) return;
    if (filesCwd === cwd) return;
    let cancelled = false;
    void listFiles(cwd).then((list) => {
      if (!cancelled) {
        setFiles(list);
        setFilesCwd(cwd);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [trigger, cwd, filesCwd]);

  useEffect(() => {
    setMenuIndex(0);
  }, [trigger?.kind, trigger?.query]);

  // Leave history-recall mode and drop any composer draft attachments when
  // switching conversations. Unsent pasted images have no prompt owner, so
  // discard their temporary files as well.
  const clearAndDiscardImages = imageAttachments.clearAndDiscard;
  useEffect(() => {
    setHistoryIndex(null);
    setActiveSkills([]);
    setAttachedFiles([]);
    clearAndDiscardImages();
  }, [activeSession?.appSessionId, clearAndDiscardImages]);

  const composerSeed = state.composerSeed;
  useEffect(() => {
    if (!composerSeed) return;
    setHistoryIndex(null);
    const text = input.trim() ? `${input.trimEnd()}\n\n${composerSeed.text}` : composerSeed.text;
    setInput(text);
    pendingCaret.current = text.length;
    dispatch({ type: 'CLEAR_COMPOSER_SEED' });
  }, [composerSeed, input, dispatch]);

  // Restore caret after programmatic token replacement.
  useEffect(() => {
    if (pendingCaret.current != null && textareaRef.current) {
      const pos = pendingCaret.current;
      pendingCaret.current = null;
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(pos, pos);
      setCaret(pos);
    }
  }, [input]);

  const missionPreview = activeSession
    ? activeSession.sessionPurpose === 'mission-control'
    : state.missionControlMode;

  // A single chat carries its own model/reasoning; only fall back to the global
  // default while composing a brand-new chat that has no session yet.
  const chatScoped = !missionPreview && !!activeSession;
  const primaryModelId = chatScoped ? activeSession.modelId : state.agentConfig.primary.modelId;
  const selectedModel = primaryModelId
    ? state.models.find((m) => m.id === primaryModelId)
    : undefined;
  const selectedModelLabel = primaryModelId
    ? (selectedModel?.displayName ?? primaryModelId)
    : 'Default model';
  const primaryReasoning = resolveReasoningEffortDisplay(
    chatScoped ? activeSession.reasoningEffort : undefined,
    state.agentConfig.primary.reasoning,
    selectedModel,
  );
  const showReasoningBadge =
    !selectedModel || (selectedModel.supportedReasoningEfforts?.length ?? 0) > 0;

  const replaceTrigger = (replacement: string) => {
    if (!trigger) return;
    const before = input.slice(0, trigger.start);
    const after = input.slice(trigger.end);
    const next = before + replacement + after;
    pendingCaret.current = before.length + replacement.length;
    setInput(next);
  };

  const addFile = (path: string) => {
    setAttachedFiles((prev) => (prev.includes(path) ? prev : [...prev, path]));
    replaceTrigger('');
  };

  const handleAttachFiles = async () => {
    if (!isDesktop()) {
      const next = input.length === 0 || input.endsWith(' ') ? `${input}@` : `${input} @`;
      setInput(next);
      pendingCaret.current = next.length;
      return;
    }
    const paths = await pickFiles();
    if (paths.length > 0) {
      setAttachedFiles((previous) => [
        ...previous,
        ...paths.filter((path) => !previous.includes(path)),
      ]);
    }
  };

  const selectSkill = (skill: SkillInfo) => {
    setActiveSkills((prev) =>
      prev.some((s) => s.filePath === skill.filePath) ? prev : [...prev, skill],
    );
    replaceTrigger('');
  };

  const runCommand = (s: SlashCommand) => {
    replaceTrigger('');
    s.run();
  };

  const runMenuItem = (item: MenuItem) => {
    if (item.type === 'command') runCommand(item.command);
    else if (item.type === 'skill') selectSkill(item.skill);
    else addFile(item.path);
  };

  const composeFrom = composePrompt;

  const composeText = (text: string, images: AttachedImage[]): string =>
    composeFrom(
      text,
      activeSkills.map((s) => s.name),
      [...attachedFiles, ...images.map((image) => image.path)],
    );

  // Re-entry guard: a send awaits markGitTurnStart before the input is cleared,
  // so without this a second Enter/click during that window would resend the
  // same payload (and create a duplicate session turn).
  const handleSubmit = async (mode: SessionPromptMode = 'queue') => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    try {
      await runSubmit(mode);
    } finally {
      submittingRef.current = false;
    }
  };

  const runSubmit = async (mode: SessionPromptMode = 'queue') => {
    const text = input.trim();
    const composerRevision = composerRevisionRef.current;
    const readyImages = await imageAttachments.whenSettled();
    const allFiles = [...attachedFiles, ...readyImages.map((image) => image.path)];
    const hasPayload = text || activeSkills.length > 0 || allFiles.length > 0;
    if (!hasPayload) return;
    setHistoryIndex(null);

    const clearAfterSubmit = () => {
      resetComposerAfterSubmit({
        draftUntouched: composerRevisionRef.current === composerRevision,
        clearImages: imageAttachments.clear,
        resetDraft: () => {
          setInput('');
          setActiveSkills([]);
          setAttachedFiles([]);
        },
      });
    };

    if (text === '/mission' && activeSkills.length === 0 && allFiles.length === 0) {
      dispatch({ type: 'TOGGLE_MISSION_CONTROL' });
      clearAfterSubmit();
      return;
    }

    if (COMPACT_COMMANDS.has(text) && activeSkills.length === 0 && allFiles.length === 0) {
      if (!primaryActionsEnabled) return;
      if (activeSession) compactSession(activeSession.appSessionId);
      clearAfterSubmit();
      return;
    }

    if (!childActionsEnabled) return;

    const composed = composeText(text, readyImages);

    const skillNames = activeSkills.map((s) => s.name);
    const registerPending = (ref: string) =>
      dispatch({
        type: 'SET_PENDING_COMPOSE',
        clientRef: ref,
        text,
        skills: skillNames,
        files: allFiles,
      });

    // Mission Control preview with no active session: prompt is the objective.
    if (missionPreview && !activeSession) {
      const dir = state.draftChat?.cwd ?? (await pickDirectory());
      if (!dir) return;
      const { primary, worker, validator } = state.agentConfig;
      const clientRef = newClientRef();
      registerPending(clientRef);
      // Clear the composer before the git-baseline await below so a prompt the
      // user starts typing during that delay is never wiped by a late clear.
      clearAfterSubmit();
      // Snapshot the tree before the agent's first turn so the Review "Last
      // turn" scope only attributes changes this session actually makes.
      await markGitTurnStart(dir);
      createSession({
        clientRef,
        cwd: dir,
        title: (text || activeSkills[0]?.name || 'Mission').slice(0, 48),
        goal: composed,
        sessionPurpose: 'mission-control',
        interactionMode: 'agi',
        autonomy: 'medium',
        modelId: primary.modelId,
        reasoningEffort: primary.reasoning,
        compactionModel:
          state.compactionModel === 'current-model' ? undefined : state.compactionModel,
        // Only user-configured limits may override the daemon's model default.
        ...compactionSettingsSnapshot(state),
        workerModel: worker.modelId,
        workerReasoning: worker.reasoning,
        validatorModel: validator.modelId,
        validatorReasoning: validator.reasoning,
      });
      return;
    }

    // Draft/default chat: first message creates the session. No workspace is required.
    if (!activeSession) {
      const dir = state.draftChat?.cwd ?? '';
      const { primary } = state.agentConfig;
      const clientRef = newClientRef();
      registerPending(clientRef);
      // Clear before the baseline await (see above) so fast typing isn't lost.
      clearAfterSubmit();
      if (dir) await markGitTurnStart(dir);
      createSession({
        clientRef,
        cwd: dir,
        title: (text || activeSkills[0]?.name || 'Chat').slice(0, 48),
        goal: composed,
        sessionPurpose: 'chat',
        interactionMode: isSpecMode ? 'spec' : 'auto',
        autonomy: 'medium',
        modelId: primary.modelId,
        reasoningEffort: primary.reasoning,
        compactionModel:
          state.compactionModel === 'current-model' ? undefined : state.compactionModel,
        ...compactionSettingsSnapshot(state),
      });
      return;
    }

    if (!activeSession) return;

    // Model is working and the user chose to queue: stage the prompt locally.
    // It is held client-side and delivered automatically when the turn finishes.
    if (
      shouldQueueSessionPrompt({
        isLive,
        mode,
        isPrimaryTarget: !targetChildSessionId,
      })
    ) {
      dispatch({
        type: 'QUEUE_PROMPT',
        appSessionId: activeSession.appSessionId,
        prompt: { id: newQueueId(), text, skills: skillNames, files: allFiles },
      });
      clearAfterSubmit();
      return;
    }

    const appendTranscript = () => {
      dispatch({
        type: 'SESSION_TRANSCRIPT',
        event: createLocalUserTranscriptEvent({
          appSessionId: activeSession.appSessionId,
          sourceSessionId: targetChildSessionId ?? 'user',
          role: targetChild?.role ?? 'primary',
          text,
          skills: activeSkills.map((s) => s.name),
          files: allFiles,
          steered: isLive && mode === 'now',
        }),
      });
    };
    const resetComposer = clearAfterSubmit;
    const sendCommand = () => {
      try {
        if (targetChildSessionId) {
          if (mode === 'now')
            sendToChildNow(activeSession.appSessionId, targetChildSessionId, composed);
          else sendToChild(activeSession.appSessionId, targetChildSessionId, composed);
        } else sendSessionPrompt(activeSession.appSessionId, composed, mode);
      } catch (err) {
        console.error('[PromptInput] sendToSession failed:', err);
      }
    };

    const childRuntimeTarget = childRuntimeSubmitTarget(visibleTarget);
    if (childRuntimeTarget && activeSession.cwd) {
      await commitChildPromptAfterBaseline({
        capturedTarget: childRuntimeTarget,
        capturedComposerRevision: composerRevisionRef.current,
        waitForBaseline: () => markGitTurnStart(activeSession.cwd, activeSession.appSessionId),
        currentTarget: () => visibleTargetRef.current,
        currentComposerRevision: () => composerRevisionRef.current,
        appendTranscript,
        resetComposer,
        sendCommand,
      });
      return;
    }

    appendTranscript();
    resetComposer();

    // Capture the last-turn baseline before the agent can touch the tree;
    // a fire-and-forget call here races the first edit and corrupts the diff.
    if (!childRuntimeTarget && activeSession.cwd)
      await markGitTurnStart(activeSession.cwd, activeSession.appSessionId);
    sendCommand();
  };

  const queue: QueuedPrompt[] = activeSession
    ? (state.promptQueue[activeSession.appSessionId] ?? [])
    : [];

  const editQueuedInComposer = (p: QueuedPrompt) => {
    if (!activeSession) return;
    imageAttachments.clearAndDiscard();
    setInput(p.text);
    setAttachedFiles(p.files);
    setActiveSkills(invocableSkills.filter((s) => p.skills.includes(s.name)));
    dispatch({ type: 'REMOVE_QUEUED_PROMPT', appSessionId: activeSession.appSessionId, id: p.id });
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const handleQueueDrop = (to: number) => {
    if (activeSession && dragIndex !== null && dragIndex !== to) {
      dispatch({
        type: 'REORDER_QUEUE',
        appSessionId: activeSession.appSessionId,
        from: dragIndex,
        to,
      });
    }
    setDragIndex(null);
    setDragOverIndex(null);
  };

  const syncCaret = (el: HTMLTextAreaElement) => setCaret(el.selectionStart ?? 0);

  const handleComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (menuOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMenuIndex((i) => (i + 1) % menuItems.length);
        return true;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMenuIndex((i) => (i - 1 + menuItems.length) % menuItems.length);
        return true;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        runMenuItem(menuItems[Math.min(menuIndex, menuItems.length - 1)]);
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        replaceTrigger('');
        return true;
      }
    }
    if (
      e.key === 'Backspace' &&
      input === '' &&
      (attachedFiles.length > 0 || imageAttachments.images.length > 0)
    ) {
      e.preventDefault();
      if (attachedFiles.length > 0) setAttachedFiles((previous) => previous.slice(0, -1));
      else imageAttachments.remove(imageAttachments.images[imageAttachments.images.length - 1].id);
      return true;
    }
    // Shell-style history recall. ArrowUp starts only from the top of the field
    // (so it doesn't hijack caret movement in a multi-line draft); once in
    // history, arrows step through past prompts and ArrowDown exits at the draft.
    const plain = !e.shiftKey && !e.metaKey && !e.altKey && !e.ctrlKey;
    if (e.key === 'ArrowUp' && plain && promptHistory.length > 0) {
      const el = e.currentTarget;
      const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
      if (historyIndex !== null || atStart) {
        e.preventDefault();
        if (historyIndex === null) draftBeforeHistory.current = input;
        const nextIndex =
          historyIndex === null ? promptHistory.length - 1 : Math.max(0, historyIndex - 1);
        setHistoryIndex(nextIndex);
        const text = promptHistory[nextIndex];
        setInput(text);
        pendingCaret.current = text.length;
        return true;
      }
    }
    if (e.key === 'ArrowDown' && plain && historyIndex !== null) {
      e.preventDefault();
      const text =
        historyIndex >= promptHistory.length - 1
          ? draftBeforeHistory.current
          : promptHistory[historyIndex + 1];
      setHistoryIndex(historyIndex >= promptHistory.length - 1 ? null : historyIndex + 1);
      setInput(text);
      pendingCaret.current = text.length;
      return true;
    }
    return false;
  };

  const boxBorder = isSpecMode
    ? 'border-droid-orange/40 focus-within:border-droid-orange/60'
    : 'border-droid-border focus-within:border-droid-border-hover';

  const hasChips =
    activeSkills.length > 0 || attachedFiles.length > 0 || imageAttachments.images.length > 0;
  const viewerImage = imageAttachments.images.find((image) => image.id === viewerImageId) ?? null;
  // The "Start in" repo/worktree/branch row only applies while drafting a brand
  // new chat; it renders as the top section of the composer card.
  const showStartIn = !activeSession && !missionPreview && !!cwd;
  const idleSendTooltip = childActionsEnabled
    ? 'Enter: send\nShift+Enter: newline'
    : 'This child transcript is read-only';
  const hasContent =
    input.trim().length > 0 ||
    activeSkills.length > 0 ||
    attachedFiles.length > 0 ||
    imageAttachments.images.length > 0;

  return (
    <div
      className={`w-full min-w-0 shrink-0 ${compact ? 'px-3 pb-3 pt-2' : 'px-6 pb-5 pt-2'}`}
      style={{ paddingRight: rightInset ? 312 : undefined, transition: 'padding-right 0.2s ease' }}
    >
      <div
        className={`relative mx-auto min-w-0 ${compact ? 'max-w-4xl' : 'max-w-3xl'}`}
        onDragOver={fileDrop.onDragOver}
        onDrop={fileDrop.onDrop}
      >
        <ComposerMenu
          open={menuOpen}
          triggerKind={trigger?.kind ?? null}
          filesLoading={!filesCwd}
          items={menuItems}
          activeIndex={menuIndex}
          activeSkills={activeSkills}
          attachedFiles={attachedFiles}
          onHoverItem={setMenuIndex}
          onRunItem={runMenuItem}
        />

        <PlanApprovalInline />
        <PermissionInline />

        {missionPreview ? (
          <div
            className="absolute -top-5 left-1 flex items-center gap-1.5 text-[10px] font-medium tracking-wide"
            style={{ color: ACCENT }}
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: ACCENT }} />
            Mission preview
          </div>
        ) : isSpecMode ? (
          <div className="absolute -top-5 left-1 text-[10px] font-medium text-droid-orange tracking-wide">
            SPEC MODE
          </div>
        ) : null}

        {queue.length > 0 && (
          <div className="mb-2 flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5 px-1 text-[10px] font-medium tracking-wide text-droid-text-muted">
              <ListPlus className="w-3 h-3" />
              Queued · sends after the current turn
            </div>
            {queue.map((p, i) => (
              <div
                key={p.id}
                draggable
                onDragStart={() => setDragIndex(i)}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOverIndex(i);
                }}
                onDrop={() => handleQueueDrop(i)}
                onDragEnd={() => {
                  setDragIndex(null);
                  setDragOverIndex(null);
                }}
                className={`group flex items-start gap-2 rounded-xl border bg-droid-elevated px-2 py-1.5 transition-colors ${
                  dragOverIndex === i && dragIndex !== null && dragIndex !== i
                    ? 'border-droid-orange'
                    : 'border-droid-border'
                }`}
              >
                <span
                  className="mt-0.5 cursor-grab text-droid-text-muted/60 active:cursor-grabbing"
                  title="Drag to reorder"
                >
                  <GripVertical className="w-3.5 h-3.5" />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block whitespace-pre-wrap break-words text-[12px] text-droid-text-secondary">
                    {p.text || '(empty)'}
                  </span>
                  {p.design && p.design.references.length > 0 && (
                    <span className="mt-1 inline-flex items-center gap-1 rounded-md bg-black/20 px-1.5 py-0.5 text-[10px] text-droid-text-muted">
                      <MousePointerSquareDashed className="w-3 h-3" />
                      {p.design.references.length} reference
                      {p.design.references.length === 1 ? '' : 's'}
                    </span>
                  )}
                  {p.studio && (p.studio.browserRefs?.length ?? 0) > 0 && (
                    <span className="mt-1 inline-flex items-center gap-1 rounded-md bg-black/20 px-1.5 py-0.5 text-[10px] text-droid-text-muted">
                      <MousePointerSquareDashed className="w-3 h-3" />
                      {p.studio.browserRefs?.length} reference
                      {p.studio.browserRefs?.length === 1 ? '' : 's'}
                    </span>
                  )}
                </span>
                <div className="flex shrink-0 items-center gap-0.5">
                  {!p.design && !p.studio && (
                    <button
                      onClick={() => editQueuedInComposer(p)}
                      className="rounded p-1 text-droid-text-muted hover:text-droid-text hover:bg-black/20"
                      title="Edit in composer"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    onClick={() =>
                      activeSession &&
                      dispatch({
                        type: 'REMOVE_QUEUED_PROMPT',
                        appSessionId: activeSession.appSessionId,
                        id: p.id,
                      })
                    }
                    className="rounded p-1 text-droid-text-muted hover:text-droid-orange hover:bg-black/20"
                    title="Delete"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {showStartIn && (
          <div className="relative z-0 mx-[6%] -mb-3 min-w-0 rounded-t-2xl border border-droid-border bg-droid-surface px-4 pb-4 pt-1.5">
            <StartInBar />
          </div>
        )}

        <PlanSteps />

        <SessionComposer
          ref={textareaRef}
          value={input}
          onValueChange={(value, textarea) => {
            setInput(value);
            syncCaret(textarea);
            setHistoryIndex(null);
          }}
          onSelectionChange={syncCaret}
          onPaste={(event) => {
            const items = Array.from(event.clipboardData.items).filter(
              (item) => item.kind === 'file' && item.type.startsWith('image/'),
            );
            if (items.length === 0) return;
            event.preventDefault();
            for (const item of items) {
              const blob = item.getAsFile();
              if (blob) imageAttachments.addBlob(blob);
            }
          }}
          onBeforeKeyDown={handleComposerKeyDown}
          onSubmit={handleSubmit}
          isLive={isLive}
          hasContent={hasContent}
          canSubmit={hasContent && childActionsEnabled}
          liveEnterBehavior={state.liveEnterBehavior}
          placeholder={
            missionPreview
              ? activeSession
                ? targetChildSessionId
                  ? 'Steer the selected child session…'
                  : 'Direct the orchestrator…'
                : 'Describe the mission objective…'
              : isSpecMode
                ? 'Describe what to build in spec mode...'
                : 'What would you like to work on?  (/ for skills, @ for files)'
          }
          onStop={() => {
            if (activeSession)
              interruptVisibleSession(activeSession.appSessionId, targetChildSessionId);
          }}
          onActionOverlayChange={setActionOverlayOpen}
          idleSendTitle={idleSendTooltip}
          cardClassName={missionPreview ? '' : boxBorder}
          cardStyle={
            missionPreview
              ? {
                  borderColor: accentMix(40),
                  boxShadow: `0 0 0 1px ${accentMix(13)}, 0 10px 30px -12px ${accentMix(33)}`,
                }
              : undefined
          }
          context={
            hasChips ? (
              <div className="flex flex-wrap gap-1.5 px-3 pt-3">
                {imageAttachments.images.map((image) => (
                  <ImageChip
                    key={image.id}
                    image={image}
                    onOpen={() => {
                      setViewerImageId(image.id);
                    }}
                    onRemove={() => {
                      imageAttachments.remove(image.id);
                    }}
                  />
                ))}
                {activeSkills.map((skill) => (
                  <span
                    key={skill.filePath}
                    className="group flex items-center gap-1.5 rounded-lg py-1 pl-2 pr-1 text-[11px] font-medium"
                    style={{
                      background: accentMix(14),
                      color: ACCENT,
                      boxShadow: `inset 0 0 0 1px ${accentMix(35)}`,
                    }}
                    title={skill.description ?? skill.filePath}
                  >
                    {skill.name}
                    <button
                      onClick={() => {
                        setActiveSkills((prev) =>
                          prev.filter((s) => s.filePath !== skill.filePath),
                        );
                      }}
                      className="rounded p-0.5 transition-colors hover:bg-black/20"
                      title="Remove skill"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </span>
                ))}
                {attachedFiles.map((file) => (
                  <span
                    key={file}
                    className="group flex items-center gap-1.5 rounded-lg border border-droid-border bg-droid-bg/60 py-1 pl-2 pr-1 text-[11px] text-droid-text-secondary"
                    title={file}
                  >
                    <FileText className="h-3 w-3 text-droid-text-muted" />
                    {basename(file)}
                    <button
                      onClick={() => {
                        setAttachedFiles((prev) => prev.filter((candidate) => candidate !== file));
                      }}
                      className="rounded p-0.5 transition-colors hover:bg-black/20"
                      title="Remove file"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </span>
                ))}
              </div>
            ) : undefined
          }
          toolbarLeading={
            <>
              <button
                onClick={() => void handleAttachFiles()}
                className="shrink-0 rounded-lg p-1.5 text-droid-text-muted transition-colors hover:bg-droid-bg/50 hover:text-droid-text"
                title="Add files"
                aria-label="Add files"
              >
                <Plus className="h-4 w-4" />
              </button>

              <div className="relative shrink-0">
                <button
                  onClick={() => {
                    setModelsOpen((v) => !v);
                  }}
                  className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] transition-colors max-w-[200px] ${
                    modelsOpen
                      ? 'bg-droid-bg/60 text-droid-text'
                      : 'text-droid-text-secondary hover:text-droid-text hover:bg-droid-bg/40'
                  }`}
                  title={
                    childSettingsTarget
                      ? `${childSettingsTarget.label} · ${childSettingsReadinessLabel(childSettingsTarget.readiness)}`
                      : missionPreview
                        ? 'Configure orchestrator / worker / validator models'
                        : 'Select chat model'
                  }
                >
                  {childSettingsTarget ? (
                    <>
                      <ModelIcon
                        provider={providerOf(
                          state.models.find((model) => model.id === childSettingsTarget.modelId),
                          childSettingsTarget.modelId,
                        )}
                        size={14}
                      />
                      <span className="truncate">{childSettingsTarget.label}</span>
                    </>
                  ) : missionPreview ? (
                    <>
                      <SlidersHorizontal className="w-3.5 h-3.5 shrink-0" />
                      <span>Models</span>
                    </>
                  ) : (
                    <>
                      <ModelIcon provider={providerOf(selectedModel, primaryModelId)} size={14} />
                      <span className="truncate">{selectedModelLabel}</span>
                      {showReasoningBadge && primaryReasoning && (
                        <span
                          className="shrink-0 px-1.5 py-0.5 rounded-md text-[9px] font-medium capitalize leading-none"
                          style={{
                            color: 'var(--droid-accent)',
                            backgroundColor:
                              'color-mix(in srgb, var(--droid-accent) 13%, transparent)',
                          }}
                          title={`Reasoning: ${primaryReasoning}`}
                        >
                          {primaryReasoning}
                        </span>
                      )}
                    </>
                  )}
                  <ChevronDown
                    className={`w-3 h-3 shrink-0 text-droid-text-muted/40 transition-transform ${modelsOpen ? 'rotate-180' : ''}`}
                  />
                </button>

                <AnimatePresence>
                  {modelsOpen && (
                    <ModelSelectorPopover
                      onClose={() => {
                        setModelsOpen(false);
                      }}
                      singleAgent={!missionPreview}
                      childTarget={childSettingsTarget}
                    />
                  )}
                </AnimatePresence>
              </div>

              <div className="h-4 w-px shrink-0 bg-droid-border/50" />

              <button
                onClick={toggleSpec}
                className={`flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] transition-colors ${
                  isSpecMode
                    ? 'bg-droid-accent/10 text-droid-accent hover:bg-droid-accent/15'
                    : 'text-droid-text-secondary hover:bg-droid-bg/40 hover:text-droid-text'
                }`}
              >
                <span>{isSpecMode ? 'Spec' : 'Chat'}</span>
              </button>
            </>
          }
          toolbarTrailing={<ContextStatusCluster />}
        />

        {viewerImage && (
          <ImageViewerModal
            image={viewerImage}
            onClose={() => {
              setViewerImageId(null);
            }}
            onCrop={imageAttachments.applyCrop}
          />
        )}
      </div>
    </div>
  );
}
