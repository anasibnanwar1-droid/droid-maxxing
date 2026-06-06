export interface Thread {
  id: string;
  title: string;
  projectId: string;
  droidId: string;
  messages: Message[];
  status: 'idle' | 'running' | 'thinking' | 'error';
  createdAt: Date;
  updatedAt: Date;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: Date;
  toolCalls?: ToolCall[];
  artifacts?: Artifact[];
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
  status: 'pending' | 'running' | 'complete' | 'error';
}

export interface Artifact {
  id: string;
  type: 'file' | 'diff' | 'image' | 'plan' | 'terminal';
  title: string;
  content: string;
  language?: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  branch: string;
  threads: Thread[];
}

export interface Droid {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  plugins: string[];
}

export interface PlanStep {
  id: string;
  title: string;
  status: 'pending' | 'in-progress' | 'complete' | 'failed';
  description?: string;
}
