import assert from 'node:assert/strict';
import test from 'node:test';
import { DeepSeekFileError, deleteDeepSeekFile, retrieveDeepSeekFile, uploadDeepSeekFile, type DeepSeekFileObject, type FilesFetchLike } from '../src/core/deepseek-files';

const file = new Blob(['document text'], { type: 'application/pdf' });
const value: DeepSeekFileObject = { id: 'file-api-test123', object: 'file', bytes: file.size,
  created_at: 1000, filename: '报告.pdf', purpose: 'text_recognition' };
const response = (input: unknown = value) => new Response(JSON.stringify(input), { headers: { 'Content-Type': 'application/json' } });

test('multipart uploads purpose before bytes and restricts the credentialed origin', async () => {
  let calls = 0;
  const fetchImpl: FilesFetchLike = async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.deepseek.com/files');
    assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit');
    assert.deepEqual(init?.headers, { Authorization: 'Bearer sk-test-only', Accept: 'application/json' });
    const form = init?.body as FormData;
    assert.deepEqual([...form.keys()], ['purpose', 'file']);
    assert.equal(form.get('purpose'), 'text_recognition');
    const uploaded = form.get('file') as File;
    assert.equal(uploaded.name, '报告.pdf'); assert.equal(await uploaded.text(), 'document text');
    return response();
  };
  assert.deepEqual(await uploadDeepSeekFile({ apiKey: ' sk-test-only ', file, fileName: '报告.pdf', purpose: 'text_recognition', fetchImpl }), value);
  assert.equal(calls, 1);
});

test('upload rejects unsupported purposes, format and size before a request', async () => {
  let calls = 0; const fetchImpl = async () => { calls++; return response(); };
  await assert.rejects(uploadDeepSeekFile({ apiKey: 'sk-test', file, fileName: 'report.pdf', purpose: 'user_data', fetchImpl }), /无法处理/);
  await assert.rejects(uploadDeepSeekFile({ apiKey: 'sk-test', file, fileName: 'payload.exe', purpose: 'user_data', fetchImpl }), /不支持/);
  await assert.rejects(uploadDeepSeekFile({ apiKey: 'sk-test', file: new Blob(), fileName: 'empty.txt', purpose: 'user_data', fetchImpl }), /为空/);
  assert.equal(calls, 0);
});

test('Expo native File adapter preserves original filename without an eager byte copy', async () => {
  const originalFormData = globalThis.FormData;
  class NativeFormData {
    parts: [string, unknown][] = [];
    append(name: string, part: unknown) { this.parts.push([name, part]); }
  }
  let reads = 0;
  const nativeFile = { name: 'random-cache.pdf', type: 'application/octet-stream', size: file.size,
    async bytes() { reads++; return new TextEncoder().encode('document text'); } } as unknown as Blob;
  try {
    globalThis.FormData = NativeFormData as unknown as typeof FormData;
    await uploadDeepSeekFile({ apiKey: 'sk-test', file: nativeFile, fileName: '报告.pdf', purpose: 'rich_layout_recognition',
      fetchImpl: async (_url, init) => {
        const parts = (init?.body as unknown as NativeFormData).parts;
        assert.equal(parts[0][0], 'purpose'); assert.equal(parts[0][1], 'rich_layout_recognition');
        const part = parts[1][1] as { name: string; type: string; bytes(): Promise<Uint8Array> };
        assert.equal(part.name, '报告.pdf'); assert.equal(part.type, 'application/pdf');
        assert.equal(reads, 0);
        assert.deepEqual(await part.bytes(), new TextEncoder().encode('document text'));
        return response({ ...value, purpose: 'rich_layout_recognition' });
      } });
    assert.equal(reads, 1);
  } finally { globalThis.FormData = originalFormData; }
});

