import { expect, test, type Page } from '@playwright/test';

const CONVERSATION_ID = 'markdown-spacing-fixture';
const ASSISTANT_ID = 'spacing-answer';
const TITLE = '中文排版显示回归';
const QUESTION = '请用普通中文介绍今天的安排。';
const DISPLAY_PARAGRAPH = '今天适合去公园散步。';
const RAW_PARAGRAPH = String.raw`\hspace{0cm}今\hspace{0cm}天\hspace{0cm}适\hspace{0cm}合\hspace{0cm}去\hspace{0cm}公\hspace{0cm}园\hspace{0cm}散\hspace{0cm}步\hspace{0cm}。`;
const PLAIN_PARAGRAPH = '普通段落保持原样。';
const INLINE_CODE = String.raw`CODE_KEEP \hspace{0cm}`;
const FENCED_CODE = String.raw`FENCE_KEEP \hspace{0cm}`;
const RAW_CONTENT = [
  RAW_PARAGRAPH,
  PLAIN_PARAGRAPH,
  '行内代码：`' + INLINE_CODE + '`',
  '```tex\n' + FENCED_CODE + '\n```',
].join('\n\n');
const ORIGINAL_DATA = {
  id: 'original-spacing-fixture', title: TITLE,
  messages: [
    { id: 'spacing-question', role: 'user', content: QUESTION },
    { id: ASSISTANT_ID, role: 'assistant', content: RAW_CONTENT },
  ],
};

async function navigate(page: Page, label: string) {
  await page.getByRole('tab', { name: label, exact: true })
    .or(page.getByRole('button', { name: label, exact: true })).first().click();
}

async function openConversation(page: Page) {
  await navigate(page, '我的对话');
  await page.getByRole('button', { name: `打开对话 ${TITLE}`, exact: true }).click();
  await expect(page.getByTestId(`chat-message-${ASSISTANT_ID}`)).toBeVisible();
}

async function expectRenderedContent(page: Page) {
  const message = page.getByTestId(`chat-message-${ASSISTANT_ID}`);
  // Scope each assertion to the relevant paragraph/token: code examples below
  // intentionally retain their literal hspace text in this same message.
  await expect(message.getByText(DISPLAY_PARAGRAPH, { exact: true })).toBeVisible();
  await expect(message.getByText(RAW_PARAGRAPH, { exact: true })).toHaveCount(0);
  await expect(message.getByText(PLAIN_PARAGRAPH, { exact: true })).toBeVisible();
  await expect(message.getByText(INLINE_CODE, { exact: true })).toBeVisible();
  await expect(message.getByText(FENCED_CODE, { exact: true })).toBeVisible();
}

async function exportBackup(page: Page) {
  await navigate(page, '我的对话');
  await page.getByRole('button', { name: '导出备份', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '继续', exact: true }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  expect(stream).not.toBeNull();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
    conversations: { id: string; messages: { id: string; content: string }[]; originalData?: unknown }[];
  };
}

test('existing assistant prose hides zero-width spacing while code and exported source stay unchanged', async ({ page }) => {
  await page.route('https://api.deepseek.com/**', route => route.abort());
  await page.goto('/library');
  const fixture = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    conversations: [{
      id: CONVERSATION_ID, title: TITLE, createdAt: 1, updatedAt: 2,
      messages: [
        { id: 'spacing-question', role: 'user', content: QUESTION, createdAt: 1, status: 'complete' },
        { id: ASSISTANT_ID, role: 'assistant', content: RAW_CONTENT, createdAt: 2, status: 'complete' },
      ],
      originalData: ORIGINAL_DATA,
    }],
  }));
  const picker = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '导入旧对话', exact: true }).click();
  await (await picker).setFiles({ name: 'markdown-spacing.json', mimeType: 'application/json', buffer: fixture });
  await expect(page.getByText('先看看，要带回哪些故事', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认合并导入', exact: true }).click();
  await expect(page.getByText('已导入 1 个对话，保留已有记录，跳过 0 个重复对话。', { exact: true })).toBeVisible();

  await openConversation(page);
  await expectRenderedContent(page);
  // Reopen the already stored conversation without importing or rewriting it.
  await navigate(page, '连接与设置');
  await openConversation(page);
  await expectRenderedContent(page);

  const backup = await exportBackup(page);
  const saved = backup.conversations.find(conversation => conversation.id === CONVERSATION_ID);
  expect(saved).toBeDefined();
  expect(saved?.messages.find(message => message.id === ASSISTANT_ID)?.content).toBe(RAW_CONTENT);
  expect(saved?.originalData).toEqual(ORIGINAL_DATA);
});
