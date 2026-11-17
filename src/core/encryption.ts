import { gcm } from '@noble/ciphers/aes.js';
import { bytesToHex, hexToBytes, utf8ToBytes, bytesToUtf8 } from '@noble/ciphers/utils.js';

const ASSOCIATED_DATA = utf8ToBytes('shiyu-chat/local-state/AES-256-GCM/v1');
export const MAX_PLAINTEXT_BYTES = 64 * 1024 * 1024;
export const MAX_ENVELOPE_CHARACTERS = MAX_PLAINTEXT_BYTES * 2 + 512;

interface EncryptedEnvelope {
  version: 1;
  algorithm: 'AES-256-GCM';
  nonce: string;
  ciphertext: string;
}

function checkKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.length !== 32) {
    throw new Error('本地加密密钥无效。');
  }
}

/** The caller supplies a fresh, cryptographically random 12-byte nonce per write. */
export function encryptPayload(plaintext: string, key: Uint8Array, nonce: Uint8Array): string {
  checkKey(key);
  if (!(nonce instanceof Uint8Array) || nonce.length !== 12) {
    throw new Error('本地加密随机数无效。');
  }
  const bytes = utf8ToBytes(plaintext);
  if (bytes.length > MAX_PLAINTEXT_BYTES) {
    throw new Error('本地记录超过 64 MB，请先导出并整理部分会话。');
  }
  const encrypted = gcm(key, nonce, ASSOCIATED_DATA).encrypt(bytes);
  const envelope: EncryptedEnvelope = {
    version: 1,
    algorithm: 'AES-256-GCM',
    nonce: bytesToHex(nonce),
    ciphertext: bytesToHex(encrypted),
  };
  bytes.fill(0);
  return JSON.stringify(envelope);
}

export function decryptPayload(serialized: string, key: Uint8Array): string {
  checkKey(key);
  if (serialized.length > MAX_ENVELOPE_CHARACTERS) {
    throw new Error('本地记录文件过大，已停止读取以保护设备。');
  }
  let data: unknown;
  try {
    data = JSON.parse(serialized);
  } catch {
    throw new Error('本地记录文件不完整，原文件已保留。');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('本地记录文件格式无效，原文件已保留。');
  }
  const value = data as Partial<EncryptedEnvelope>;
  if (value.version !== 1 || value.algorithm !== 'AES-256-GCM'
    || typeof value.nonce !== 'string' || !/^[0-9a-f]{24}$/i.test(value.nonce)
    || typeof value.ciphertext !== 'string' || value.ciphertext.length < 32
    || value.ciphertext.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value.ciphertext)) {
    throw new Error('本地记录版本或加密格式无效，原文件已保留。');
  }
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = gcm(key, hexToBytes(value.nonce), ASSOCIATED_DATA)
      .decrypt(hexToBytes(value.ciphertext));
    return bytesToUtf8(plaintext);
  } catch {
    throw new Error('本地记录解密失败，可能已损坏或设备密钥不可用。原文件已保留。');
  } finally {
    plaintext?.fill(0);
  }
}
