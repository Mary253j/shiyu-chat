import type { DocumentPickerAsset } from 'expo-document-picker';
import { File, FileMode } from 'expo-file-system';
import { checkHistoryInputSize } from '../core/history-limits';

const MAX_READ_BYTES = 64 * 1024;

export type HistoryFileAsset = Pick<DocumentPickerAsset, 'uri' | 'size' | 'file'>;

export interface OpenHistoryFile {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
  /** Waits for in-flight reads before closing; cleanup must not hide an import error. */
  close(): Promise<void>;
}

/** A bounded random-access reader; never calls File.bytes() on the whole archive. */
export function openHistoryFile(asset: HistoryFileAsset): OpenHistoryFile {
  const handle = new File(asset.uri).open(FileMode.ReadOnly);
  let size: number;
  try {
    const actualSize = handle.size;
    if (actualSize === null) throw new Error('无法导入：文件已关闭，请重新选择。');
    checkHistoryInputSize(actualSize);
    if (asset.size !== undefined) {
      checkHistoryInputSize(asset.size);
      if (asset.size !== actualSize) throw new Error('无法导入：文件大小已变化，请重新选择。');
    }
    size = actualSize;
  } catch (error) {
    try { handle.close(); } catch { /* Keep the metadata error, not a cleanup error. */ }
    throw error;
  }

  // Expo documents that async operations on one FileHandle need explicit
  // ordering. Serialize seeking and reading together so concurrent callers
  // cannot move the offset underneath an in-flight read.
  let queue: Promise<void> = Promise.resolve();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  return {
    size,
    async read(offset, length) {
      if (closing) throw new Error('无法导入：文件已关闭，请重新选择。');
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
        || offset < 0 || length < 0 || length > MAX_READ_BYTES || offset + length > size) {
        throw new Error('无法导入：文件读取范围无效。');
      }
      const operation = queue.then(async () => {
        if (!length) return new Uint8Array();
        handle.offset = offset;
        // SDK 58 readBytes is asynchronous (Android Dispatchers.IO). Its
        // native allocation stays at one small chunk rather than file size.
        const bytes = await handle.readBytes(length);
        if (bytes.length !== length) throw new Error('无法导入：文件内容已截断或变化，请重新选择。');
        return bytes;
      });
      queue = operation.then(() => undefined, () => undefined);
      return operation;
    },
    close() {
      closing = true;
      closePromise ??= queue.then(() => {
        try { handle.close(); } catch { /* Best effort; preserve the primary import result. */ }
      });
      return closePromise;
    },
  };
}
