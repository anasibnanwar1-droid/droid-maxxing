import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  type Dispatch,
  type ReactNode,
} from 'react';
import { bridge } from '../lib/bridge';
import type {
  CanvasFrameSource,
  ComponentRegistryEntry,
  DesignLibraryItem,
  DesignTokens,
  DnaDraft,
  DnaLibrarySummary,
  DnaState,
  PrototypeInfo,
  SavedDnaEntry,
  ServerEvent,
  ValidatorConfig,
  ValidatorReport,
} from '../types/bridge';

export interface ValidatorRunStatus {
  status: 'running' | 'done' | 'failed';
  appSessionId?: string;
  pageId?: string;
  viewport?: string;
  completed?: number;
  total?: number;
  error?: string;
}

export interface ExtractedLibraryTokens {
  id: string;
  tokens: Partial<DesignTokens>;
  summary: string;
}

export interface GitCommitResult {
  ok: boolean;
  sha?: string;
  error?: string;
}

export type StudioTab = 'dna' | 'validator' | 'library' | 'prototypes' | 'components';

export interface DesignState {
  studioOpen: boolean;
  studioTab: StudioTab;
  // The project design session (explicit design purpose, never Mission Control),
  // keyed by cwd; `expected` correlates our createSession clientRef to a cwd.
  sessions: Record<string, string>;
  expected: Record<string, string>;
  // Latest brand-book / design preview per cwd (served by the preview harness).
  previews: Record<
    string,
    {
      id: string;
      name: string;
      url: string;
      kind?: 'page' | 'component';
      source: CanvasFrameSource;
    }
  >;
  // All design data is project-scoped, keyed by the session cwd.
  dna: Record<string, DnaState>;
  drafts: Record<string, DnaDraft>;
  libraries: DnaLibrarySummary[];
  // User-finalized DNA directions (Libraries tab), keyed by cwd.
  savedDna: Record<string, SavedDnaEntry[]>;
  activeDnaId: Record<string, string | null>;
  // Isolated design workspace (worktree path) keyed by the live project cwd.
  workspaces: Record<
    string,
    {
      liveCwd: string;
      path: string;
      isWorktree: boolean;
      branch?: string;
      note?: string;
    }
  >;
  validatorConfigs: Record<string, ValidatorConfig>;
  validatorRuns: Record<string, ValidatorRunStatus>;
  reports: Record<string, ValidatorReport>;
  libraryItems: Record<string, DesignLibraryItem[]>;
  extracted: Record<string, ExtractedLibraryTokens>;
  prototypes: Record<string, PrototypeInfo[]>;
  registry: Record<string, ComponentRegistryEntry[]>;
  gitResults: Record<string, GitCommitResult>;
  lastError: { cwd?: string; message: string } | null;
}

export type DesignAction =
  | { type: 'OPEN_STUDIO'; tab?: StudioTab }
  | { type: 'CLOSE_STUDIO' }
  | { type: 'SET_TAB'; tab: StudioTab }
  | { type: 'CLEAR_ERROR' }
  | { type: 'CLEAR_GIT_RESULT'; cwd: string }
  | { type: 'EXPECT_SESSION'; clientRef: string; cwd: string }
  // Adopt an existing normal chat as the design session for this cwd (e.g. when
  // the user opens the studio with a chat already selected).
  | { type: 'ADOPT_SESSION'; cwd: string; appSessionId: string }
  // Switch the active design thread for a cwd (or clear it to start a new one).
  | { type: 'SET_SESSION'; cwd: string; appSessionId: string | null }
  | { type: 'BRIDGE_EVENT'; event: ServerEvent };

const initialState: DesignState = {
  studioOpen: false,
  studioTab: 'dna',
  sessions: {},
  expected: {},
  previews: {},
  dna: {},
  drafts: {},
  libraries: [],
  savedDna: {},
  activeDnaId: {},
  workspaces: {},
  validatorConfigs: {},
  validatorRuns: {},
  reports: {},
  libraryItems: {},
  extracted: {},
  prototypes: {},
  registry: {},
  gitResults: {},
  lastError: null,
};

