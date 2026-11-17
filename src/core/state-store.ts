import type { AppState, Conversation, Message, Settings } from './types';
import { emptyState } from './types';

/** File names are generated locally. Imported conversation ids are never used as paths. */
export interface StoredConversationRef {
  id: string;
  recordFile: string;
  originalFile?: string;
}

export interface StateManifest {
  storageVersion: 2;
  schemaVersion: 1;
  generation: number;
  activeConversationId: string | null;
  settings: Settings;
  conversations: StoredConversationRef[];
  /** Only this immediate predecessor may be retained; never follow a predecessor chain. */
  previousIndex: string | null;
  /** Retained for one successful v2 generation after migration, unless a conversation was deleted. */
  legacyFallback: string | null;
}

export interface StateStoreIO {
  listFiles(): Promise<string[]>;
  readFile(name: string): Promise<Uint8Array>;
  writeFile(name: string, data: Uint8Array): Promise<void>;
  moveFile(from: string, to: string): Promise<void>;
  removeFile(name: string): Promise<void>;
  clearFiles(): Promise<void>;
  clearSecrets(): Promise<void>;
  encrypt(plaintext: string, context: string): Promise<Uint8Array>;
  decrypt(ciphertext: Uint8Array, context: string): Promise<string>;
  decryptLegacy(ciphertext: Uint8Array): Promise<string>;
  yieldControl?(): Promise<void>;
  now?(): number;
}

const INDEX_PATTERN = /^index-(\d+)\.enc$/;
const LEGACY_PATTERN = /^state-(\d+)\.enc$/;
const RECORD_PATTERN = /^record-\d+-\d+\.enc$/;
const ORIGINAL_PATTERN = /^original-\d+-\d+\.enc$/;
const OWNED_FILE_PATTERN = /^(?:state|index|record|original)-\d+(?:-\d+)?\.(?:enc|pending)$/;
const statuses = new Set(['complete', 'streaming', 'stopped', 'error', 'refused']);

interface CacheEntry {
  bodyRef: Conversation | null;
  originalRef: unknown;
  stored: StoredConversationRef;
}

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('本地记录格式无效。');
}

function assertSettings(value: unknown): asserts value is Settings {
  assertRecord(value);
  if (!['deepseek-flash', 'deepseek-v4-pro'].includes(String(value.model))
    || (value.contextMode !== undefined && value.contextMode !== 'auto' && value.contextMode !== 'recent')
    || typeof value.thinking !== 'boolean'
    || !Number.isInteger(value.contextMessageLimit) || Number(value.contextMessageLimit) < 1
    || !Number.isInteger(value.maxOutputTokens) || Number(value.maxOutputTokens) < 1) {
    throw new Error('本地设置格式无效。');
  }
}

function assertStateHeader(value: unknown): asserts value is AppState {
  assertRecord(value);
  if (value.schemaVersion !== 1 || !Array.isArray(value.conversations)
    || (value.activeConversationId !== null && typeof value.activeConversationId !== 'string')) {
    throw new Error('本地记录版本或格式无效。');
  }
  assertSettings(value.settings);
}

function assertConversation(value: unknown): asserts value is Conversation {
  assertRecord(value);
  if (typeof value.id !== 'string' || !value.id || typeof value.title !== 'string'
    || !Number.isFinite(value.createdAt) || !Number.isFinite(value.updatedAt)
    || !Array.isArray(value.messages)) throw new Error('本地会话格式无效。');
  for (const message of value.messages) {
    assertRecord(message);
    if (typeof message.id !== 'string' || !['user', 'assistant'].includes(String(message.role))
      || typeof message.content !== 'string' || !Number.isFinite(message.createdAt)
      || !statuses.has(String(message.status))
      || (message.reasoning !== undefined && typeof message.reasoning !== 'string')) {
      throw new Error('本地消息格式无效。');
    }
  }
}

