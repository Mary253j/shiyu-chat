import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import test from 'node:test';
import { createStateStore, type StateManifest, type StateStoreIO } from '../src/core/state-store';
import { decryptPayload, encryptPayload } from '../src/core/encryption';
import { emptyState, type AppState } from '../src/core/types';

type Hook = (operation: string, name: string, phase: 'before' | 'after') => void | Promise<void>;

function fixture(): AppState {
  return {
    ...emptyState(), activeConversationId: 'first', conversations: [
      { id: 'first', title: '会话一', createdAt: 1, updatedAt: 2, sourceId: 'deepseek:original',
        messages: [
          { id: 'u1', role: 'user', content: '以前的事情', createdAt: 1, status: 'complete' },
          { id: 'a1', role: 'assistant', content: '记得 🍊', reasoning: '已保存的思考', createdAt: 2, status: 'complete', contextEligible: true },
        ], importWarnings: ['未迁移附件'], originalData: {
          mapping: { hidden: { parent: 'old', fragments: [{ type: 'UNKNOWN_TOOL', data: [null, { '原字段': '保留' }] }] } },
          attachments: [{ file_name: '图片.png', is_image: true }], futureMetadata: { pinned: true },
        } },
      { id: 'second', title: '会话二', createdAt: 3, updatedAt: 3,
        messages: [{ id: 'u2', role: 'user', content: '第二个会话', createdAt: 3, status: 'complete' }] },
    ],
  };
}

