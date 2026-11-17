import * as SecureStore from 'expo-secure-store';
import { getRandomBytesAsync } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { bytesToHex, hexToBytes } from '@noble/ciphers/utils.js';
import { decryptPayload, encryptPayload, MAX_ENVELOPE_CHARACTERS } from '../core/encryption';
import { AppState, emptyState } from '../core/types';

const API_KEY_ID = 'shiyu.deepseek.api-key.v1';
const MASTER_KEY_ID = 'shiyu.local-state.key.v1';
const KEY_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainService: 'shiyu.local.secrets',
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};
const STATE_FILE_PATTERN = /^state-(\d+)\.enc$/;
let operationQueue: Promise<unknown> = Promise.resolve();
let knownGeneration: number | null = null;

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationQueue.then(operation);
  operationQueue = result.catch(() => undefined);
  return result;
}

function directory(): Directory {
  return new Directory(Paths.document, 'shiyu-private-v1');
}

function filesByGeneration(dir: Directory): { file: File; generation: number }[] {
  if (!dir.exists) return [];
  return dir.list().flatMap((entry) => {
    if (!(entry instanceof File)) return [];
    const match = STATE_FILE_PATTERN.exec(entry.name);
    if (!match) return [];
    const generation = Number(match[1]);
    return Number.isSafeInteger(generation) ? [{ file: entry, generation }] : [];
  }).sort((a, b) => b.generation - a.generation);
}

function validateState(data: unknown): asserts data is AppState {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('状态格式无效');
  const state = data as AppState;
  if (state.schemaVersion !== 1 || !Array.isArray(state.conversations)
    || (state.activeConversationId !== null && typeof state.activeConversationId !== 'string')
    || !state.settings || !['deepseek-flash', 'deepseek-v4-pro'].includes(state.settings.model)
    || typeof state.settings.thinking !== 'boolean'
    || !Number.isInteger(state.settings.contextMessageLimit) || state.settings.contextMessageLimit < 1
    || !Number.isInteger(state.settings.maxOutputTokens) || state.settings.maxOutputTokens < 1) {
    throw new Error('状态格式或版本无效');
  }
  const statuses = new Set(['complete', 'streaming', 'stopped', 'error', 'refused']);
  for (const conversation of state.conversations) {
    if (!conversation || typeof conversation.id !== 'string' || typeof conversation.title !== 'string'
      || !Number.isFinite(conversation.createdAt) || !Number.isFinite(conversation.updatedAt)
      || !Array.isArray(conversation.messages)) throw new Error('会话格式无效');
    for (const message of conversation.messages) {
      if (!message || typeof message.id !== 'string' || !['user', 'assistant'].includes(message.role)
        || typeof message.content !== 'string' || !Number.isFinite(message.createdAt)
        || !statuses.has(message.status)
        || (message.reasoning !== undefined && typeof message.reasoning !== 'string')) {
        throw new Error('消息格式无效');
      }
    }
  }
}

async function readMasterKey(create: boolean): Promise<Uint8Array> {
  const encoded = await SecureStore.getItemAsync(MASTER_KEY_ID, KEY_OPTIONS);
  if (encoded !== null) {
    if (!/^[0-9a-f]{64}$/i.test(encoded)) throw new Error('设备中的本地加密密钥无效，聊天文件已保留。');
    return hexToBytes(encoded);
  }
  if (!create) throw new Error('找不到本机加密密钥，无法读取历史。请保留文件并从此前导出的备份恢复。');
  // The asynchronous native RNG avoids the synchronous API's development-mode fallback.
  const key = await getRandomBytesAsync(32);
  await SecureStore.setItemAsync(MASTER_KEY_ID, bytesToHex(key), KEY_OPTIONS);
  return key;
}

