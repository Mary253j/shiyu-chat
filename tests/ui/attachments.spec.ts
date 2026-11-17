import { expect, test, type Page } from '@playwright/test';

const API = 'https://api.deepseek.com';
const DRAFT_ATTACHMENTS = '[data-testid^="draft-attachment-"]';
const SENT_ATTACHMENTS = '[data-testid^="message-attachment-"]';
const IMAGE_NAME = 'attachment-fixture.png';
const IMAGE_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6N8AAAAASUVORK5CYII=',
  'base64',
);
const DOCUMENT_NAME = 'note.txt';
const DOCUMENT_BYTES = Buffer.from('attachment-fixture-only\n这份文件仅供自动化测试。\n');

interface ChatMessage {
  role: string;
  content: unknown;
}
interface ChatRequest {
  model: string;
  messages: ChatMessage[];
}

async function navigate(page: Page, label: string) {
  await page.getByRole('tab', { name: label, exact: true })
    .or(page.getByRole('button', { name: label, exact: true })).first().click();
}

async function connect(page: Page) {
  await page.route(`${API}/user/balance`, route => route.fulfill({ json: {
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '12.34' }],
  } }));
  await navigate(page, '连接与设置');
  await page.getByLabel('API Key', { exact: true }).fill('test-only-fake-api-key');
  await page.getByRole('button', { name: '验证并安全保存', exact: true }).click();
  await expect(page.getByText('连接成功，可以开始聊天了。', { exact: true })).toBeVisible();
}

async function pickAttachment(page: Page, kind: 'image' | 'document') {
  const picker = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: kind === 'image' ? '添加图片' : '添加文件', exact: true }).click();
  await (await picker).setFiles(kind === 'image'
    ? { name: IMAGE_NAME, mimeType: 'image/png', buffer: IMAGE_BYTES }
    : { name: DOCUMENT_NAME, mimeType: 'text/plain', buffer: DOCUMENT_BYTES });
}

function uploadResponse(id: string, kind: 'image' | 'document') {
  return {
    id,
    object: 'file',
    bytes: kind === 'image' ? IMAGE_BYTES.length : DOCUMENT_BYTES.length,
    created_at: 1_790_000_000,
    filename: kind === 'image' ? IMAGE_NAME : DOCUMENT_NAME,
    purpose: 'user_data',
  };
}

function fileReferences(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(fileReferences);
  if (!value || typeof value !== 'object') return [];
  const object = value as Record<string, unknown>;
  return [
    ...(typeof object.file_id === 'string' ? [object.file_id] : []),
    ...Object.values(object).flatMap(fileReferences),
  ];
}

async function mockChat(page: Page, bodies: ChatRequest[], reply: (index: number) => string) {
  await page.route(`${API}/chat/completions`, async route => {
    bodies.push(route.request().postDataJSON() as ChatRequest);
    const frames = [
      { choices: [{ index: 0, delta: { content: reply(bodies.length) }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 80, completion_tokens: 12, total_tokens: 92 } },
    ];
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n',
    });
  });
}

test.beforeEach(async ({ page }) => {
  // Unmatched uploads and completions are blocked: no real key or paid API request.
  await page.route(`${API}/**`, route => route.abort());
});