function environment() {
  const files = new Map<string, Uint8Array>();
  let key = randomBytes(32); let secretPresent = true; let clock = 1000;
  let hook: Hook = () => undefined;
  const io: StateStoreIO = {
    async listFiles() { return [...files.keys()]; },
    async readFile(name) {
      await hook('read', name, 'before');
      const bytes = files.get(name); if (!bytes) throw new Error(`Missing file: ${name}`);
      return bytes.slice();
    },
    async writeFile(name, bytes) {
      await hook('write', name, 'before'); files.set(name, bytes.slice()); await hook('write', name, 'after');
    },
    async moveFile(from, to) {
      await hook('move', to, 'before');
      const bytes = files.get(from); if (!bytes) throw new Error(`Missing pending: ${from}`);
      if (files.has(to)) throw new Error('Target already exists');
      files.set(to, bytes); files.delete(from); await hook('move', to, 'after');
    },
    async removeFile(name) {
      await hook('remove', name, 'before'); files.delete(name); await hook('remove', name, 'after');
    },
    async clearFiles() {
      await hook('clearFiles', '', 'before'); files.clear(); await hook('clearFiles', '', 'after');
    },
    async clearSecrets() { secretPresent = false; },
    async encrypt(plaintext, context) {
      await hook('encrypt', context, 'before');
      if (!secretPresent) { key = randomBytes(32); secretPresent = true; }
      const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from(context));
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
    },
    async decrypt(bytes, context) {
      if (!secretPresent) throw new Error('Missing key');
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    },
    async decryptLegacy(bytes) {
      if (!secretPresent) throw new Error('Missing key');
      return decryptPayload(Buffer.from(bytes).toString('utf8'), key);
    },
    async yieldControl() { await Promise.resolve(); },
    now() { return ++clock; },
  };
  return {
    files, io,
    setHook(value: Hook) { hook = value; },
    forgetSecret() { secretPresent = false; },
    hasSecret() { return secretPresent; },
    legacy(state: AppState) {
      files.set('state-100.enc', Buffer.from(encryptPayload(JSON.stringify(state), key, randomBytes(12))));
    },
    snapshot() { return [...files].map(([name, bytes]) => [name, Buffer.from(bytes).toString('hex')]).sort(); },
    async latest() {
      const name = [...files.keys()].filter(value => /^index-\d+\.enc$/.test(value))
        .sort((a, b) => Number(b.slice(6, -4)) - Number(a.slice(6, -4)))[0];
      if (!name) throw new Error('No manifest');
      return { name, manifest: JSON.parse(await io.decrypt(files.get(name)!, `index:${name}`)) as StateManifest };
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('review: migration interruptions preserve v1 until a complete v2 commit', async () => {
  for (const point of ['original-write', 'record-write', 'index-before-move', 'index-after-move']) {
    const env = environment(); const expected = fixture(); env.legacy(expected);
    const legacyBytes = Buffer.from(env.files.get('state-100.enc')!);
    const store = createStateStore(env.io); const loaded = await store.loadState();
    let fired = false;
    env.setHook((operation, name, phase) => {
      const matches = point === 'original-write' ? operation === 'write' && name.startsWith('original-') && phase === 'after'
        : point === 'record-write' ? operation === 'write' && name.startsWith('record-') && phase === 'after'
          : operation === 'move' && name.startsWith('index-') && phase === (point === 'index-before-move' ? 'before' : 'after');
      if (!fired && matches) { fired = true; throw new Error('Simulated process exit'); }
    });
    await assert.rejects(store.saveState(loaded), /process exit/);
    assert.ok(fired, point);
    assert.deepEqual(Buffer.from(env.files.get('state-100.enc')!), legacyBytes, point);
    env.setHook(() => undefined);
    const restarted = createStateStore(env.io);
    assert.deepEqual(await restarted.loadState(), expected, point);
    await restarted.saveState(await restarted.loadState());
    assert.deepEqual(await createStateStore(env.io).loadState(), expected, point);
  }
});

test('review: committed corrupt or incomplete v2 never falls back or permits empty overwrite', async () => {
  for (const damage of ['index', 'body', 'original', 'key']) {
    const env = environment(); const expected = fixture(); env.legacy(expected);
    await createStateStore(env.io).saveState(expected);
    const { name, manifest } = await env.latest();
    if (damage === 'index') env.files.get(name)![30] ^= 1;
    else if (damage === 'body') env.files.delete(manifest.conversations[1].recordFile);
    else if (damage === 'original') env.files.delete(manifest.conversations[0].originalFile!);
    else env.forgetSecret();
    const before = env.snapshot(); const restarted = createStateStore(env.io);
    await assert.rejects(restarted.loadState(), error => error instanceof Error, damage);
    await assert.rejects(restarted.saveState(emptyState()), error => error instanceof Error, damage);
    assert.deepEqual(env.snapshot(), before, damage);
    assert.ok(env.files.has('state-100.enc'), damage);
  }
});

test('review: swapping authenticated conversation ciphertext across references fails closed', async () => {
  const env = environment(); await createStateStore(env.io).saveState(fixture());
  const { manifest } = await env.latest(); const [first, second] = manifest.conversations;
  const a = env.files.get(first.recordFile)!; const b = env.files.get(second.recordFile)!;
  env.files.set(first.recordFile, b); env.files.set(second.recordFile, a);
  await assert.rejects(createStateStore(env.io).loadState());
});

test('review: correctly authenticated data with a mismatched internal conversation ID is rejected', async () => {
  const env = environment(); await createStateStore(env.io).saveState(fixture());
  const { manifest } = await env.latest(); const reference = manifest.conversations[0];
  const context = `record:${reference.id}:${reference.recordFile}`;
  const body = JSON.parse(await env.io.decrypt(env.files.get(reference.recordFile)!, context));
  body.conversation.id = 'second';
  env.files.set(reference.recordFile, await env.io.encrypt(JSON.stringify(body), context));
  await assert.rejects(createStateStore(env.io).loadState(), /内容不匹配/);
});

test('review: failed deletion cleanup retries after restart without resurrecting a deleted conversation', async () => {
  const env = environment(); const expected = fixture(); env.legacy(expected);
  const store = createStateStore(env.io); await store.saveState(expected);
  const before = await env.latest();
  env.setHook((operation) => { if (operation === 'remove') throw new Error('Cleanup unavailable'); });
  const next: AppState = { ...expected, activeConversationId: 'second', conversations: [expected.conversations[1]] };
  await store.saveState(next);
  const latest = await env.latest();
  assert.equal(latest.manifest.previousIndex, null); assert.equal(latest.manifest.legacyFallback, null);
  assert.ok(env.files.has(before.name)); assert.ok(env.files.has('state-100.enc'));
  env.setHook(() => undefined);
  assert.deepEqual(await createStateStore(env.io).loadState(), next);
  assert.ok(!env.files.has(before.name)); assert.ok(!env.files.has('state-100.enc'));
  for (const ref of before.manifest.conversations.filter(value => value.id === 'first')) {
    assert.ok(!env.files.has(ref.recordFile)); assert.ok(!env.files.has(ref.originalFile!));
  }
  assert.equal((await createStateStore(env.io).loadState()).conversations[0].messages[0].content, '第二个会话');
});

test('review: an unchanged save retries deletion cleanup without rewriting the committed index', async () => {
  const env = environment(); const initial = fixture(); const store = createStateStore(env.io);
  await store.saveState(initial); const old = await env.latest();
  env.setHook(operation => { if (operation === 'remove') throw new Error('Cleanup unavailable'); });
  const next = { ...initial, conversations: [initial.conversations[1]], activeConversationId: 'second' };
  await store.saveState(next); const committed = await env.latest();
  assert.ok(env.files.has(old.name));
  env.setHook(() => undefined); await store.saveState(next);
  assert.equal((await env.latest()).name, committed.name);
  assert.ok(!env.files.has(old.name));
  assert.ok(!env.files.has(old.manifest.conversations[0].recordFile));
});

test('review: a commit which succeeds on disk but rejects in memory cannot undo a later deletion', async () => {
  const env = environment(); const initial = fixture(); const store = createStateStore(env.io);
  await store.saveState(initial);
  const changed = { ...initial, conversations: initial.conversations.map(value => ({ ...value, title: '已落盘但返回失败' })) };
  let fired = false;
  env.setHook((operation, name, phase) => {
    if (!fired && operation === 'move' && name.startsWith('index-') && phase === 'after') {
      fired = true; throw new Error('Response lost after rename');
    }
  });
  await assert.rejects(store.saveState(changed), /Response lost/);
  env.setHook(() => undefined);
  const next = { ...changed, conversations: [changed.conversations[1]], activeConversationId: 'second' };
  await store.saveState(next);
  assert.deepEqual(await createStateStore(env.io).loadState(), next);
  const latest = await env.latest();
  assert.equal(latest.manifest.previousIndex, null);
  assert.deepEqual([...env.files.keys()].filter(name => name.startsWith('index-')), [latest.name]);
});

test('review: clearing invalidates in-flight, queued and during-clear saves, then permits a new session', async () => {
  const env = environment(); const initial = fixture(); const store = createStateStore(env.io);
  await store.saveState(initial);
  const reached = deferred(); const release = deferred(); let blocked = false;
  env.setHook(async (operation, name, phase) => {
    if (!blocked && operation === 'encrypt' && name.startsWith('record:') && phase === 'before') {
      blocked = true; reached.resolve(); await release.promise;
    }
  });
  const changed = { ...initial, conversations: initial.conversations.map(value => ({ ...value, title: '待清除的修改' })) };
  const writing = store.saveState(changed); await reached.promise;
  const queued = store.saveState(changed);
  const clearing = store.deleteAllLocalData();
  const duringClear = store.saveState(initial);
  release.resolve();
  await Promise.all([writing, queued, clearing, duringClear]);
  assert.equal(env.files.size, 0); assert.equal(env.hasSecret(), false);
  env.setHook(() => undefined);
  const fresh = { ...emptyState(), conversations: [initial.conversations[1]], activeConversationId: 'second' };
  await store.saveState(fresh);
  assert.deepEqual(await createStateStore(env.io).loadState(), fresh);
});

test('review: failed clear preserves the encryption secret and recoverable committed data', async () => {
  const env = environment(); const expected = fixture(); const store = createStateStore(env.io);
  await store.saveState(expected);
  env.setHook((operation) => { if (operation === 'clearFiles') throw new Error('Disk deletion failed'); });
  await assert.rejects(store.deleteAllLocalData(), /Disk deletion failed/);
  assert.equal(env.hasSecret(), true);
  env.setHook(() => undefined);
  assert.deepEqual(await createStateStore(env.io).loadState(), expected);
});

test('review: interrupted streaming becomes ineligible and is committed on a no-UI-change save', async () => {
  const env = environment(); const interrupted = fixture();
  interrupted.conversations[0].messages[1].status = 'streaming';
  await createStateStore(env.io).saveState(interrupted);
  const old = await env.latest(); const restarted = createStateStore(env.io); const recovered = await restarted.loadState();
  assert.equal(recovered.conversations[0].messages[1].status, 'stopped');
  assert.equal(recovered.conversations[0].messages[1].contextEligible, false);
  assert.equal(recovered.conversations[0].messages[1].reasoning, '已保存的思考');
  await restarted.saveState(recovered);
  const current = await env.latest();
  assert.notEqual(current.manifest.conversations[0].recordFile, old.manifest.conversations[0].recordFile);
  assert.equal(current.manifest.conversations[0].originalFile, old.manifest.conversations[0].originalFile);
  const reference = current.manifest.conversations[0];
  const body = JSON.parse(await env.io.decrypt(env.files.get(reference.recordFile)!, `record:${reference.id}:${reference.recordFile}`));
  assert.equal(body.conversation.messages[1].status, 'stopped');
  assert.equal(body.conversation.messages[1].contextEligible, false);
});

test('review: migration and unrelated updates preserve all originalData and stable references', async () => {
  const env = environment(); const expected = fixture(); env.legacy(expected);
  const store = createStateStore(env.io); const migrated = await store.loadState(); await store.saveState(migrated);
  const before = await env.latest();
  const next = { ...migrated, conversations: [migrated.conversations[0], { ...migrated.conversations[1], title: '只改第二个' }] };
  await store.saveState(next);
  const after = await env.latest();
  assert.deepEqual(after.manifest.conversations[0], before.manifest.conversations[0]);
  assert.deepEqual((await createStateStore(env.io).loadState()).conversations[0], expected.conversations[0]);
});

test('review: orphan first-save files block automatic empty-state replacement', async () => {
  const env = environment(); env.files.set('record-1000-0.pending', new Uint8Array([1, 2]));
  const before = env.snapshot(); const store = createStateStore(env.io);
  await assert.rejects(store.loadState(), /中断的首次保存/);
  await assert.rejects(store.saveState(emptyState()), /中断的首次保存/);
  assert.deepEqual(env.snapshot(), before);
});
