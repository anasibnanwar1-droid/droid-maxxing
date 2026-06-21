import { useState, useRef, useEffect, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useStore } from '../hooks/useStore';
import type { QueuedPrompt } from '../hooks/useStore';
import { useMissionLive } from '../hooks/useMissionLive';
import {
  sendToMission,
  sendToMissionNow,
  sendToAgent,
  sendToAgentNow,
  sendDesignPrompt,
  createMission,
  interruptMission,
  interruptAgent,
  compactSession,
  setInteractionMode,
  newClientRef,
  listSkills,
} from '../lib/commands';
import { browserTranscriptReferencesFromDesignReferences } from './browser/browserTranscriptReferences';
import { pickDirectory, listFiles } from '../lib/desktop';
import { markGitTurnStart } from '../lib/git';
import { createLocalDesignTranscriptEvent, newQueueId } from '../lib/promptQueue';
import { composePrompt } from '../lib/composePrompt';
import {
  ArrowUp,
  ChevronDown,
  SlidersHorizontal,
  Square,
  FileText,
  X,
  Folder,
  User,
  Box,
  ListPlus,
  GripVertical,
  Pencil,
  MousePointerSquareDashed,
} from 'lucide-react';
import ModelSelectorPopover from './ModelSelectorPopover';
import PermissionInline from './PermissionInline';
import PlanApprovalInline from './PlanApprovalInline';
import { ModelIcon, providerOf } from './ModelIcon';
import { StartInBar } from './environment/StartInBar';
import type { SkillInfo, SkillLocation } from '../types/bridge';

const ACCENT = 'var(--droid-accent)';
const accentMix = (pct: number) => `color-mix(in srgb, var(--droid-accent) ${pct}%, transparent)`;
type SubmitMode = 'queue' | 'now';
const oppositeSubmitMode = (mode: SubmitMode): SubmitMode => (mode === 'queue' ? 'now' : 'queue');

type SlashCommand = { cmd: string; desc: string; run: () => void };

type Trigger = { kind: 'slash' | 'file'; query: string; start: number; end: number };

type MenuItem =
  | { type: 'command'; command: SlashCommand }
  | { type: 'skill'; skill: SkillInfo }
  | { type: 'file'; path: string };

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

const LOCATION_ICON: Record<SkillLocation, typeof User> = {
  project: Folder,
  personal: User,
  builtin: Box,
};

const COMPACT_COMMANDS = new Set(['/compact', '/compaction', '/compression']);

