import * as SecureStore from 'expo-secure-store';
import { Directory, File, Paths } from 'expo-file-system';
import { createStateStore } from '../core/state-store';
import { MAX_ENVELOPE_CHARACTERS, MAX_RECORD_BYTES } from '../core/encryption-format';
import {
  decryptLegacyNative, decryptNative, encryptNative, forgetNativeStorageKey, KEY_OPTIONS, MASTER_KEY_ID,
} from './storage-crypto';

const API_KEY_ID = 'shiyu.deepseek.api-key.v1';
let directoryReady = false;

function directory(): Directory { return new Directory(Paths.document, 'shiyu-private-v1'); }
function ensureDirectory(): Directory {
  const dir = directory();
  if (!directoryReady) { dir.create({ idempotent: true, intermediates: true }); directoryReady = true; }
  return dir;
}

const store = createStateStore({
  async listFiles() {
    const dir = directory();
    directoryReady = dir.exists;
    return dir.exists ? dir.list().map(entry => entry.name) : [];
  },
  async readFile(name) {
    const file = new File(directory(), name);
    const limit = name.startsWith('state-') ? MAX_ENVELOPE_CHARACTERS : MAX_RECORD_BYTES + 28;
    if (file.size > limit) throw new Error('本地记录文件过大，原文件已保留。');
    return await file.bytes();
  },
  async writeFile(name, data) { await new File(ensureDirectory(), name).write(data); },
  async moveFile(from, to) { await new File(directory(), from).move(new File(directory(), to)); },
  async removeFile(name) { const file = new File(directory(), name); if (file.exists) file.delete(); },
  async clearFiles() {
    directoryReady = false;
    const dir = directory();
    if (dir.exists) dir.delete();
  },
  async clearSecrets() {
    forgetNativeStorageKey();
    await SecureStore.deleteItemAsync(MASTER_KEY_ID, KEY_OPTIONS);
    await SecureStore.deleteItemAsync(API_KEY_ID, KEY_OPTIONS);
  },
  encrypt: encryptNative,
  decrypt: decryptNative,
  decryptLegacy: decryptLegacyNative,
  yieldControl: () => new Promise<void>(resolve => setTimeout(resolve, 0)),
});

export const loadState = store.loadState;
export const saveState = store.saveState;
export const deleteAllLocalData = store.deleteAllLocalData;

export function loadApiKey(): Promise<string> {
  return store.runExclusive(async () => (await SecureStore.getItemAsync(API_KEY_ID, KEY_OPTIONS)) ?? '');
}

export function saveApiKey(apiKey: string): Promise<void> {
  const trimmed = apiKey.trim();
  if (trimmed.length > 4096) return Promise.reject(new Error('API Key 长度异常，请重新复制。'));
  return store.runExclusive(async () => {
    if (trimmed) await SecureStore.setItemAsync(API_KEY_ID, trimmed, KEY_OPTIONS);
    else await SecureStore.deleteItemAsync(API_KEY_ID, KEY_OPTIONS);
  });
}
