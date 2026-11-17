import { AESEncryptionKey, AESSealedData, aesDecryptAsync, aesEncryptAsync } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { decodeLegacyHex, LEGACY_ASSOCIATED_DATA, MAX_RECORD_BYTES, parseLegacyEnvelope } from '../core/encryption-format';

export const MASTER_KEY_ID = 'shiyu.local-state.key.v1';
export const KEY_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainService: 'shiyu.local.secrets',
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const yieldControl = () => new Promise<void>(resolve => setTimeout(resolve, 0));
let nativeKey: AESEncryptionKey | null = null;

export function forgetNativeStorageKey() { nativeKey = null; }

async function getKey(create: boolean): Promise<AESEncryptionKey> {
  if (nativeKey) return nativeKey;
  const encoded = await SecureStore.getItemAsync(MASTER_KEY_ID, KEY_OPTIONS);
  if (encoded !== null) {
    if (!/^[0-9a-f]{64}$/i.test(encoded)) throw new Error('设备中的本地加密密钥无效，聊天文件已保留。');
    nativeKey = await AESEncryptionKey.import(encoded, 'hex');
    return nativeKey;
  }
  if (!create) throw new Error('找不到本机加密密钥，无法读取历史。聊天文件已保留。');
  const generated = await AESEncryptionKey.generate();
  await SecureStore.setItemAsync(MASTER_KEY_ID, await generated.encoded('hex'), KEY_OPTIONS);
  nativeKey = generated;
  return nativeKey;
}

function additionalData(context: string) { return encoder.encode(`shiyu-chat/local-state/v2:${context}`); }

export async function encryptNative(plaintext: string, context: string): Promise<Uint8Array> {
  const bytes = encoder.encode(plaintext);
  if (bytes.length > MAX_RECORD_BYTES) throw new Error('单个会话或原始资料过大，原记录未修改。');
  try {
    const sealed = await aesEncryptAsync(bytes, await getKey(true), {
      additionalData: additionalData(context), nonce: { length: 12 }, tagLength: 16,
    });
    return await sealed.combined('bytes');
  } finally { bytes.fill(0); }
}

export async function decryptNative(ciphertext: Uint8Array, context: string): Promise<string> {
  if (ciphertext.length < 28 || ciphertext.length > MAX_RECORD_BYTES + 28) throw new Error('本地记录长度异常，原文件已保留。');
  const key = await getKey(false);
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = await aesDecryptAsync(AESSealedData.fromCombined(ciphertext, { ivLength: 12, tagLength: 16 }), key,
      { additionalData: additionalData(context) });
    return decoder.decode(plaintext);
  } catch { throw new Error('本地记录解密失败，原文件已保留。'); }
  finally { plaintext?.fill(0); }
}

export async function decryptLegacyNative(ciphertext: Uint8Array): Promise<string> {
  const envelope = parseLegacyEnvelope(decoder.decode(ciphertext));
  const key = await getKey(false);
  let plaintext: Uint8Array | undefined;
  try {
    const iv = await decodeLegacyHex(envelope.nonce, yieldControl);
    const encrypted = await decodeLegacyHex(envelope.ciphertext, yieldControl);
    const sealed = AESSealedData.fromParts(iv, encrypted, 16);
    plaintext = await aesDecryptAsync(sealed, key, { additionalData: encoder.encode(LEGACY_ASSOCIATED_DATA) });
    return decoder.decode(plaintext);
  } catch { throw new Error('旧版本地记录解密失败，原文件已保留。'); }
  finally { plaintext?.fill(0); }
}