async function readState(): Promise<AppState> {
  knownGeneration = null;
  const dir = directory();
  const files = filesByGeneration(dir);
  if (files.length === 0) {
    if (dir.exists && dir.list().some((entry) => entry.name.endsWith('.pending'))) {
      throw new Error('发现中断的首次保存，文件已保留。请先排查存储问题，不要直接清空数据。');
    }
    knownGeneration = 0;
    return emptyState();
  }
  const latest = files[0];
  if (latest.file.size > MAX_ENVELOPE_CHARACTERS) throw new Error('本地记录文件过大，原文件已保留。');
  const key = await readMasterKey(false);
  let data: unknown;
  try {
    const plaintext = decryptPayload(await latest.file.text(), key);
    try {
      data = JSON.parse(plaintext);
      validateState(data);
    } catch {
      throw new Error('本地记录内容或版本无效，原文件已保留。');
    }
  } finally {
    key.fill(0);
  }
  knownGeneration = latest.generation;
  // A process exit may leave a saved streaming answer. Never treat it as a finished turn.
  const state = data as AppState;
  for (const conversation of state.conversations) {
    for (const message of conversation.messages) {
      if (message.status === 'streaming') {
        message.status = 'stopped';
        message.contextEligible = false;
      }
    }
  }
  return state;
}

export function loadState(): Promise<AppState> {
  return serialize(readState);
}

export function saveState(state: AppState): Promise<void> {
  // Capture now: callers may mutate their next state while this write waits in the queue.
  let snapshot: string;
  try {
    validateState(state);
    snapshot = JSON.stringify(state);
  } catch {
    return Promise.reject(new Error('无法保存：聊天数据格式无效，已有记录未修改。'));
  }
  return serialize(async () => {
    const dir = directory();
    const before = filesByGeneration(dir);
    const currentGeneration = before[0]?.generation ?? 0;
    // Refuse to overwrite unreadable data, even if the UI accidentally tries to save an empty state.
    if (knownGeneration === null || knownGeneration !== currentGeneration) await readState();
    dir.create({ idempotent: true, intermediates: true });
    const key = await readMasterKey(before.length === 0);
    const generation = Math.max(Date.now(), currentGeneration + 1);
    const temporary = new File(dir, `state-${generation}.pending`);
    const committed = new File(dir, `state-${generation}.enc`);
    try {
      const nonce = await getRandomBytesAsync(12);
      const payload = encryptPayload(snapshot, key, nonce);
      await temporary.write(payload);
      // New name in the same directory: an interrupted write never replaces the last committed file.
      await temporary.move(committed);
      knownGeneration = generation;
    } finally {
      key.fill(0);
    }
    // Keep a previous encrypted generation for recovery. Cleanup cannot invalidate a successful save.
    try {
      for (const old of filesByGeneration(dir).slice(2)) {
        try { old.file.delete(); } catch { /* retry cleanup on the next save */ }
      }
      for (const entry of dir.list()) {
        if (entry instanceof File && entry.name.endsWith('.pending')) {
          try { entry.delete(); } catch { /* the committed state remains safe */ }
        }
      }
    } catch { /* cleanup is best effort; this generation was already committed */ }
  });
}

export function loadApiKey(): Promise<string> {
  return serialize(async () => (await SecureStore.getItemAsync(API_KEY_ID, KEY_OPTIONS)) ?? '');
}

export function saveApiKey(apiKey: string): Promise<void> {
  const trimmed = apiKey.trim();
  if (trimmed.length > 4096) return Promise.reject(new Error('API Key 长度异常，请重新复制。'));
  return serialize(async () => {
    if (trimmed) await SecureStore.setItemAsync(API_KEY_ID, trimmed, KEY_OPTIONS);
    else await SecureStore.deleteItemAsync(API_KEY_ID, KEY_OPTIONS);
  });
}

export function deleteAllLocalData(): Promise<void> {
  return serialize(async () => {
    const dir = directory();
    // Delete ciphertext first. If removal fails, retain its key so that recovery stays possible.
    if (dir.exists) dir.delete();
    knownGeneration = null;
    await SecureStore.deleteItemAsync(MASTER_KEY_ID, KEY_OPTIONS);
    await SecureStore.deleteItemAsync(API_KEY_ID, KEY_OPTIONS);
  });
}
