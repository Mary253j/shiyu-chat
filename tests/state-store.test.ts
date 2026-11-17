import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createDecipheriv } from 'node:crypto';
import { encryptPayload } from '../src/core/encryption';
import { decodeLegacyHex, LEGACY_ASSOCIATED_DATA, parseLegacyEnvelope } from '../src/core/encryption-format';
import { createMemoryIO, fixtureConversation, fixtureState } from './helpers/state-store-harness';

test('the v0.1.1 JS AES envelope decrypts through the new native-compatible AES parts', async () => {
  const key = randomBytes(32);
  const plaintext = JSON.stringify({ message: '旧对话完整保留 🍗', unknown: { nested: [null, 3] } });
  const envelope = parseLegacyEnvelope(encryptPayload(plaintext, key, randomBytes(12)));
  const iv = await decodeLegacyHex(envelope.nonce, async () => {});
  const ciphertext = await decodeLegacyHex(envelope.ciphertext, async () => {});
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(LEGACY_ASSOCIATED_DATA));
  decipher.setAuthTag(ciphertext.slice(-16));
  assert.equal(Buffer.concat([decipher.update(ciphertext.slice(0, -16)), decipher.final()]).toString('utf8'), plaintext);
});

test('chunked legacy decoding yields and rejects non-hex input', async () => {
  const bytes = randomBytes(600000);
  let yields = 0;
  assert.deepEqual(await decodeLegacyHex(bytes.toString('hex'), async () => { yields += 1; }), new Uint8Array(bytes));
  assert.ok(yields > 0);
  await assert.rejects(decodeLegacyHex('0g', async () => {}), /格式无效/);
});

test('legacy migration preserves all fields and originalData and only commits after its index', async () => {
  const h = createMemoryIO();
  const a = { ...fixtureConversation('a'), originalData: { arbitrary: [1, null, { text: '原始资料' }], branch: { unknown: true } } };
  const legacy = h.seedLegacy(fixtureState(a, fixtureConversation('b')));
  const store = h.makeStore();
  const loaded = await store.loadState();
  await store.saveState(loaded);
  assert.ok(h.files.has(legacy), 'one previous legacy snapshot remains until a subsequent commit');
  assert.deepEqual(await h.makeStore().loadState(), loaded);
  const { value } = await h.currentManifest();
  assert.equal(value.storageVersion, 2);
  assert.ok(value.conversations[0].originalFile);
  const main = await h.io.decrypt(await h.io.readFile(value.conversations[0].recordFile), `record:a:${value.conversations[0].recordFile}`);
  assert.ok(!main.includes('originalData'));
});

test('an index commit failure during migration leaves v1 readable and does not replace it', async () => {
  const h = createMemoryIO();
  const original = fixtureState(fixtureConversation('a'));
  const legacy = h.seedLegacy(original);
  const originalBytes = h.files.get(legacy)!.slice();
  const store = h.makeStore();
  const loaded = await store.loadState();
  h.faults.move = (_from, to) => to.startsWith('index-');
  await assert.rejects(store.saveState(loaded), /move failure/);
  assert.deepEqual(h.files.get(legacy), originalBytes);
  assert.deepEqual(await h.makeStore().loadState(), original);
});

test('unchanged references perform no encryption, writes, directory listing or rereads', async () => {
  const h = createMemoryIO();
  const store = h.makeStore();
  const state = fixtureState(fixtureConversation('a'), fixtureConversation('b'));
  await store.saveState(state);
  h.resetStats();
  await store.saveState(state);
  await store.saveState({ ...state, conversations: [...state.conversations], settings: { ...state.settings } });
  assert.deepEqual(h.stats.encryptions, []);
  assert.deepEqual(h.stats.writes, []);
  assert.equal(h.stats.lists, 0);
  assert.deepEqual(h.stats.reads, []);
});

test('switching the active conversation only writes a small manifest', async () => {
  const h = createMemoryIO(); const store = h.makeStore();
  const state = fixtureState(fixtureConversation('a'), fixtureConversation('b'));
  await store.saveState(state); h.resetStats();
  await store.saveState({ ...state, activeConversationId: 'b' });
  assert.equal(h.stats.encryptions.length, 1);
  assert.match(h.stats.encryptions[0].context, /^index:/);
  assert.equal(h.stats.lists, 0);
});

test('context mode changes survive a restart without rewriting conversation bodies', async () => {
  const h = createMemoryIO(); const store = h.makeStore();
  const state = fixtureState(fixtureConversation('a'));
  // An older installation has no contextMode field and retains its old limit.
  delete state.settings.contextMode;
  await store.saveState(state); h.resetStats();
  const recent = { ...state, settings: { ...state.settings, contextMode: 'recent' as const } };
  await store.saveState(recent);
  assert.equal((await h.makeStore().loadState()).settings.contextMode, 'recent');
  assert.equal(h.stats.encryptions.length, 1);
  assert.match(h.stats.encryptions[0].context, /^index:/);
  await store.saveState({ ...recent, settings: { ...recent.settings, contextMode: 'auto' } });
  assert.equal((await h.makeStore().loadState()).settings.contextMode, 'auto');
});