test('attachment-only image survives an upload failure and can be sent again', async ({ page }) => {
  test.setTimeout(45000);
  const chatBodies: ChatRequest[] = [];
  const uploadedBodies: Buffer[] = [];
  const uploadedContentTypes: string[] = [];
  const fileId = 'file-api-ui-test-image-1';
  await page.route(`${API}/files`, async route => {
    const request = route.request();
    uploadedBodies.push(request.postDataBuffer() ?? Buffer.alloc(0));
    uploadedContentTypes.push(request.headers()['content-type'] ?? '');
    if (uploadedBodies.length === 1) {
      await route.fulfill({ status: 503, json: { error: { message: 'mock upload unavailable' } } });
    } else {
      await route.fulfill({ json: uploadResponse(fileId, 'image') });
    }
  });
  await mockChat(page, chatBodies, () => '图片已经收到，可以继续聊了。');
  await page.goto('/');
  await connect(page);
  await navigate(page, '聊一会儿');
  await pickAttachment(page, 'image');
  const drafts = page.locator(DRAFT_ATTACHMENTS);
  await expect(drafts).toHaveCount(1);
  await expect(drafts.first()).toContainText(IMAGE_NAME);
  const draftTestId = await drafts.first().getAttribute('data-testid');
  expect(draftTestId).toBeTruthy();
  await expect(page.getByLabel('输入消息', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => uploadedBodies.length).toBe(1);
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  await expect(page.getByTestId(draftTestId!)).toBeVisible();
  await expect(page.locator(SENT_ATTACHMENTS)).toHaveCount(0);
  expect(chatBodies).toHaveLength(0);

  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('图片已经收到，可以继续聊了。', { exact: true })).toBeVisible();
  expect(uploadedBodies).toHaveLength(2);
  expect(uploadedContentTypes.every(value => /^multipart\/form-data;\s*boundary=/i.test(value))).toBe(true);
  for (const body of uploadedBodies) {
    expect(body.toString('utf8')).toContain(`filename="${IMAGE_NAME}"`);
    expect(body.includes(IMAGE_BYTES)).toBe(true);
  }
  expect(chatBodies).toHaveLength(1);
  expect(chatBodies[0].model).toBe('deepseek-flash');
  expect(chatBodies[0].messages.at(-1)?.role).toBe('user');
  expect(fileReferences(chatBodies[0].messages.at(-1)?.content)).toContain(fileId);
  await expect(drafts).toHaveCount(0);
  await expect(page.locator(SENT_ATTACHMENTS)).toHaveCount(1);
  await expect(page.locator(SENT_ATTACHMENTS).first()).toContainText(IMAGE_NAME);
});