test('server errors and transport failures are safe and never automatically retried', async () => {
  for (const [status, code] of [[400, 'invalid_file'], [401, 'auth'], [402, 'balance'], [403, 'forbidden'], [404, 'missing_file'], [408, 'timeout'], [413, 'too_large'], [429, 'rate_limit'], [503, 'server'], [504, 'timeout']] as const) {
    let calls = 0;
    await assert.rejects(uploadDeepSeekFile({ apiKey: 'sk-private-secret', file, fileName: 'report.pdf', purpose: 'text_recognition',
      fetchImpl: async () => { calls++; return new Response('sk-private-secret server-internal', { status }); } }), (error: unknown) => {
      assert.ok(error instanceof DeepSeekFileError); assert.equal(error.code, code);
      assert.ok(!error.message.includes('private-secret')); assert.ok(!error.message.includes('server-internal')); return true;
    });
    assert.equal(calls, 1);
  }
  await assert.rejects(uploadDeepSeekFile({ apiKey: 'sk-private-secret', file, fileName: 'report.pdf', purpose: 'text_recognition',
    fetchImpl: async () => { throw new Error('server-internal sk-private-secret'); } }), (error: unknown) => error instanceof DeepSeekFileError && error.code === 'network' && !error.message.includes('private-secret'));
});

test('redirected responses, malformed successful payloads and mismatched metadata fail closed', async () => {
  for (const source of [
    () => { const result = response(); Object.defineProperty(result, 'url', { value: 'https://untrusted.invalid/files' }); return result; },
    () => { const result = response(); Object.defineProperty(result, 'redirected', { value: true }); return result; },
    () => response({ ...value, id: 'https://untrusted.invalid' }),
    () => response({ ...value, purpose: 'user_data' }),
    () => response({ ...value, bytes: 999 }),
    () => new Response('{broken'),
  ]) await assert.rejects(uploadDeepSeekFile({ apiKey: 'sk-test', file, fileName: 'report.pdf', purpose: 'text_recognition', fetchImpl: async () => source() }), DeepSeekFileError);
});

test('retrieval and deletion validate IDs and remote identity without modifying other files', async () => {
  const calls: [string, string | undefined][] = [];
  const fetchImpl: FilesFetchLike = async (url, init) => {
    calls.push([url, init?.method]);
    return response(init?.method === 'DELETE' ? { id: value.id, object: 'file', deleted: true } : value);
  };
  const options = { apiKey: 'sk-test', fileId: value.id, fetchImpl };
  assert.deepEqual(await retrieveDeepSeekFile(options), value);
  await deleteDeepSeekFile(options);
  assert.deepEqual(calls, [[`https://api.deepseek.com/files/${value.id}`, 'GET'], [`https://api.deepseek.com/files/${value.id}`, 'DELETE']]);
  await assert.rejects(retrieveDeepSeekFile({ ...options, fileId: '../wrong' }), /无法处理/);
  await assert.rejects(retrieveDeepSeekFile({ ...options, fetchImpl: async () => response({ ...value, id: 'file-api-other' }) }), /格式异常/);
  await assert.rejects(deleteDeepSeekFile({ ...options, fetchImpl: async () => response({ id: value.id, object: 'file', deleted: false }) }), /格式异常/);
});

test('canceling or invalid credentials prevent requests and do not reveal raw errors', async () => {
  let calls = 0; const fetchImpl = async () => { calls++; return response(); };
  const controller = new AbortController(); controller.abort();
  await assert.rejects(uploadDeepSeekFile({ apiKey: 'sk-test', file, fileName: 'report.pdf', purpose: 'text_recognition', signal: controller.signal, fetchImpl }), (error: unknown) => error instanceof DeepSeekFileError && error.code === 'aborted');
  await assert.rejects(retrieveDeepSeekFile({ apiKey: 'bad key', fileId: value.id, fetchImpl }), /有效的 DeepSeek/);
  assert.equal(calls, 0);
});

test('a completed upload keeps its known ID when cancellation races with the response', async () => {
  const controller = new AbortController();
  const result = await uploadDeepSeekFile({ apiKey: 'sk-test', file, fileName: 'report.pdf', purpose: 'text_recognition',
    signal: controller.signal, fetchImpl: async () => { controller.abort(); return response(); } });
  assert.equal(result.id, value.id);
  assert.equal(controller.signal.aborted, true);
  await assert.rejects(retrieveDeepSeekFile({ apiKey: 'sk-test', fileId: result.id, signal: controller.signal,
    fetchImpl: async () => response() }), (error: unknown) => error instanceof DeepSeekFileError && error.code === 'aborted');
});
