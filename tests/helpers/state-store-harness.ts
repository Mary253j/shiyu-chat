import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createStateStore, type StateStoreIO } from '../../src/core/state-store';
import { LEGACY_ASSOCIATED_DATA } from '../../src/core/encryption-format';
import { emptyState, type AppState, type Conversation } from '../../src/core/types';

export function fixtureConversation(id: string, content = `hello ${id}`): Conversation {
  return { id, title: id, createdAt: 1, updatedAt: 1, messages: [
    { id: `${id}-u`, role: 'user', content, createdAt: 1, status: 'complete' },
    { id: `${id}-a`, role: 'assistant', content: `reply ${id}`, createdAt: 2, status: 'complete' },
  ] };
}
export function fixtureState(...conversations: Conversation[]): AppState {
  return { ...emptyState(), activeConversationId: conversations[0]?.id ?? null, conversations };
}

export function createMemoryIO() {
  const files = new Map<string, Uint8Array>();
  const key = randomBytes(32);
  const stats = { lists: 0, reads: [] as string[], writes: [] as string[], encryptions: [] as { context: string; bytes: number }[], removed: [] as string[], clearedSecrets: 0 };
  const faults: { move?: (from: string, to: string) => boolean; remove?: (name: string) => boolean; clear?: boolean } = {};
  let beforeEncrypt: ((context: string) => Promise<void>) | undefined;
  const encode = (plaintext: string, aad: string) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(aad));
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return new Uint8Array(Buffer.concat([iv, encrypted, cipher.getAuthTag()]));
  };
  const decode = (bytes: Uint8Array, aad: string) => {
    const data = Buffer.from(bytes);
    const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
    cipher.setAAD(Buffer.from(aad));
    cipher.setAuthTag(data.subarray(-16));
    return Buffer.concat([cipher.update(data.subarray(12, -16)), cipher.final()]).toString('utf8');
  };
  const io: StateStoreIO = {
    async listFiles() { stats.lists += 1; return [...files.keys()]; },
    async readFile(name) { stats.reads.push(name); const value = files.get(name); if (!value) throw new Error(`missing file ${name}`); return value.slice(); },
    async writeFile(name, data) { stats.writes.push(name); files.set(name, data.slice()); },
    async moveFile(from, to) { if (faults.move?.(from, to)) throw new Error('simulated move failure'); const value = files.get(from); if (!value) throw new Error('missing pending'); files.set(to, value); files.delete(from); },
    async removeFile(name) { if (faults.remove?.(name)) throw new Error('simulated remove failure'); stats.removed.push(name); files.delete(name); },
    async clearFiles() { if (faults.clear) throw new Error('simulated clear failure'); files.clear(); },
    async clearSecrets() { stats.clearedSecrets += 1; },
    async encrypt(plaintext, context) { await beforeEncrypt?.(context); stats.encryptions.push({ context, bytes: Buffer.byteLength(plaintext) }); return encode(plaintext, `shiyu-chat/local-state/v2:${context}`); },
    async decrypt(bytes, context) { return decode(bytes, `shiyu-chat/local-state/v2:${context}`); },
    async decryptLegacy(bytes) {
      const value = JSON.parse(Buffer.from(bytes).toString('utf8'));
      const combined = Buffer.concat([Buffer.from(value.nonce, 'hex'), Buffer.from(value.ciphertext, 'hex')]);
      return decode(combined, LEGACY_ASSOCIATED_DATA);
    },
    async yieldControl() {},
    now: () => 1000,
  };
  return { io, files, key, stats, faults,
    makeStore: () => createStateStore(io),
    setBeforeEncrypt(callback?: (context: string) => Promise<void>) { beforeEncrypt = callback; },
    seedLegacy(state: AppState, generation = 100) {
      const combined = Buffer.from(encode(JSON.stringify(state), LEGACY_ASSOCIATED_DATA));
      const envelope = { version: 1, algorithm: 'AES-256-GCM', nonce: combined.subarray(0, 12).toString('hex'), ciphertext: combined.subarray(12).toString('hex') };
      const name = `state-${generation}.enc`;
      files.set(name, new Uint8Array(Buffer.from(JSON.stringify(envelope))));
      return name;
    },
    resetStats() { stats.lists = 0; stats.reads.length = 0; stats.writes.length = 0; stats.encryptions.length = 0; stats.removed.length = 0; },
    async currentManifest() {
      const name = [...files.keys()].filter(file => /^index-\d+\.enc$/.test(file))
        .sort((a, b) => Number(b.slice(6, -4)) - Number(a.slice(6, -4)))[0];
      if (!name) throw new Error('no manifest');
      return { name, value: JSON.parse(await io.decrypt(await io.readFile(name), `index:${name}`)) };
    },
  };
}
