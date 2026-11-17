import {
  classifyAttachment, isDeepSeekFileId, isFilePurpose, type FilePurpose,
} from './attachments';

const API_ORIGIN = 'https://api.deepseek.com';
export type FilesFetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface DeepSeekFileObject {
  id: string;
  object: 'file';
  bytes: number;
  created_at: number;
  filename: string;
  purpose: FilePurpose;
  expires_at?: number;
}

export type DeepSeekFileErrorCode = 'missing_key' | 'invalid_file' | 'auth' | 'forbidden' | 'missing_file'
  | 'balance' | 'rate_limit' | 'too_large' | 'timeout' | 'server' | 'network' | 'aborted' | 'redirect' | 'protocol';
const messages: Record<DeepSeekFileErrorCode, string> = {
  missing_key: '请先连接有效的 DeepSeek API Key。',
  invalid_file: '附件无法处理，请检查文件格式、是否加密及解析方式。',
  auth: 'API Key 无效或已失效，请重新连接。',
  forbidden: '当前 API 账户无法访问这个附件，请使用原账户或重新上传。',
  missing_file: '附件已删除、已过期或不属于当前账户，请重新选择原文件。',
  balance: 'DeepSeek API 余额不足，无法解析附件。',
  rate_limit: '附件请求过于频繁，请稍后重试。',
  too_large: '附件超过服务方大小限制，请缩小文件后重试。',
  timeout: '附件上传或解析超时。服务方可能仍在处理，请勿立即重复上传。',
  server: 'DeepSeek 附件服务暂时繁忙。若已开始解析，服务方可能仍在处理，请勿立即重复上传。',
  network: '附件连接中断。服务方可能仍在处理，请勿立即重复上传。',
  aborted: '已取消等待附件上传。已提交的解析可能仍会完成并计费。',
  redirect: '已阻止附件请求的异常跳转。',
  protocol: '附件服务返回格式异常。若已上传成功，请勿立即重复上传。',
};

/** Never expose request credentials, response bodies, original exceptions or upload URLs. */
export class DeepSeekFileError extends Error {
  constructor(readonly code: DeepSeekFileErrorCode, readonly status?: number) {
    super(messages[code]);
    this.name = code === 'aborted' ? 'AbortError' : 'DeepSeekFileError';
  }
}

interface FileRequestOptions {
  apiKey: string;
  signal?: AbortSignal;
  fetchImpl?: FilesFetchLike;
}
export interface UploadDeepSeekFileOptions extends FileRequestOptions {
  file: Blob;
  fileName: string;
  purpose: FilePurpose;
}
export interface ReferencedFileOptions extends FileRequestOptions { fileId: string }

function checkSignal(signal?: AbortSignal) {
  if (signal?.aborted) throw new DeepSeekFileError('aborted');
}

function statusError(status: number): DeepSeekFileError {
  const code: DeepSeekFileErrorCode = status >= 300 && status < 400 ? 'redirect'
    : status === 401 ? 'auth' : status === 402 ? 'balance' : status === 403 ? 'forbidden'
      : status === 404 ? 'missing_file' : status === 408 || status === 504 ? 'timeout'
        : status === 413 ? 'too_large' : status === 429 ? 'rate_limit'
          : status >= 500 ? 'server' : 'invalid_file';
  return new DeepSeekFileError(code, status);
}

async function request(path: string, method: 'POST' | 'GET' | 'DELETE', options: FileRequestOptions,
  body?: FormData, keepCompletedUpload = false): Promise<unknown> {
  checkSignal(options.signal);
  const apiKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : '';
  if (!apiKey || apiKey.length > 1024 || /[\s\x00-\x1f\x7f]/.test(apiKey)) throw new DeepSeekFileError('missing_key');
  try {
    const response = await (options.fetchImpl ?? globalThis.fetch)(`${API_ORIGIN}${path}`, {
      method, body, signal: options.signal, redirect: 'error', credentials: 'omit',
      // The multipart encoder owns Content-Type and its boundary.
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });
    if (!keepCompletedUpload) checkSignal(options.signal);
    if (response.redirected) throw new DeepSeekFileError('redirect');
    if (response.url) {
      let origin: string;
      try { origin = new URL(response.url).origin; } catch { throw new DeepSeekFileError('protocol'); }
      if (origin !== API_ORIGIN) throw new DeepSeekFileError('redirect');
    }
    if (!response.ok) throw statusError(response.status);
    const text = await response.text();
    if (!keepCompletedUpload) checkSignal(options.signal);
    if (text.length > 64 * 1024) throw new DeepSeekFileError('protocol');
    try { return JSON.parse(text); } catch { throw new DeepSeekFileError('protocol'); }
  } catch (error) {
    if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw new DeepSeekFileError('aborted');
    if (error instanceof DeepSeekFileError) throw error;
    throw new DeepSeekFileError('network');
  }
}

