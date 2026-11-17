/** One capacity setting for history import, expanded ZIP data and restorable backups. */
export const HISTORY_FILE_LIMIT_BYTES = 1024 * 1024 * 1024;
export const HISTORY_FILE_LIMIT_LABEL = '1 GB';

/** Checks metadata before reading/allocating the file; does not reserve memory. */
export function checkHistoryInputSize(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('无法导入：文件大小无效。');
  if (bytes > HISTORY_FILE_LIMIT_BYTES) throw new Error(`无法导入：文件超过 ${HISTORY_FILE_LIMIT_LABEL}，请分批导入。`);
}
