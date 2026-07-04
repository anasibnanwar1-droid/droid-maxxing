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
  ComponentRegistryEntry,
  DesignLibraryItem,
  DesignTokens,
  DnaDraft,
  DnaLibrarySummary,
  DnaState,
  PrototypeInfo,
  ServerEvent,
  ValidatorConfig,
  ValidatorReport,
} from '../types/bridge';

export interface ValidatorRunStatus {
  status: 'running' | 'done' | 'failed';
  missionId?: string;
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
  // All design data is project-scoped, keyed by the mission cwd.
  dna: Record<string, DnaState>;
  drafts: Record<string, DnaDraft>;
  libraries: DnaLibrarySummary[];
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
  | { type: 'BRIDGE_EVENT'; event: ServerEvent };

const initialState: DesignState = {
  studioOpen: false,
  studioTab: 'dna',
  dna: {},
  drafts: {},
  libraries: [],
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
            missionId: ev.missionId,
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
    case 'design.error':
      return { ...state, lastError: { cwd: ev.cwd, message: ev.message } };
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
      const gitResults = { ...state.gitResults };
      delete gitResults[action.cwd];
      return { ...state, gitResults };
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
      if (ev.type.startsWith('design.')) designDispatch({ type: 'BRIDGE_EVENT', event: ev });
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