function generationOf(name: string, pattern: RegExp): number | null {
  const match = pattern.exec(name);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parseManifest(plaintext: string, name: string): StateManifest {
  const value: unknown = JSON.parse(plaintext);
  assertRecord(value);
  if (value.storageVersion !== 2 || value.schemaVersion !== 1
    || value.generation !== generationOf(name, INDEX_PATTERN)
    || !Array.isArray(value.conversations)
    || (value.activeConversationId !== null && typeof value.activeConversationId !== 'string')
    || (value.previousIndex !== null && (typeof value.previousIndex !== 'string'
      || generationOf(value.previousIndex, INDEX_PATTERN) === null
      || Number(generationOf(value.previousIndex, INDEX_PATTERN)) >= Number(value.generation)))
    || (value.legacyFallback !== null && (typeof value.legacyFallback !== 'string'
      || generationOf(value.legacyFallback, LEGACY_PATTERN) === null))) {
    throw new Error('本地索引格式无效，原文件已保留。');
  }
  assertSettings(value.settings);
  const ids = new Set<string>();
  const records = new Set<string>();
  const originals = new Set<string>();
  for (const reference of value.conversations) {
    assertRecord(reference);
    if (typeof reference.id !== 'string' || !reference.id || ids.has(reference.id)
      || typeof reference.recordFile !== 'string' || !RECORD_PATTERN.test(reference.recordFile)
      || records.has(reference.recordFile)
      || (reference.originalFile !== undefined && (typeof reference.originalFile !== 'string'
        || !ORIGINAL_PATTERN.test(reference.originalFile) || originals.has(reference.originalFile)))) {
      throw new Error('本地索引中的会话引用无效，原文件已保留。');
    }
    ids.add(reference.id);
    records.add(reference.recordFile);
    if (reference.originalFile) originals.add(reference.originalFile as string);
  }
  return value as unknown as StateManifest;
}

function restoreInterrupted(conversation: Conversation): { conversation: Conversation; changed: boolean } {
  if (!conversation.messages.some(message => message.status === 'streaming')) {
    return { conversation, changed: false };
  }
  const messages: Message[] = conversation.messages.map(message => message.status === 'streaming'
    ? { ...message, status: 'stopped', contextEligible: false }
    : message);
  return { conversation: { ...conversation, messages }, changed: true };
}

function equalSettings(a: Settings, b: Settings): boolean {
  return a.model === b.model && a.thinking === b.thinking
    && (a.contextMode ?? 'auto') === (b.contextMode ?? 'auto')
    && a.contextMessageLimit === b.contextMessageLimit && a.maxOutputTokens === b.maxOutputTokens;
}

/**
 * Immutable-state store. Callers must not mutate a state or its nested objects after saveState.
 * All work, including validation and JSON conversion, starts after the promise queue yields.
 */
export function createStateStore(io: StateStoreIO) {
  let queue: Promise<unknown> = Promise.resolve();
  let epoch = 0;
  let clearing = false;
  let clearPromise: Promise<void> | null = null;
  let initialized = false;
  let stateRef: AppState | null = null;
  let manifest: StateManifest | null = null;
  let manifestName: string | null = null;
  let predecessor: { name: string; manifest: StateManifest } | null = null;
  let legacyName: string | null = null;
  let cache = new Map<string, CacheEntry>();
  let knownFiles = new Set<string>();
  let highestGeneration = 0;
  let cleanupPending = false;

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation);
    queue = result.catch(() => undefined);
    return result;
  }

  function resetCache() {
    initialized = false;
    stateRef = null;
    manifest = null;
    manifestName = null;
    predecessor = null;
    legacyName = null;
    cache = new Map();
    knownFiles = new Set();
    highestGeneration = 0;
    cleanupPending = false;
  }

  async function yieldControl() {
    if (io.yieldControl) await io.yieldControl();
  }

  async function readIndex(name: string) {
    return parseManifest(await io.decrypt(await io.readFile(name), `index:${name}`), name);
  }

  async function cleanup() {
    if (!manifest || !manifestName) return;
    cleanupPending = false;
    const keep = new Set<string>([manifestName]);
    const addReferences = (index: StateManifest) => {
      for (const reference of index.conversations) {
        keep.add(reference.recordFile);
        if (reference.originalFile) keep.add(reference.originalFile);
      }
    };
    addReferences(manifest);
    if (manifest.legacyFallback) keep.add(manifest.legacyFallback);
    if (predecessor && predecessor.name === manifest.previousIndex) {
      // A predecessor must never retain a conversation deleted from the current index.
      const ids = new Set(manifest.conversations.map(reference => reference.id));
      if (predecessor.manifest.conversations.every(reference => ids.has(reference.id))) {
        keep.add(predecessor.name);
        addReferences(predecessor.manifest);
      }
    }
    let removals = 0;
    for (const name of knownFiles) {
      if (!OWNED_FILE_PATTERN.test(name) || keep.has(name)) continue;
      try { await io.removeFile(name); knownFiles.delete(name); } catch { cleanupPending = true; }
      if (++removals % 16 === 0) await yieldControl();
    }
  }

  async function loadInternal(): Promise<AppState> {
    resetCache();
    try {
      knownFiles = new Set(await io.listFiles());
      const indexes = [...knownFiles].flatMap(name => {
        const generation = generationOf(name, INDEX_PATTERN);
        return generation === null ? [] : [{ name, generation }];
      }).sort((a, b) => b.generation - a.generation);
      const legacyFiles = [...knownFiles].flatMap(name => {
        const generation = generationOf(name, LEGACY_PATTERN);
        return generation === null ? [] : [{ name, generation }];
      }).sort((a, b) => b.generation - a.generation);
      highestGeneration = Math.max(indexes[0]?.generation ?? 0, legacyFiles[0]?.generation ?? 0);
      for (const name of knownFiles) {
        const match = /^(?:state|index|record|original)-(\d+)(?:-\d+)?\.(?:enc|pending)$/.exec(name);
        const generation = match ? Number(match[1]) : 0;
        if (Number.isSafeInteger(generation)) highestGeneration = Math.max(highestGeneration, generation);
      }
      if (indexes.length) {
        const latest = indexes[0];
        const loadedManifest = await readIndex(latest.name);
        const conversations: Conversation[] = [];
        const loadedCache = new Map<string, CacheEntry>();
        for (const reference of loadedManifest.conversations) {
          await yieldControl();
          const body: unknown = JSON.parse(await io.decrypt(await io.readFile(reference.recordFile),
            `record:${reference.id}:${reference.recordFile}`));
          assertRecord(body);
          if (body.storageVersion !== 2 || body.id !== reference.id) throw new Error('本地会话引用不匹配。');
          assertConversation(body.conversation);
          if (body.conversation.id !== reference.id || body.conversation.originalData !== undefined) {
            throw new Error('本地会话内容不匹配。');
          }
          let originalData: unknown;
          if (reference.originalFile) {
            const original: unknown = JSON.parse(await io.decrypt(await io.readFile(reference.originalFile),
              `original:${reference.id}:${reference.originalFile}`));
            assertRecord(original);
            if (original.storageVersion !== 2 || original.id !== reference.id
              || !Object.prototype.hasOwnProperty.call(original, 'originalData')) {
              throw new Error('本地原始资料引用不匹配。');
            }
            originalData = original.originalData;
          }
          const complete: Conversation = originalData === undefined
            ? body.conversation : { ...body.conversation, originalData };
          const recovered = restoreInterrupted(complete);
          conversations.push(recovered.conversation);
          loadedCache.set(reference.id, { bodyRef: recovered.changed ? null : recovered.conversation,
            originalRef: originalData, stored: reference });
        }
        manifest = loadedManifest;
        manifestName = latest.name;
        cache = loadedCache;
        stateRef = { schemaVersion: 1, conversations, activeConversationId: manifest.activeConversationId,
          settings: manifest.settings };
        // Predecessor data is not used to recover current data. Its corruption does not hide a valid current state.
        if (manifest.previousIndex && knownFiles.has(manifest.previousIndex)) {
          try { predecessor = { name: manifest.previousIndex, manifest: await readIndex(manifest.previousIndex) }; }
          catch { predecessor = null; }
        }
        initialized = true;
        await cleanup();
        return stateRef;
      }
      if (legacyFiles.length) {
        legacyName = legacyFiles[0].name;
        const data: unknown = JSON.parse(await io.decryptLegacy(await io.readFile(legacyName)));
        assertStateHeader(data);
        const ids = new Set<string>();
        const conversations: Conversation[] = [];
        for (const conversation of data.conversations) {
          await yieldControl();
          assertConversation(conversation);
          if (ids.has(conversation.id)) throw new Error('本地会话编号重复。');
          ids.add(conversation.id);
          conversations.push(restoreInterrupted(conversation).conversation);
        }
        stateRef = { ...data, conversations };
        initialized = true;
        return stateRef;
      }
      if ([...knownFiles].some(name => OWNED_FILE_PATTERN.test(name))) {
        throw new Error('发现中断的首次保存，文件已保留。请先排查存储问题。');
      }
      stateRef = emptyState();
      initialized = true;
      return stateRef;
    } catch (error) {
      initialized = false;
      stateRef = null;
      cache.clear();
      throw error;
    }
  }

  async function writeEncrypted(name: string, plaintext: string, context: string, saveEpoch: number): Promise<boolean> {
    const data = await io.encrypt(plaintext, context);
    if (saveEpoch !== epoch || clearing) return false;
    const pending = name.replace(/\.enc$/, '.pending');
    knownFiles.add(pending);
    await io.writeFile(pending, data);
    if (saveEpoch !== epoch || clearing) return false;
    await io.moveFile(pending, name);
    knownFiles.delete(pending);
    knownFiles.add(name);
    return saveEpoch === epoch && !clearing;
  }

  async function saveInternal(state: AppState, saveEpoch: number): Promise<void> {
    if (saveEpoch !== epoch || clearing) return;
    if (!initialized) await loadInternal();
    if (saveEpoch !== epoch || clearing) return;
    assertStateHeader(state);
    const ids = new Set<string>();
    for (const conversation of state.conversations) {
      if (!conversation || typeof conversation.id !== 'string' || !conversation.id || ids.has(conversation.id)) {
        throw new Error('无法保存：会话编号无效或重复。');
      }
      ids.add(conversation.id);
    }
    const changed = state.conversations.filter(conversation => cache.get(conversation.id)?.bodyRef !== conversation);
    const sameOrder = manifest?.conversations.length === state.conversations.length
      && manifest.conversations.every((reference, index) => reference.id === state.conversations[index].id);
    if (manifest && changed.length === 0 && sameOrder
      && manifest.activeConversationId === state.activeConversationId && equalSettings(manifest.settings, state.settings)) {
      stateRef = state;
      if (cleanupPending) await cleanup();
      return;
    }
    const generation = Math.max(io.now?.() ?? Date.now(), highestGeneration + 1);
    if (!Number.isSafeInteger(generation)) throw new Error('本地存储版本号异常。');
    highestGeneration = generation;
    const nextCache = new Map<string, CacheEntry>();
    const references: StoredConversationRef[] = [];
    let recordNumber = 0;
    for (const conversation of state.conversations) {
      const previous = cache.get(conversation.id);
      if (previous?.bodyRef === conversation) {
        references.push(previous.stored);
        nextCache.set(conversation.id, previous);
        continue;
      }
      await yieldControl();
      if (saveEpoch !== epoch || clearing) return;
      assertConversation(conversation);
      const number = recordNumber++;
      let originalFile: string | undefined;
      if (conversation.originalData !== undefined) {
        if (previous?.originalRef === conversation.originalData && previous.stored.originalFile) {
          originalFile = previous.stored.originalFile;
        } else {
          originalFile = `original-${generation}-${number}.enc`;
          const plaintext = JSON.stringify({ storageVersion: 2, id: conversation.id, originalData: conversation.originalData });
          if (!await writeEncrypted(originalFile, plaintext, `original:${conversation.id}:${originalFile}`, saveEpoch)) return;
          await yieldControl();
        }
      }
      const recordFile = `record-${generation}-${number}.enc`;
      const { originalData: _originalData, ...body } = conversation;
      const plaintext = JSON.stringify({ storageVersion: 2, id: conversation.id, conversation: body });
      if (!await writeEncrypted(recordFile, plaintext, `record:${conversation.id}:${recordFile}`, saveEpoch)) return;
      const stored: StoredConversationRef = { id: conversation.id, recordFile, ...(originalFile ? { originalFile } : {}) };
      references.push(stored);
      nextCache.set(conversation.id, { bodyRef: conversation, originalRef: conversation.originalData, stored });
    }
    const removedConversation = stateRef?.conversations.some(conversation => !ids.has(conversation.id)) ?? false;
    const next: StateManifest = {
      storageVersion: 2, schemaVersion: 1, generation,
      activeConversationId: state.activeConversationId, settings: { ...state.settings }, conversations: references,
      previousIndex: removedConversation ? null : manifestName,
      legacyFallback: !manifest && !removedConversation ? legacyName : null,
    };
    const nextName = `index-${generation}.enc`;
    if (!await writeEncrypted(nextName, JSON.stringify(next), `index:${nextName}`, saveEpoch)) return;
    // This is the only commit point. No preceding blob write changes the readable state.
    predecessor = next.previousIndex && manifest && manifestName ? { name: manifestName, manifest } : null;
    manifest = next;
    manifestName = nextName;
    stateRef = state;
    cache = nextCache;
    legacyName = null;
    await cleanup();
  }

  return {
    loadState(): Promise<AppState> { return serialize(loadInternal); },
    saveState(state: AppState): Promise<void> {
      if (clearing) return Promise.resolve();
      const saveEpoch = epoch;
      return serialize(async () => {
        try { await saveInternal(state, saveEpoch); }
        catch (error) {
          // A native move can finish before its promise fails. Reread disk before any next save,
          // rather than using a stale cache and accidentally accepting the wrong committed state.
          resetCache();
          throw error;
        }
      });
    },
    /** Use the same barrier for key operations so a late connection cannot repopulate cleared credentials. */
    runExclusive<T>(operation: () => Promise<T>): Promise<T> {
      const operationEpoch = epoch;
      return serialize(() => {
        if (clearing || operationEpoch !== epoch) throw new Error('本机数据正在清除，请稍后重试。');
        return operation();
      });
    },
    deleteAllLocalData(): Promise<void> {
      if (clearPromise) return clearPromise;
      epoch += 1;
      clearing = true;
      clearPromise = serialize(async () => {
        resetCache();
        // Retain secrets when file deletion fails; remaining ciphertext must remain recoverable.
        await io.clearFiles();
        await io.clearSecrets();
      }).finally(() => { clearing = false; clearPromise = null; });
      return clearPromise;
    },
  };
}
