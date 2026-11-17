import type { DocumentPickerAsset } from 'expo-document-picker';
import { checkHistoryInputSize } from '../core/history-limits';

const MAX_READ_BYTES = 64 * 1024;

export type HistoryFileAsset = Pick<DocumentPickerAsset, 'uri' | 'size' | 'file'>;

export interface OpenHistoryFile {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** Read only the requested Blob slice; never allocate an archive-sized buffer. */
export function openHistoryFile(asset: HistoryFileAsset): OpenHistoryFile {
  const file = asset.file;
  if (!file) throw new Error('无法导入：浏览器未提供可读取的文件，请重新选择。');
  checkHistoryInputSize(file.size);
  if (asset.size !== undefined) {
    checkHistoryInputSize(asset.size);
    if (asset.size !== file.size) throw new Error('无法导入：文件大小已变化，请重新选择。');
  }
  const size = file.size;
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
        const bytes = new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
        if (bytes.length !== length) throw new Error('无法导入：文件内容已截断或变化，请重新选择。');
        return bytes;
      });
      queue = operation.then(() => undefined, () => undefined);
      return operation;
    },
    close() {
      closing = true;
      closePromise ??= queue;
      return closePromise;
    },
  };
}