test('editing one conversation does not serialize other conversations or its originalData', async () => {
  const h = createMemoryIO(); const store = h.makeStore();
  let originalReads = 0;
  let untouchedReads = 0;
  const originalData = { toJSON() { originalReads += 1; return { source: 'old branch' }; } };
  const a = { ...fixtureConversation('a'), originalData };
  const b = { ...fixtureConversation('b'), toJSON() { untouchedReads += 1; return fixtureConversation('b'); } };
  const state = fixtureState(a, b);
  await store.saveState(state); originalReads = 0; untouchedReads = 0; h.resetStats();
  const changed = { ...a, messages: [...a.messages, { ...a.messages[0], id: 'a-new', content: 'next' }] };
  await store.saveState({ ...state, conversations: [changed, b] });
  assert.equal(originalReads, 0); assert.equal(untouchedReads, 0);
  assert.equal(h.stats.encryptions.filter(entry => entry.context.startsWith('record:')).length, 1);
  assert.equal(h.stats.encryptions.filter(entry => entry.context.startsWith('original:')).length, 0);
  assert.equal(h.stats.lists, 0);
});

test('a nearly 20 MiB originalData blob is not rewritten while chatting', async () => {
  const h = createMemoryIO(); const store = h.makeStore();
  const originalData = { archive: 'x'.repeat(19 * 1024 * 1024) };
  const a = { ...fixtureConversation('a'), originalData };
  const state = fixtureState(a, ...Array.from({ length: 100 }, (_, i) => fixtureConversation(`other-${i}`)));
  await store.saveState(state); h.resetStats();
  const changed = { ...a, updatedAt: 5, messages: [...a.messages, { ...a.messages[0], id: 'a-next', content: '继续聊' }] };
  await store.saveState({ ...state, conversations: [changed, ...state.conversations.slice(1)] });
  assert.equal(h.stats.encryptions.length, 2);
  assert.ok(h.stats.encryptions.reduce((bytes, entry) => bytes + entry.bytes, 0) < 32 * 1024);
  assert.equal(h.stats.lists, 0);
  const reread = await h.makeStore().loadState();
  assert.deepEqual(reread.conversations[0].originalData, originalData);
});

test('restored streaming replies are dirty until stopped is persisted, with originalData reused', async () => {
  const h = createMemoryIO();
  const a = { ...fixtureConversation('a'), originalData: { preserved: true } };
  a.messages[1] = { ...a.messages[1], status: 'streaming' };
  await h.makeStore().saveState(fixtureState(a));
  const restarted = h.makeStore(); const loaded = await restarted.loadState();
  assert.equal(loaded.conversations[0].messages[1].status, 'stopped');
  assert.equal(loaded.conversations[0].messages[1].contextEligible, false);
  h.resetStats(); await restarted.saveState(loaded);
  assert.equal(h.stats.encryptions.filter(entry => entry.context.startsWith('record:')).length, 1);
  assert.equal(h.stats.encryptions.filter(entry => entry.context.startsWith('original:')).length, 0);
  const { value } = await h.currentManifest(); const ref = value.conversations[0];
  const body = JSON.parse(await h.io.decrypt(await h.io.readFile(ref.recordFile), `record:a:${ref.recordFile}`));
  assert.equal(body.conversation.messages[1].status, 'stopped');
});

test('clear is a synchronous barrier against in-flight and queued stale saves', async () => {
  const h = createMemoryIO(); const store = h.makeStore();
  await store.saveState(fixtureState(fixtureConversation('a')));
  let release!: () => void; let started!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const began = new Promise<void>(resolve => { started = resolve; });
  h.setBeforeEncrypt(async context => { if (context.startsWith('record:')) { started(); await pending; } });
  const state = fixtureState(fixtureConversation('a', 'new secret'));
  const writing = store.saveState(state); await began;
  const queued = store.saveState({ ...state, activeConversationId: null });
  const clear = store.deleteAllLocalData();
  const duringClear = store.saveState(state);
  release(); await Promise.all([writing, queued, clear, duringClear]);
  assert.equal(h.files.size, 0);
  assert.equal(h.stats.clearedSecrets, 1);
  assert.equal((await store.loadState()).conversations.length, 0);
});

test('failed ciphertext deletion preserves the encryption secret', async () => {
  const h = createMemoryIO(); const store = h.makeStore();
  const state = fixtureState(fixtureConversation('a'));
  await store.saveState(state); h.faults.clear = true;
  await assert.rejects(store.deleteAllLocalData(), /clear failure/);
  assert.equal(h.stats.clearedSecrets, 0);
  assert.deepEqual(await store.loadState(), state);
});