test('Pro attachment flow asks for an explicit Flash switch and allows removing a file', async ({ page }) => {
  test.setTimeout(45000);
  const chatBodies: ChatRequest[] = [];
  const uploadedBodies: Buffer[] = [];
  const fileId = 'file-api-ui-test-document-1';
  await page.route(`${API}/files`, async route => {
    uploadedBodies.push(route.request().postDataBuffer() ?? Buffer.alloc(0));
    if (uploadedBodies.length === 1) await route.fulfill({ status: 503, json: { error: { message: 'mock upload unavailable' } } });
    else await route.fulfill({ json: uploadResponse(fileId, 'document') });
  });
  await mockChat(page, chatBodies, () => '文件已经收到，下面一起看看。');
  await page.goto('/');
  await connect(page);
  await page.getByRole('button', { name: '使用 Pro 模型', exact: true }).click();
  await navigate(page, '聊一会儿');
  await page.getByLabel('输入消息', { exact: true }).fill('请概括这个附件。');
  await pickAttachment(page, 'document');
  await expect(page.locator(DRAFT_ATTACHMENTS)).toHaveCount(1);
  await expect(page.getByRole('button', { name: '切换到 Flash', exact: true })).toBeVisible();
  expect(uploadedBodies).toHaveLength(0);
  expect(chatBodies).toHaveLength(0);

  await page.getByRole('button', { name: `移除附件 ${DOCUMENT_NAME}`, exact: true }).click();
  await expect(page.locator(DRAFT_ATTACHMENTS)).toHaveCount(0);
  await expect(page.getByLabel('输入消息', { exact: true })).toHaveValue('请概括这个附件。');
  await pickAttachment(page, 'document');
  await page.getByRole('button', { name: '切换到 Flash', exact: true }).click();
  await expect(page.getByRole('button', { name: '切换到 Flash', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => uploadedBodies.length).toBe(1);
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  await expect(page.getByLabel('输入消息', { exact: true })).toHaveValue('请概括这个附件。');
  await expect(page.locator(DRAFT_ATTACHMENTS)).toHaveCount(1);
  expect(chatBodies).toHaveLength(0);
  await navigate(page, '连接与设置');
  await navigate(page, '聊一会儿');
  await expect(page.getByLabel('输入消息', { exact: true })).toHaveValue('请概括这个附件。');
  await expect(page.locator(DRAFT_ATTACHMENTS)).toHaveCount(1);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('文件已经收到，下面一起看看。', { exact: true })).toBeVisible();
  expect(uploadedBodies).toHaveLength(2);
  expect(uploadedBodies[0].toString('utf8')).toContain(`filename="${DOCUMENT_NAME}"`);
  expect(uploadedBodies[0].includes(DOCUMENT_BYTES)).toBe(true);
  expect(chatBodies).toHaveLength(1);
  expect(chatBodies[0].model).toBe('deepseek-flash');
  expect(fileReferences(chatBodies[0].messages.at(-1)?.content)).toContain(fileId);
  expect(JSON.stringify(chatBodies[0].messages.at(-1)?.content)).toContain('请概括这个附件。');
  await expect(page.locator(DRAFT_ATTACHMENTS)).toHaveCount(0);
  await expect(page.locator(SENT_ATTACHMENTS)).toHaveCount(1);
  await expect(page.locator(SENT_ATTACHMENTS).first()).toContainText(DOCUMENT_NAME);
  await expect(page.getByLabel('输入消息', { exact: true })).toHaveValue('');
});

test('automatic context carries more than forty history messages and reports explicit recent limits', async ({ page }) => {
  test.setTimeout(45000);
  const title = '附件回归：上下文说明';
  const history = Array.from({ length: 60 }, (_, index) => ({
    id: `context-history-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `用于上下文回归的第 ${index} 条历史。`,
    createdAt: index + 1,
    status: 'complete',
  }));
  const fixture = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    conversations: [{ id: 'context-ui-test', title, createdAt: 1, updatedAt: 60, messages: history }],
  }));
  const bodies: ChatRequest[] = [];
  await mockChat(page, bodies, index => `上下文测试回复 ${index}。`);
  await page.goto('/');
  await connect(page);
  await expect(page.getByRole('button', { name: '自动携带上下文', exact: true })).toBeVisible();
  // Do not select the automatic mode here: this checks its initial default.
  await navigate(page, '我的对话');
  const picker = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '导入旧对话', exact: true }).click();
  await (await picker).setFiles({ name: 'context-history.json', mimeType: 'application/json', buffer: fixture });
  await expect(page.getByText('先看看，要带回哪些故事', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认合并导入', exact: true }).click();
  await page.getByRole('button', { name: `打开对话 ${title}`, exact: true }).click();
  await page.getByLabel('输入消息', { exact: true }).fill('请接着之前的故事说。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('上下文测试回复 1。', { exact: true })).toBeVisible();
  expect(bodies).toHaveLength(1);
  expect(bodies[0].messages.length).toBeGreaterThan(40);
  expect(bodies[0].messages[0].content).toBe(history[0].content);
  const automaticHistory = bodies[0].messages.length - 1;
  expect(automaticHistory).toBe(60);
  await expect(page.getByText(`本次携带 ${automaticHistory} 条历史`, { exact: false }).last()).toBeVisible();

  await navigate(page, '连接与设置');
  await page.getByRole('button', { name: '限制最近消息', exact: true }).click();
  await page.getByText('40 条', { exact: true }).click();
  await navigate(page, '聊一会儿');
  await page.getByLabel('输入消息', { exact: true }).fill('现在只携带最近的消息。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('上下文测试回复 2。', { exact: true })).toBeVisible();
  expect(bodies).toHaveLength(2);
  const recentHistory = bodies[1].messages.length - 1;
  expect(recentHistory).toBeLessThanOrEqual(40);
  expect(recentHistory).toBeGreaterThan(0);
  const omitted = 62 - recentHistory;
  expect(omitted).toBeGreaterThan(0);
  await expect(page.getByText(`本次携带 ${recentHistory} 条历史`, { exact: false }).last()).toBeVisible();
  await expect(page.getByText(`${omitted} 条较早消息未发送`, { exact: false }).last()).toBeVisible();
});

test('manual retry reuses the first uploaded file and later turns retain both file references', async ({ page }) => {
  test.setTimeout(60000);
  const firstName = 'first-note.txt';
  const secondName = 'second-note.txt';
  const firstBytes = Buffer.from('first attachment fixture, no private data');
  const secondBytes = Buffer.from('second attachment fixture, no private data');
  const firstId = 'file-api-ui-first-note';
  const secondId = 'file-api-ui-second-note';
  let firstUploads = 0;
  let secondUploads = 0;
  let firstRetrievals = 0;
  const chatBodies: ChatRequest[] = [];
  const response = (first: boolean) => ({
    id: first ? firstId : secondId, object: 'file',
    bytes: first ? firstBytes.length : secondBytes.length,
    created_at: 1_790_000_000, filename: first ? firstName : secondName, purpose: 'user_data',
  });
  await page.route(`${API}/files`, async route => {
    const body = route.request().postDataBuffer() ?? Buffer.alloc(0);
    if (body.toString('utf8').includes(`filename="${firstName}"`)) {
      firstUploads++;
      expect(body.includes(firstBytes)).toBe(true);
      await route.fulfill({ json: response(true) });
    } else {
      secondUploads++;
      expect(body.toString('utf8')).toContain(`filename="${secondName}"`);
      expect(body.includes(secondBytes)).toBe(true);
      if (secondUploads === 1) await route.fulfill({ status: 503, json: { error: { message: 'second mock upload unavailable' } } });
      else await route.fulfill({ json: response(false) });
    }
  });
  await page.route(`${API}/files/${firstId}`, async route => {
    expect(route.request().method()).toBe('GET');
    firstRetrievals++;
    await route.fulfill({ json: response(true) });
  });
  await mockChat(page, chatBodies, index => `双附件续聊回复 ${index}。`);
  await page.goto('/');
  await connect(page);
  await navigate(page, '聊一会儿');
  await page.getByLabel('输入消息', { exact: true }).fill('请比较这两个文件。');
  const picker = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '添加文件', exact: true }).click();
  await (await picker).setFiles([
    { name: firstName, mimeType: 'text/plain', buffer: firstBytes },
    { name: secondName, mimeType: 'text/plain', buffer: secondBytes },
  ]);
  await expect(page.locator(DRAFT_ATTACHMENTS)).toHaveCount(2);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => secondUploads).toBe(1);
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  expect(firstUploads).toBe(1);
  expect(chatBodies).toHaveLength(0);
  await expect(page.locator(DRAFT_ATTACHMENTS).filter({ hasText: firstName })).toContainText('已上传');
  await expect(page.locator(DRAFT_ATTACHMENTS).filter({ hasText: secondName })).toContainText('上传失败');
  await expect(page.getByLabel('输入消息', { exact: true })).toHaveValue('请比较这两个文件。');

  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('双附件续聊回复 1。', { exact: true })).toBeVisible();
  expect(firstUploads).toBe(1);
  expect(secondUploads).toBe(2);
  expect(firstRetrievals).toBe(1);
  expect(fileReferences(chatBodies[0].messages)).toEqual([firstId, secondId]);
  await expect(page.locator(DRAFT_ATTACHMENTS)).toHaveCount(0);
  await expect(page.locator(SENT_ATTACHMENTS)).toHaveCount(2);
  await expect(page.getByLabel('输入消息', { exact: true })).toHaveValue('');

  await page.getByLabel('输入消息', { exact: true }).fill('请继续比较它们的共同点。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('双附件续聊回复 2。', { exact: true })).toBeVisible();
  expect(firstUploads).toBe(1);
  expect(secondUploads).toBe(2);
  expect(fileReferences(chatBodies[1].messages)).toEqual([firstId, secondId]);
  expect(JSON.stringify(chatBodies[1].messages.at(-1)?.content)).toContain('请继续比较它们的共同点。');
});