function applyEvent(state: DesignState, ev: ServerEvent): DesignState {
  switch (ev.type) {
    case 'design.dna.state':
      return { ...state, dna: { ...state.dna, [ev.state.cwd]: ev.state } };
    case 'design.dna.draft':
      return { ...state, drafts: { ...state.drafts, [ev.draft.cwd]: ev.draft } };
    case 'design.dna.libraries':
      return { ...state, libraries: ev.libraries };
    case 'design.dna.saved':
      return {
        ...state,
        savedDna: { ...state.savedDna, [ev.cwd]: ev.items },
        activeDnaId: { ...state.activeDnaId, [ev.cwd]: ev.activeId },
      };
    case 'design.workspace.ready':
      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [ev.liveCwd]: {
            liveCwd: ev.liveCwd,
            path: ev.path,
            isWorktree: ev.isWorktree,
            branch: ev.branch,
            note: ev.note,
          },
        },
      };
    case 'design.validator.config':
      return {
        ...state,
        validatorConfigs: { ...state.validatorConfigs, [ev.cwd]: ev.config },
      };
    case 'design.validator.status':
      return {
        ...state,
        validatorRuns: {
          ...state.validatorRuns,
          [ev.cwd]: {
            status: ev.status,
            appSessionId: ev.appSessionId,
            pageId: ev.pageId,
            viewport: ev.viewport,
            completed: ev.completed,
            total: ev.total,
            error: ev.error,
          },
        },
      };
    case 'design.validator.report':
      return { ...state, reports: { ...state.reports, [ev.report.cwd]: ev.report } };
    case 'design.library.state':
      return { ...state, libraryItems: { ...state.libraryItems, [ev.cwd]: ev.items } };
    case 'design.library.extracted':
      return {
        ...state,
        extracted: {
          ...state.extracted,
          [ev.cwd]: { id: ev.id, tokens: ev.tokens, summary: ev.summary },
        },
      };
    case 'design.prototypes.state':
      return { ...state, prototypes: { ...state.prototypes, [ev.cwd]: ev.prototypes } };
    case 'design.registry.state':
      return { ...state, registry: { ...state.registry, [ev.cwd]: ev.components } };
    case 'design.git.committed':
      return {
        ...state,
        gitResults: {
          ...state.gitResults,
          [ev.cwd]: { ok: ev.ok, sha: ev.sha, error: ev.error },
        },
      };
    case 'design.preview':
      return {
        ...state,
        previews: {
          ...state.previews,
          [ev.cwd]: {
            id: ev.id,
            name: ev.name,
            url: ev.url,
            ...(ev.kind === undefined ? {} : { kind: ev.kind }),
            source: ev.source,
          },
        },
      };
    case 'design.error':
      return { ...state, lastError: { cwd: ev.cwd, message: ev.message } };
    case 'session.created': {
      // A design session we started (correlated by clientRef) has an id now.
      const cwd = state.expected[ev.clientRef];
      if (!cwd) return state;
      const expected = Object.fromEntries(
        Object.entries(state.expected).filter(([clientRef]) => clientRef !== ev.clientRef),
      );
      return {
        ...state,
        sessions: { ...state.sessions, [cwd]: ev.session.appSessionId },
        expected,
      };
    }
    default:
      return state;
  }
}

function reducer(state: DesignState, action: DesignAction): DesignState {
  switch (action.type) {
    case 'OPEN_STUDIO':
      return { ...state, studioOpen: true, studioTab: action.tab ?? state.studioTab };
    case 'CLOSE_STUDIO':
      return { ...state, studioOpen: false };
    case 'SET_TAB':
      return { ...state, studioTab: action.tab };
    case 'CLEAR_ERROR':
      return { ...state, lastError: null };
    case 'CLEAR_GIT_RESULT': {
      if (!(action.cwd in state.gitResults)) return state;
      const gitResults = Object.fromEntries(
        Object.entries(state.gitResults).filter(([key]) => key !== action.cwd),
      );
      return { ...state, gitResults };
    }
    case 'EXPECT_SESSION':
      return {
        ...state,
        expected: { ...state.expected, [action.clientRef]: action.cwd },
      };
    case 'ADOPT_SESSION':
      return {
        ...state,
        sessions: { ...state.sessions, [action.cwd]: action.appSessionId },
      };
    case 'SET_SESSION': {
      // null → empty string marks an intentional "new thread" so auto-adopt
      // does not immediately reattach the main-window active chat.
      const nextId = action.appSessionId ?? '';
      if (state.sessions[action.cwd] === nextId) return state;
      return {
        ...state,
        sessions: { ...state.sessions, [action.cwd]: nextId },
      };
    }
    case 'BRIDGE_EVENT':
      return applyEvent(state, action.event);
  }
}

const DesignStoreContext = createContext<{
  design: DesignState;
  designDispatch: Dispatch<DesignAction>;
} | null>(null);

export function DesignStoreProvider({ children }: { children: ReactNode }) {
  const [design, designDispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    const unsub = bridge.subscribe((ev) => {
      if (ev.type.startsWith('design.') || ev.type === 'session.created')
        designDispatch({ type: 'BRIDGE_EVENT', event: ev });
    });
    return () => {
      unsub();
    };
  }, []);

  return (
    <DesignStoreContext.Provider value={{ design, designDispatch }}>
      {children}
    </DesignStoreContext.Provider>
  );
}

export function useDesignStore() {
  const context = useContext(DesignStoreContext);
  if (!context) throw new Error('useDesignStore must be used within DesignStoreProvider');
  return context;
}
