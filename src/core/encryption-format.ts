import { HISTORY_FILE_LIMIT_BYTES } from './history-limits';

/** Exact v0.1.1 format constants; changing its AAD would make existing installations unreadable. */
export const LEGACY_ASSOCIATED_DATA = 'shiyu-chat/local-state/AES-256-GCM/v1';
export const MAX_PLAINTEXT_BYTES = 64 * 1024 * 1024;
export const MAX_ENVELOPE_CHARACTERS = MAX_PLAINTEXT_BYTES * 2 + 512;
/** A v2 conversation/original blob may fill the history limit, plus its storage wrapper. */
export const MAX_RECORD_BYTES = HISTORY_FILE_LIMIT_BYTES + 1024 * 1024;

export function parseLegacyEnvelope(serialized: string): { nonce: string; ciphertext: string } {
  if (serialized.length > MAX_ENVELOPE_CHARACTERS) throw new Error('本地记录文件过大，原文件已保留。');
  let data: unknown;
  try { data = JSON.parse(serialized); }
  catch { throw new Error('本地记录文件不完整，原文件已保留。'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('本地记录格式无效，原文件已保留。');
  const value = data as Record<string, unknown>;
  if (value.version !== 1 || value.algorithm !== 'AES-256-GCM'
    || typeof value.nonce !== 'string' || !/^[0-9a-f]{24}$/i.test(value.nonce)
    || typeof value.ciphertext !== 'string' || value.ciphertext.length < 32
    || value.ciphertext.length % 2 !== 0) throw new Error('本地记录版本或加密格式无效，原文件已保留。');
  return { nonce: value.nonce, ciphertext: value.ciphertext };
}

/** Chunked only for the one-time legacy hex migration, so decoding can yield to touch events. */
export async function decodeLegacyHex(hex: string, yieldControl: () => Promise<void>): Promise<Uint8Array> {
  if (hex.length % 2 !== 0 || hex.length > MAX_ENVELOPE_CHARACTERS) throw new Error('旧版密文格式无效。');
  const output = new Uint8Array(hex.length / 2);
  const chunkLength = 512 * 1024;
  for (let offset = 0; offset < hex.length; offset += chunkLength) {
    const chunk = hex.slice(offset, offset + chunkLength);
    if (!/^[0-9a-f]+$/i.test(chunk)) throw new Error('旧版密文格式无效，原文件已保留。');
    for (let index = 0; index < chunk.length; index += 2) {
      output[(offset + index) / 2] = Number.parseInt(chunk.slice(index, index + 2), 16);
    }
    if (offset + chunkLength < hex.length) await yieldControl();
  }
  return output;
}