export default function PromptInput({ rightInset = false }: { rightInset?: boolean }) {
  const { state, dispatch } = useStore();
  const [input, setInput] = useState('');
  const [caret, setCaret] = useState(0);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  const [filesCwd, setFilesCwd] = useState<string | null>(null);
  const [attachedFiles, setAttachedFiles] = useState<string[]>([]);
  const [activeSkills, setActiveSkills] = useState<SkillInfo[]>([]);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [sendHover, setSendHover] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const submittingRef = useRef(false);
  const pendingCaret = useRef<number | null>(null);
  const prevLive = useRef<{ missionId: string | null; live: boolean }>({
    missionId: null,
    live: false,
  });

  const activeMission = state.activeMissionId ? state.missions[state.activeMissionId] : null;
  const isLive = useMissionLive(state.activeMissionId);
  // For an existing chat session the mode is whatever the session actually is
  // (so a chat reopened in spec mode shows Spec); only fall back to the global
  // compose flag while drafting a brand-new chat.
  const isSpecMode =
    activeMission && (activeMission.kind === 'chat' || activeMission.kind === 'spec')
      ? activeMission.kind === 'spec'
      : state.specMode;
  const targetAgentSessionId =
    activeMission?.kind !== 'mission_orchestrator' &&
    state.selectedAgentSessionId &&
    state.selectedAgentSessionId !== 'orchestrator'
      ? state.selectedAgentSessionId
      : null;

  const cwd = activeMission?.cwd ?? state.draftChat?.cwd ?? null;
  const skillsSessionId = activeMission?.id ?? null;
  const pendingSkillsRequest = useRef<{ sessionId: string | null; requestedAt: number } | null>(
    null,
  );

  // Toggle spec mode. When a live chat session exists, switch its interaction
  // mode for real (not just the compose flag used for brand-new chats).
  const toggleSpec = () => {
    if (activeMission && (activeMission.kind === 'chat' || activeMission.kind === 'spec')) {
      // Existing live chat: flip the session's real interaction mode and
      // optimistically update its kind so the toggle reflects immediately.
      const turningOn = !isSpecMode;
      dispatch({
        type: 'MISSION_SET_KIND',
        missionId: activeMission.id,
        kind: turningOn ? 'spec' : 'chat',
      });
      setInteractionMode(activeMission.id, turningOn ? 'spec' : 'auto');
    } else {
      // Brand-new draft chat with no session yet: just flip the compose flag.
      dispatch({ type: 'TOGGLE_SPEC_MODE' });
    }
  };

  const slashCommands: SlashCommand[] = [
    {
      cmd: '/mission',
      desc: 'Enter Mission Control',
      run: () => dispatch({ type: 'TOGGLE_MISSION_MODE' }),
    },
    { cmd: '/model', desc: 'Open model selector', run: () => setModelsOpen(true) },
    {
      cmd: '/compact',
      desc: 'Compact current session',
      run: () => activeMission && compactSession(activeMission.id),
    },
    {
      cmd: '/compaction',
      desc: 'Compact current session',
      run: () => activeMission && compactSession(activeMission.id),
    },
    {
      cmd: '/compression',
      desc: 'Compact current session',
      run: () => activeMission && compactSession(activeMission.id),
    },
    { cmd: '/spec', desc: 'Toggle spec mode', run: () => toggleSpec() },
    { cmd: '/settings', desc: 'Open settings', run: () => dispatch({ type: 'TOGGLE_SETTINGS' }) },
  ];

  const trigger = useMemo(() => getTrigger(input, caret), [input, caret]);

  const invocableSkills = useMemo(
    () =>
      state.skillsSessionId === skillsSessionId
        ? state.skills.filter((s) => s.userInvocable !== false && s.enabled !== false)
        : [],
    [skillsSessionId, state.skills, state.skillsSessionId],
  );

  useEffect(() => {
    if (trigger?.kind !== 'slash') {
      pendingSkillsRequest.current = null;
      return;
    }
    if (state.skillsSessionId === skillsSessionId) {
      pendingSkillsRequest.current = null;
      return;
    }
    const pending = pendingSkillsRequest.current;
    const now = Date.now();
    if (pending?.sessionId === skillsSessionId && now - pending.requestedAt < 2_000) return;
    pendingSkillsRequest.current = { sessionId: skillsSessionId, requestedAt: now };
    listSkills(activeMission?.id);
  }, [
    activeMission?.id,
    skillsSessionId,
    state.skillsSessionId,
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

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [input]);

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

  const missionPreview = activeMission
    ? activeMission.kind === 'mission_orchestrator'
    : state.missionMode;

  // A single chat carries its own model/reasoning; only fall back to the global
  // default while composing a brand-new chat that has no session yet.
  const chatScoped = !missionPreview && !!activeMission;
  const orchestratorModelId = chatScoped
    ? activeMission!.modelId
    : state.agentConfig.orchestrator.modelId;
  const orchestratorReasoning = chatScoped
    ? (activeMission!.reasoningEffort ?? state.agentConfig.orchestrator.reasoning)
    : state.agentConfig.orchestrator.reasoning;
  const selectedModel = orchestratorModelId
    ? state.models.find((m) => m.id === orchestratorModelId)
    : undefined;
  const selectedModelLabel = orchestratorModelId
    ? (selectedModel?.displayName ?? orchestratorModelId)
    : 'Default model';
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

  const composeText = (text: string): string =>
    composeFrom(
      text,
      activeSkills.map((s) => s.name),
      attachedFiles,
    );

  const resetAttachments = () => {
    setActiveSkills([]);
    setAttachedFiles([]);
  };

  // Re-entry guard: a send awaits markGitTurnStart before the input is cleared,
  // so without this a second Enter/click during that window would resend the
  // same payload (and create a duplicate mission/turn).
  const handleSubmit = async (mode: SubmitMode = 'queue') => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    try {
      await runSubmit(mode);
    } finally {
      submittingRef.current = false;
    }
  };

  const runSubmit = async (mode: SubmitMode = 'queue') => {
    const text = input.trim();
    const hasPayload = text || activeSkills.length > 0 || attachedFiles.length > 0;
    if (!hasPayload) return;

    if (text === '/mission' && activeSkills.length === 0 && attachedFiles.length === 0) {
      dispatch({ type: 'TOGGLE_MISSION_MODE' });
      setInput('');
      return;
    }

    if (COMPACT_COMMANDS.has(text) && activeSkills.length === 0 && attachedFiles.length === 0) {
      if (activeMission) compactSession(activeMission.id);
      setInput('');
      return;
    }

    const composed = composeText(text);

    const skillNames = activeSkills.map((s) => s.name);
    const registerPending = (ref: string) =>
      dispatch({
        type: 'SET_PENDING_COMPOSE',
        clientRef: ref,
        text,
        skills: skillNames,
        files: [...attachedFiles],
      });

    // Mission preview with no active mission: prompt is the objective.
    if (missionPreview && !activeMission) {
      const dir = state.draftChat?.cwd ?? (await pickDirectory());
      if (!dir) return;
      // Snapshot the tree before the agent's first turn so the Review "Last
      // turn" scope only attributes changes this session actually makes.
      await markGitTurnStart(dir);
      const { orchestrator, worker, validator } = state.agentConfig;
      const clientRef = newClientRef();
      registerPending(clientRef);
      createMission({
        clientRef,
        cwd: dir,
        title: (text || activeSkills[0]?.name || 'Mission').slice(0, 48),
        goal: composed,
        interactionMode: 'agi',
        autonomy: 'medium',
        modelId: orchestrator.modelId,
        reasoningEffort: orchestrator.reasoning,
        compactionModel:
          state.compactionModel === 'current-model' ? undefined : state.compactionModel,
        compactionTokenLimit: state.compactionTokenLimit,
        compactionTokenLimitPerModel: state.compactionTokenLimitPerModel,
        workerModel: worker.modelId,
        workerReasoning: worker.reasoning,
        validatorModel: validator.modelId,
        validatorReasoning: validator.reasoning,
      });
      setInput('');
      resetAttachments();
      return;
    }

    // Draft/default chat: first message creates the session. No workspace is required.
    if (!activeMission) {
      const dir = state.draftChat?.cwd ?? '';
      if (dir) await markGitTurnStart(dir);
      const { orchestrator } = state.agentConfig;
      const clientRef = newClientRef();
      registerPending(clientRef);
      createMission({
        clientRef,
        cwd: dir,
        title: (text || activeSkills[0]?.name || 'Chat').slice(0, 48),
        goal: composed,
        interactionMode: isSpecMode ? 'spec' : 'auto',
        autonomy: 'medium',
        modelId: orchestrator.modelId,
        reasoningEffort: orchestrator.reasoning,
        compactionModel:
          state.compactionModel === 'current-model' ? undefined : state.compactionModel,
        compactionTokenLimit: state.compactionTokenLimit,
        compactionTokenLimitPerModel: state.compactionTokenLimitPerModel,
      });
      setInput('');
      resetAttachments();
      return;
    }

    if (!activeMission) return;

    // Model is working and the user chose to queue: stage the prompt locally.
    // It is held client-side and delivered automatically when the turn finishes.
    if (isLive && mode === 'queue' && !targetAgentSessionId) {
      dispatch({
        type: 'QUEUE_PROMPT',
        missionId: activeMission.id,
        prompt: { id: newQueueId(), text, skills: skillNames, files: [...attachedFiles] },
      });
      setInput('');
      resetAttachments();
      return;
    }

    dispatch({
      type: 'MISSION_TRANSCRIPT',
      event: {
        id: `local-${Date.now()}`,
        missionId: activeMission.id,
        agentSessionId: targetAgentSessionId ?? 'user',
        role: targetAgentSessionId ? 'worker' : 'orchestrator',
        ts: Date.now(),
        kind: 'text',
        text,
        author: 'user',
        skills: activeSkills.map((s) => s.name),
        files: [...attachedFiles],
        steered: isLive && mode === 'now',
      },
    });

    // Clear the composer now (before any await) so a prompt the user starts
    // typing during the git-baseline delay below is never wiped out.
    setInput('');
    resetAttachments();

    // Capture the last-turn baseline before the agent can touch the tree;
    // a fire-and-forget call here races the first edit and corrupts the diff.
    if (activeMission.cwd) await markGitTurnStart(activeMission.cwd);

    try {
      if (targetAgentSessionId) {
        if (mode === 'now') sendToAgentNow(activeMission.id, targetAgentSessionId, composed);
        else sendToAgent(activeMission.id, targetAgentSessionId, composed);
      } else if (mode === 'now') sendToMissionNow(activeMission.id, composed);
      else sendToMission(activeMission.id, composed);
    } catch (err) {
      console.error('[PromptInput] sendToMission failed:', err);
    }
  };

  const queue: QueuedPrompt[] = activeMission ? (state.promptQueue[activeMission.id] ?? []) : [];

  const deliverPrompt = async (p: QueuedPrompt) => {
    if (!activeMission) return;
    if (p.design) {
      try {
        sendDesignPrompt(p.design.browserKey, p.text, p.design.referenceIds);
      } catch (err) {
        console.error('[PromptInput] queued design send failed:', err);
        return;
      }
      const browserRefs = browserTranscriptReferencesFromDesignReferences(p.design.references);
      dispatch({
        type: 'MISSION_TRANSCRIPT',
        event: createLocalDesignTranscriptEvent(activeMission.id, p.text, browserRefs),
      });
      dispatch({ type: 'REMOVE_QUEUED_PROMPT', missionId: activeMission.id, id: p.id });
      return;
    }
    const composed = composeFrom(p.text, p.skills, p.files);
    if (activeMission.cwd) await markGitTurnStart(activeMission.cwd);
    try {
      sendToMission(activeMission.id, composed);
    } catch (err) {
      // Keep the prompt staged and skip the transcript echo so a send failure
      // neither loses queued input nor leaves a duplicate user message behind.
      console.error('[PromptInput] queued send failed:', err);
      return;
    }
    dispatch({
      type: 'MISSION_TRANSCRIPT',
      event: {
        id: `local-${Date.now()}`,
        missionId: activeMission.id,
        agentSessionId: 'user',
        role: 'orchestrator',
        ts: Date.now(),
        kind: 'text',
        text: p.text,
        author: 'user',
        skills: p.skills,
        files: p.files,
      },
    });
    dispatch({ type: 'REMOVE_QUEUED_PROMPT', missionId: activeMission.id, id: p.id });
  };

  // When the current turn finishes, deliver the next staged prompt. Delivering
  // it restarts the turn, so the effect drains the queue one prompt at a time.
  useEffect(() => {
    const prev = prevLive.current;
    // Only deliver when the *same* mission transitioned live -> idle. Switching
    // missions mid-turn must not drain a different mission's queue.
    if (prev.live && !isLive && activeMission && prev.missionId === activeMission.id) {
      const next = (state.promptQueue[activeMission.id] ?? [])[0];
      if (next) void deliverPrompt(next);
    }
    prevLive.current = { missionId: activeMission?.id ?? null, live: isLive };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLive, activeMission?.id]);

  const editQueuedInComposer = (p: QueuedPrompt) => {
    if (!activeMission) return;
    setInput(p.text);
    setAttachedFiles(p.files);
    setActiveSkills(invocableSkills.filter((s) => p.skills.includes(s.name)));
    dispatch({ type: 'REMOVE_QUEUED_PROMPT', missionId: activeMission.id, id: p.id });
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const handleQueueDrop = (to: number) => {
    if (activeMission && dragIndex !== null && dragIndex !== to) {
      dispatch({ type: 'REORDER_QUEUE', missionId: activeMission.id, from: dragIndex, to });
    }
    setDragIndex(null);
    setDragOverIndex(null);
  };

  const syncCaret = (el: HTMLTextAreaElement) => setCaret(el.selectionStart ?? 0);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMenuIndex((i) => (i + 1) % menuItems.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMenuIndex((i) => (i - 1 + menuItems.length) % menuItems.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        runMenuItem(menuItems[Math.min(menuIndex, menuItems.length - 1)]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        replaceTrigger('');
        return;
      }
    }
    if (e.key === 'Backspace' && input === '' && attachedFiles.length > 0) {
      e.preventDefault();
      setAttachedFiles((prev) => prev.slice(0, -1));
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const enterMode: SubmitMode =
        isLive && state.liveEnterBehavior === 'interrupt' ? 'now' : 'queue';
      void handleSubmit(
        isLive && (e.metaKey || e.ctrlKey) ? oppositeSubmitMode(enterMode) : enterMode,
      );
    }
  };

  const boxBorder = isSpecMode
    ? 'border-droid-orange/40 focus-within:border-droid-orange/60'
    : 'border-droid-border focus-within:border-droid-border-hover';

  const hasChips = activeSkills.length > 0 || attachedFiles.length > 0;
  const enterSteers = state.liveEnterBehavior === 'interrupt';
  const idleSendTooltip = 'Enter: send\nShift+Enter: newline';
  const hasContent = input.trim().length > 0 || activeSkills.length > 0 || attachedFiles.length > 0;

  return (
    <div
      className="shrink-0 w-full min-w-0 px-6 pb-5 pt-2"
      style={{ paddingRight: rightInset ? 312 : undefined, transition: 'padding-right 0.2s ease' }}
    >
      <div className="max-w-3xl min-w-0 mx-auto relative">
        <AnimatePresence>
          {menuOpen && (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
              className="absolute bottom-full left-0 right-0 mb-2 z-50 rounded-xl border border-droid-border bg-droid-elevated shadow-2xl shadow-black/40 overflow-hidden py-1 max-h-72 overflow-y-auto"
            >
              {trigger?.kind === 'file' && (
                <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-droid-text-muted/60 flex items-center gap-1.5">
                  <FileText className="w-3 h-3" /> Files{filesCwd ? '' : ' — loading…'}
                </div>
              )}
              {menuItems.map((item, i) => {
                const on = i === Math.min(menuIndex, menuItems.length - 1);
                const base = `w-full flex items-center gap-3 px-3 py-2 text-left transition-colors ${on ? 'bg-droid-surface' : 'hover:bg-droid-surface/60'}`;
                if (item.type === 'command') {
                  return (
                    <button
                      key={`cmd-${item.command.cmd}`}
                      onMouseEnter={() => setMenuIndex(i)}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        runMenuItem(item);
                      }}
                      className={base}
                    >
                      <span className="font-mono text-[12px] text-droid-text">
                        {item.command.cmd}
                      </span>
                      <span className="text-[11px] text-droid-text-muted truncate">
                        {item.command.desc}
                      </span>
                    </button>
                  );
                }
                if (item.type === 'skill') {
                  const LocIcon = LOCATION_ICON[item.skill.location] ?? Box;
                  const added = activeSkills.some((s) => s.filePath === item.skill.filePath);
                  return (
                    <button
                      key={`skill-${item.skill.filePath}`}
                      onMouseEnter={() => setMenuIndex(i)}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        runMenuItem(item);
                      }}
                      className={base}
                    >
                      <span className="text-[12px] shrink-0" style={{ color: ACCENT }}>
                        {item.skill.name}
                      </span>
                      <span className="text-[11px] text-droid-text-muted truncate flex-1">
                        {item.skill.description}
                      </span>
                      {added && (
                        <span className="text-[10px] shrink-0" style={{ color: ACCENT }}>
                          added
                        </span>
                      )}
                      <span className="flex items-center gap-1 text-[10px] text-droid-text-muted/60 shrink-0">
                        <LocIcon className="w-3 h-3" />
                        {item.skill.location}
                      </span>
                    </button>
                  );
                }
                return (
                  <button
                    key={`file-${item.path}`}
                    onMouseEnter={() => setMenuIndex(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      runMenuItem(item);
                    }}
                    className={base}
                  >
                    <FileText className="w-3.5 h-3.5 shrink-0 text-droid-text-muted" />
                    <span className="text-[12px] text-droid-text shrink-0">
                      {basename(item.path)}
                    </span>
                    <span className="text-[11px] text-droid-text-muted/70 truncate flex-1">
                      {item.path}
                    </span>
                    {attachedFiles.includes(item.path) && (
                      <span className="text-[10px] shrink-0" style={{ color: ACCENT }}>
                        added
                      </span>
                    )}
                  </button>
                );
              })}
            </motion.div>
          )}
        </AnimatePresence>

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
                </span>
                <div className="flex shrink-0 items-center gap-0.5">
                  {!p.design && (
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
                      activeMission &&
                      dispatch({
                        type: 'REMOVE_QUEUED_PROMPT',
                        missionId: activeMission.id,
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

        <div
          className={`relative bg-droid-elevated border rounded-2xl transition-colors ${missionPreview ? '' : boxBorder}`}
          style={
            missionPreview
              ? {
                  borderColor: accentMix(40),
                  boxShadow: `0 0 0 1px ${accentMix(13)}, 0 10px 30px -12px ${accentMix(33)}`,
                }
              : undefined
          }
        >
          {hasChips && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-3">
              {activeSkills.map((skill) => (
                <span
                  key={skill.filePath}
                  className="group flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-lg text-[11px] font-medium"
                  style={{
                    background: accentMix(14),
                    color: ACCENT,
                    boxShadow: `inset 0 0 0 1px ${accentMix(35)}`,
                  }}
                  title={skill.description ?? skill.filePath}
                >
                  {skill.name}
                  <button
                    onClick={() =>
                      setActiveSkills((prev) => prev.filter((s) => s.filePath !== skill.filePath))
                    }
                    className="p-0.5 rounded hover:bg-black/20 transition-colors"
                    title="Remove skill"
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                </span>
              ))}
              {attachedFiles.map((f) => (
                <span
                  key={f}
                  className="group flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-lg text-[11px] bg-droid-bg/60 text-droid-text-secondary border border-droid-border"
                  title={f}
                >
                  <FileText className="w-3 h-3 text-droid-text-muted" />
                  {basename(f)}
                  <button
                    onClick={() => setAttachedFiles((prev) => prev.filter((x) => x !== f))}
                    className="p-0.5 rounded hover:bg-black/20 transition-colors"
                    title="Remove file"
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                </span>
              ))}
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              syncCaret(e.target);
            }}
            onKeyUp={(e) => syncCaret(e.currentTarget)}
            onClick={(e) => syncCaret(e.currentTarget)}
            onSelect={(e) => syncCaret(e.currentTarget)}
            onKeyDown={handleKeyDown}
            placeholder={
              missionPreview
                ? activeMission
                  ? targetAgentSessionId
                    ? 'Steer the selected subagent…'
                    : 'Direct the orchestrator…'
                  : 'Describe the mission objective…'
                : isSpecMode
                  ? 'Describe what to build in spec mode...'
                  : 'What would you like to work on?  (/ for skills, @ for files)'
            }
            rows={1}
            className="w-full bg-transparent px-4 pt-3 pb-2 text-sm text-droid-text placeholder-droid-text-muted/50 resize-none focus:outline-none min-h-[44px] max-h-[200px]"
          />

          {/* Toolbar */}
          <div className="flex items-center gap-2 px-3 py-2.5 border-t border-droid-border">
            <div className="relative shrink-0">
              <button
                onClick={() => setModelsOpen((v) => !v)}
                className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] transition-colors max-w-[200px] ${
                  modelsOpen
                    ? 'bg-droid-bg/60 text-droid-text'
                    : 'text-droid-text-secondary hover:text-droid-text hover:bg-droid-bg/40'
                }`}
                title={
                  missionPreview
                    ? 'Configure orchestrator / worker / validator models'
                    : 'Select chat model'
                }
              >
                {missionPreview ? (
                  <>
                    <SlidersHorizontal className="w-3.5 h-3.5 shrink-0" />
                    <span>Models</span>
                  </>
                ) : (
                  <>
                    <ModelIcon
                      provider={providerOf(selectedModel, orchestratorModelId)}
                      size={14}
                    />
                    <span className="truncate">{selectedModelLabel}</span>
                    {showReasoningBadge && orchestratorReasoning && (
                      <span
                        className="shrink-0 px-1.5 py-0.5 rounded-md text-[9px] font-medium capitalize leading-none"
                        style={{
                          color: 'var(--droid-accent)',
                          backgroundColor:
                            'color-mix(in srgb, var(--droid-accent) 13%, transparent)',
                        }}
                        title={`Reasoning: ${orchestratorReasoning}`}
                      >
                        {orchestratorReasoning}
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
                    onClose={() => setModelsOpen(false)}
                    singleAgent={!missionPreview}
                  />
                )}
              </AnimatePresence>
            </div>

            <div className="h-4 w-px bg-droid-border/50 shrink-0" />

            <button
              onClick={toggleSpec}
              className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] transition-colors shrink-0 ${
                isSpecMode
                  ? 'text-droid-accent bg-droid-accent/10 hover:bg-droid-accent/15'
                  : 'text-droid-text-secondary hover:text-droid-text hover:bg-droid-bg/40'
              }`}
            >
              <span>{isSpecMode ? 'Spec' : 'Chat'}</span>
            </button>

            {!activeMission && !missionPreview && (
              <>
                <div className="h-4 w-px bg-droid-border/50 shrink-0" />
                <StartInBar />
              </>
            )}

            <div className="flex-1 min-w-0" />

            {isLive && !hasContent ? (
              <button
                onClick={() =>
                  activeMission &&
                  (targetAgentSessionId
                    ? interruptAgent(activeMission.id, targetAgentSessionId)
                    : interruptMission(activeMission.id))
                }
                title="Working — click to stop"
                className="p-2 rounded-xl text-droid-bg shrink-0 transition-colors"
                style={{ background: ACCENT }}
              >
                <Square className="w-3.5 h-3.5" fill="currentColor" strokeWidth={0} />
              </button>
            ) : isLive ? (
              <div
                className="relative shrink-0"
                onMouseEnter={() => setSendHover(true)}
                onMouseLeave={() => setSendHover(false)}
              >
                <AnimatePresence>
                  {sendHover && (
                    <motion.div
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 4 }}
                      transition={{ duration: 0.12, ease: [0.16, 1, 0.3, 1] }}
                      className="absolute bottom-full right-0 mb-2 z-50 flex flex-col gap-0.5 rounded-xl border border-droid-border bg-droid-elevated p-1.5 shadow-2xl shadow-black/40"
                    >
                      {[
                        { label: enterSteers ? 'Steer' : 'Queue', keys: ['⏎'] },
                        { label: enterSteers ? 'Queue' : 'Steer', keys: ['⌘', '⏎'] },
                      ].map((row) => (
                        <div
                          key={row.label}
                          className="flex items-center justify-between gap-3 rounded-lg px-2 py-1 text-[12px] text-droid-text"
                        >
                          <span>{row.label}</span>
                          <span className="flex items-center gap-0.5 rounded-md bg-droid-bg/70 px-1.5 py-0.5 text-[11px] text-droid-text-secondary">
                            {row.keys.map((k) => (
                              <kbd key={k} className="font-sans leading-none">
                                {k}
                              </kbd>
                            ))}
                          </span>
                        </div>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
                <button
                  onClick={() => void handleSubmit(enterSteers ? 'now' : 'queue')}
                  className="p-2 rounded-xl bg-droid-text text-droid-bg hover:bg-droid-text-secondary transition-colors"
                >
                  <ArrowUp className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <button
                onClick={() => void handleSubmit()}
                disabled={!hasContent}
                title={idleSendTooltip}
                className="p-2 rounded-xl bg-droid-text text-droid-bg disabled:opacity-20 disabled:cursor-not-allowed hover:bg-droid-text-secondary transition-colors shrink-0"
              >
                <ArrowUp className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