function parseFileObject(value: unknown): DeepSeekFileObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DeepSeekFileError('protocol');
  const item = value as Record<string, unknown>;
  if (!isDeepSeekFileId(item.id) || item.object !== 'file' || !isFilePurpose(item.purpose)
    || !Number.isSafeInteger(item.bytes) || Number(item.bytes) < 0
    || !Number.isSafeInteger(item.created_at) || Number(item.created_at) < 0
    || typeof item.filename !== 'string' || !item.filename || item.filename.length > 2048
    || (item.expires_at !== undefined && (!Number.isSafeInteger(item.expires_at)
      || Number(item.expires_at) <= Number(item.created_at)))) throw new DeepSeekFileError('protocol');
  return { id: item.id, object: 'file', bytes: item.bytes as number, created_at: item.created_at as number,
    filename: item.filename, purpose: item.purpose,
    ...(item.expires_at === undefined ? {} : { expires_at: item.expires_at as number }) };
}

/**
 * Upload exactly once. A disconnect may still leave a successfully parsed and billed remote file.
 * Preserve an already received valid file ID even if the caller canceled in the same instant;
 * callers must check their signal before submitting chat, and may retain this ID for later reuse.
 */
export async function uploadDeepSeekFile(options: UploadDeepSeekFileOptions): Promise<DeepSeekFileObject> {
  checkSignal(options.signal);
  const format = classifyAttachment({ name: options.fileName, mimeType: options.file.type, bytes: options.file.size });
  if (!isFilePurpose(options.purpose)
    || (format.purpose === 'user_data' ? options.purpose !== 'user_data' : options.purpose === 'user_data')) {
    throw new DeepSeekFileError('invalid_file');
  }
  const form = new FormData();
  // DeepSeek requires purpose before file for document parsing.
  form.append('purpose', options.purpose);
  let uploadPart = options.file;
  const nativeCandidate: unknown = options.file;
  if (nativeCandidate !== null && typeof nativeCandidate === 'object' && !(nativeCandidate instanceof Blob)
    && 'bytes' in nativeCandidate && typeof nativeCandidate.bytes === 'function') {
    // Expo File implements Blob without extending it. Expo's FormData ignores the filename
    // argument for that case, so preserve the user's original name with its supported bytes
    // adapter instead of uploading the DocumentPicker cache's random basename.
    const nativeFile = options.file as Blob & { bytes(): Promise<Uint8Array> };
    uploadPart = { name: options.fileName, type: format.mimeType, size: nativeFile.size,
      bytes: () => nativeFile.bytes() } as unknown as Blob;
  }
  form.append('file', uploadPart, options.fileName);
  // Omit expires_after: the official default is permanent storage in the user's own account.
  const result = parseFileObject(await request('/files', 'POST', options, form, true));
  if (result.purpose !== options.purpose || result.bytes !== options.file.size) throw new DeepSeekFileError('protocol');
  return result;
}

export async function retrieveDeepSeekFile(options: ReferencedFileOptions): Promise<DeepSeekFileObject> {
  if (!isDeepSeekFileId(options.fileId)) throw new DeepSeekFileError('invalid_file');
  const result = parseFileObject(await request(`/files/${options.fileId}`, 'GET', options));
  if (result.id !== options.fileId) throw new DeepSeekFileError('protocol');
  return result;
}

export async function deleteDeepSeekFile(options: ReferencedFileOptions): Promise<void> {
  if (!isDeepSeekFileId(options.fileId)) throw new DeepSeekFileError('invalid_file');
  const result = await request(`/files/${options.fileId}`, 'DELETE', options);
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new DeepSeekFileError('protocol');
  const item = result as Record<string, unknown>;
  if (item.id !== options.fileId || item.object !== 'file' || item.deleted !== true) throw new DeepSeekFileError('protocol');
}
