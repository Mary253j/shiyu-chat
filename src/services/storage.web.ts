import { AppState, emptyState } from '../core/types';

// Browser preview only: never put a user's key or conversations in localStorage.
// A page reload deliberately starts a new session; the UI communicates this limitation.
let previewState: AppState = emptyState();
let previewKey = '';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export async function loadState(): Promise<AppState> { return clone(previewState); }
export async function saveState(state: AppState): Promise<void> { previewState = clone(state); }
export async function loadApiKey(): Promise<string> { return previewKey; }
export async function saveApiKey(apiKey: string): Promise<void> { previewKey = apiKey.trim(); }
export async function deleteAllLocalData(): Promise<void> {
  previewState = emptyState();
  previewKey = '';
}
