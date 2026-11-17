/** Remote file references only: neither original bytes nor device paths belong in chat state. */
export type FilePurpose = 'user_data' | 'text_recognition' | 'rich_layout_recognition';

export interface MessageAttachment {
  id: string;
  name: string;
  mimeType: string;
  bytes: number;
  kind: 'image' | 'document';
  remote: {
    fileId: string;
    purpose: FilePurpose;
    /** Unix seconds, matching the official Files API. */
    createdAt: number;
    expiresAt?: number;
  };
}

export const ATTACHMENT_LIMITS = { perMessage: 4, fileBytes: 20 * 1024 * 1024, filenameBytes: 512 } as const;

const imageFormats: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
};
const parsedFormats: Record<string, string> = {
  pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const documentFormats: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  epub: 'application/epub+zip', mobi: 'application/x-mobipocket-ebook',
  log: 'text/plain', yaml: 'text/yaml', yml: 'text/yaml', xml: 'application/xml',
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', ts: 'text/plain',
  jsx: 'text/plain', tsx: 'text/plain', py: 'text/plain', java: 'text/plain', c: 'text/plain',
  cpp: 'text/plain', h: 'text/plain', sql: 'text/plain', ini: 'text/plain', conf: 'text/plain',
};
const purposes = new Set<FilePurpose>(['user_data', 'text_recognition', 'rich_layout_recognition']);
const encoder = new TextEncoder();

export function isFilePurpose(value: unknown): value is FilePurpose {
  return typeof value === 'string' && purposes.has(value as FilePurpose);
}

export function isDeepSeekFileId(value: unknown): value is string {
  return typeof value === 'string' && /^file-api-[A-Za-z0-9_-]{1,200}$/.test(value);
}

export function validateAttachmentName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !name.trim() || /[\x00-\x1f\x7f/\\]/.test(name)
    || encoder.encode(name).length > ATTACHMENT_LIMITS.filenameBytes) {
    throw new Error('附件文件名无效或过长，请重命名后重试。');
  }
}

/** The provider detects actual file content; this is an early format and size check for the picker. */
export function classifyAttachment(input: { name: string; mimeType?: string; bytes: number }): {
  kind: 'image' | 'document'; mimeType: string; purpose: FilePurpose;
} {
  validateAttachmentName(input.name);
  if (!Number.isSafeInteger(input.bytes) || input.bytes < 1) throw new Error('附件为空或大小无效。');
  if (input.bytes > ATTACHMENT_LIMITS.fileBytes) throw new Error('单个附件不能超过 20 MiB，请缩小文件后重试。');
  const extension = input.name.toLowerCase().split('.').at(-1) ?? '';
  if (Object.hasOwn(imageFormats, extension)) return { kind: 'image', mimeType: imageFormats[extension], purpose: 'user_data' };
  if (Object.hasOwn(parsedFormats, extension)) return { kind: 'document', mimeType: parsedFormats[extension], purpose: 'rich_layout_recognition' };
  if (Object.hasOwn(documentFormats, extension)) return { kind: 'document', mimeType: documentFormats[extension], purpose: 'user_data' };
  throw new Error('暂不支持该附件格式。请选择图片、PDF、Office、文本或电子书文件。');
}

/** Whitelist backup metadata; never restore a local URI, base64, arbitrary URL or credential. */
export function parseMessageAttachments(value: unknown): MessageAttachment[] {
  if (!Array.isArray(value) || value.length > ATTACHMENT_LIMITS.perMessage) throw new Error('附件数量无效，每条消息最多 4 个附件。');
  const ids = new Set<string>();
  return value.map((input): MessageAttachment => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('附件元数据无效。');
    const item = input as Record<string, unknown>;
    validateAttachmentName(item.name);
    if (typeof item.id !== 'string' || !item.id.trim() || item.id.length > 500 || ids.has(item.id)
      || typeof item.mimeType !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(item.mimeType)
      || item.mimeType.length > 200 || typeof item.bytes !== 'number') throw new Error('附件元数据无效。');
    const format = classifyAttachment({ name: item.name, bytes: item.bytes });
    if (item.kind !== format.kind || item.mimeType !== format.mimeType
      || !item.remote || typeof item.remote !== 'object' || Array.isArray(item.remote)) throw new Error('附件类型或远端引用无效。');
    const remote = item.remote as Record<string, unknown>;
    if (!isDeepSeekFileId(remote.fileId) || !isFilePurpose(remote.purpose)
      || (format.purpose === 'user_data' ? remote.purpose !== 'user_data' : remote.purpose === 'user_data')
      || !Number.isSafeInteger(remote.createdAt) || Number(remote.createdAt) < 0
      || (remote.expiresAt !== undefined && (!Number.isSafeInteger(remote.expiresAt)
        || Number(remote.expiresAt) <= Number(remote.createdAt)))) throw new Error('附件远端引用无效。');
    ids.add(item.id);
    return { id: item.id, name: item.name, mimeType: item.mimeType, bytes: item.bytes, kind: format.kind,
      remote: { fileId: remote.fileId, purpose: remote.purpose, createdAt: remote.createdAt as number,
        ...(remote.expiresAt === undefined ? {} : { expiresAt: remote.expiresAt as number }) } };
  });
}
