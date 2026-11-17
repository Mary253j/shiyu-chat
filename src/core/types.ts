export type MessageStatus = 'complete' | 'streaming' | 'stopped' | 'error' | 'refused';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  createdAt: number;
  status: MessageStatus;
  contextEligible?: boolean;
  error?: string;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  sourceId?: string;
  importWarnings?: string[];
  originalData?: unknown;
}

export interface Settings {
  model: 'deepseek-flash' | 'deepseek-v4-pro';
  thinking: boolean;
  contextMessageLimit: number;
  maxOutputTokens: number;
}

export interface AppState {
  schemaVersion: 1;
  conversations: Conversation[];
  activeConversationId: string | null;
  settings: Settings;
}

export const defaultSettings: Settings = {
  model: 'deepseek-flash', thinking: false,
  contextMessageLimit: 40, maxOutputTokens: 4096,
};

export const emptyState = (): AppState => ({
  schemaVersion: 1, conversations: [], activeConversationId: null,
  settings: { ...defaultSettings },
});

export function createId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
