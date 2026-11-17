import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { decryptPayload, encryptPayload } from '../src/core/encryption';

test('AES-256-GCM round trip preserves Chinese, emoji and conversation metadata', () => {
  const key = new Uint8Array(randomBytes(32));
  const nonce = new Uint8Array(randomBytes(12));
  const data = JSON.stringify({ text: '记得这段对话 🍗\n第二行', history: [1, 2, null] });
  const encrypted = encryptPayload(data, key, nonce);
  assert.equal(decryptPayload(encrypted, key), data);
  assert.ok(!encrypted.includes('记得'));
});

test('fresh nonces produce different ciphertext for an identical state', () => {
  const key = new Uint8Array(randomBytes(32));
  const first = encryptPayload('same message', key, new Uint8Array(randomBytes(12)));
  const second = encryptPayload('same message', key, new Uint8Array(randomBytes(12)));
  assert.notEqual(first, second);
  assert.equal(decryptPayload(first, key), decryptPayload(second, key));
});

test('wrong key never yields plaintext', () => {
  const encrypted = encryptPayload('secret', new Uint8Array(randomBytes(32)), new Uint8Array(randomBytes(12)));
  assert.throws(() => decryptPayload(encrypted, new Uint8Array(randomBytes(32))), /解密失败/);
});

test('modified ciphertext is rejected and does not appear in errors', () => {
  const key = new Uint8Array(randomBytes(32));
  const envelope = JSON.parse(encryptPayload('do not expose me', key, new Uint8Array(randomBytes(12))));
  envelope.ciphertext = (envelope.ciphertext[0] === '0' ? '1' : '0') + envelope.ciphertext.slice(1);
  assert.throws(() => decryptPayload(JSON.stringify(envelope), key), /解密失败/);
});

test('nonce tampering is rejected', () => {
  const key = new Uint8Array(randomBytes(32));
  const envelope = JSON.parse(encryptPayload('private', key, new Uint8Array(randomBytes(12))));
  envelope.nonce = '00'.repeat(12);
  assert.throws(() => decryptPayload(JSON.stringify(envelope), key), /解密失败/);
});

test('malformed, truncated, future-version or invalid envelopes cannot be decrypted', () => {
  const key = new Uint8Array(randomBytes(32));
  const envelope = JSON.parse(encryptPayload('private', key, new Uint8Array(randomBytes(12))));
  for (const data of ['{', '{}', 'null', '[]', JSON.stringify({ ...envelope, version: 2 }),
    JSON.stringify({ ...envelope, ciphertext: '00' }), JSON.stringify({ ...envelope, nonce: 'x'.repeat(24) })]) {
    assert.throws(() => decryptPayload(data, key));
  }
});

test('only 32-byte keys and 12-byte nonces are accepted', () => {
  assert.throws(() => encryptPayload('test', new Uint8Array(16), new Uint8Array(12)), /密钥/);
  assert.throws(() => encryptPayload('test', new Uint8Array(32), new Uint8Array(16)), /随机数/);
});
