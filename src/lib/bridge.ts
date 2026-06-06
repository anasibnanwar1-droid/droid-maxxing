import { getBridgeInfo } from './tauri';
import type { ClientCommand, ServerEvent } from '../types/bridge';

type Listener = (ev: ServerEvent) => void;

class Bridge {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private queue: ClientCommand[] = [];
  private backoff = 500;
  private url = '';
  private started = false;

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const { port, token } = await getBridgeInfo();
    this.url = `ws://127.0.0.1:${port}${token ? `?token=${token}` : ''}`;
    this.open();
  }

  private open(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 500;
      const pending = this.queue;
      this.queue = [];
      pending.forEach((c) => ws.send(JSON.stringify(c)));
    };
    ws.onmessage = (e) => {
      let ev: ServerEvent;
      try {
        ev = JSON.parse(e.data) as ServerEvent;
      } catch {
        return;
      }
      this.listeners.forEach((l) => l(ev));
    };
    ws.onclose = () => {
      this.ws = null;
      this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect(): void {
    setTimeout(() => this.open(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 5000);
  }

  send(cmd: ClientCommand): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(cmd));
    else this.queue.push(cmd);
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

export const bridge = new Bridge();

// Command helpers
let refCounter = 0;
export const newClientRef = () => `c-${Date.now().toString(36)}-${refCounter++}`;

export const connect = (apiKey?: string) => bridge.send({ type: 'connect', apiKey });
export const listModels = () => bridge.send({ type: 'models.list' });
export const listFactoryDefaults = () => bridge.send({ type: 'settings.defaults' });
export const listHistory = () => bridge.send({ type: 'sessions.list' });
export const loadMissionHistory = (missionId: string) => bridge.send({ type: 'mission.loadHistory', missionId });
export const resumeMission = (sessionId: string) => bridge.send({ type: 'mission.resume', sessionId });
export const updateAgentSettings = (p: Omit<Extract<ClientCommand, { type: 'settings.agent.update' }>, 'type'>) =>
  bridge.send({ type: 'settings.agent.update', ...p });

export const createMission = (p: Omit<Extract<ClientCommand, { type: 'mission.create' }>, 'type'>) =>
  bridge.send({ type: 'mission.create', ...p });

export const sendToMission = (missionId: string, text: string) =>
  bridge.send({ type: 'mission.send', missionId, text });

export const sendToAgent = (missionId: string, agentSessionId: string, text: string) =>
  bridge.send({ type: 'agent.send', missionId, agentSessionId, text });

export const respondPermission = (
  missionId: string,
  requestId: string,
  outcome: 'proceed_once' | 'proceed_always' | 'proceed_auto_run' | 'cancel',
) => bridge.send({ type: 'mission.respondPermission', missionId, requestId, outcome });

export const respondQuestion = (
  missionId: string,
  requestId: string,
  cancelled: boolean,
  answers: { index: number; question: string; answer: string }[],
) => bridge.send({ type: 'mission.respondQuestion', missionId, requestId, cancelled, answers });

export const interruptMission = (missionId: string) => bridge.send({ type: 'mission.interrupt', missionId });
export const compactSession = (missionId: string, customInstructions?: string) =>
  bridge.send({ type: 'mission.compact', missionId, customInstructions });
export const interruptAgent = (missionId: string, agentSessionId: string) =>
  bridge.send({ type: 'agent.interrupt', missionId, agentSessionId });
export const subscribeWorker = (missionId: string, workerSessionId: string) =>
  bridge.send({ type: 'mission.subscribeWorker', missionId, workerSessionId });
export const closeMission = (missionId: string) => bridge.send({ type: 'mission.close', missionId });
export const openBrowser = (p: Omit<Extract<ClientCommand, { type: 'browser.open' }>, 'type'>) =>
  bridge.send({ type: 'browser.open', ...p });
export const refreshBrowser = (missionId: string) => bridge.send({ type: 'browser.refresh', missionId });
export const resizeBrowserViewport = (p: Omit<Extract<ClientCommand, { type: 'browser.resizeViewport' }>, 'type'>) =>
  bridge.send({ type: 'browser.resizeViewport', ...p });
export const clickBrowser = (p: Omit<Extract<ClientCommand, { type: 'browser.click' }>, 'type'>) =>
  bridge.send({ type: 'browser.click', ...p });
export const typeBrowser = (missionId: string, text: string) =>
  bridge.send({ type: 'browser.type', missionId, text });
export const keypressBrowser = (missionId: string, key: string) =>
  bridge.send({ type: 'browser.keypress', missionId, key });
export const scrollBrowser = (p: Omit<Extract<ClientCommand, { type: 'browser.scroll' }>, 'type'>) =>
  bridge.send({ type: 'browser.scroll', ...p });
export const addDesignReference = (p: Omit<Extract<ClientCommand, { type: 'browser.design.addReference' }>, 'type'>) =>
  bridge.send({ type: 'browser.design.addReference', ...p });
export const sendDesignPrompt = (p: Omit<Extract<ClientCommand, { type: 'browser.design.sendPrompt' }>, 'type'>) =>
  bridge.send({ type: 'browser.design.sendPrompt', ...p });
