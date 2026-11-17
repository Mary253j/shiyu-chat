import { expect, test, type Locator, type Page } from '@playwright/test';

const LONG_TITLE = '滚动回归：长会话';
const SHORT_TITLE = '滚动回归：另一段对话';
const LATEST = '长会话的最新回复，只需要看到这里。';
const ROW_SELECTOR = '[data-testid^="chat-message-"]';

interface ControlledStream {
  requests: number;
  emit: (content: string) => void;
  finish: () => void;
}

declare global {
  interface Window {
    __shiyuScrollStream: ControlledStream;
  }
}

async function navigate(page: Page, label: string) {
  await page.getByRole('tab', { name: label, exact: true })
    .or(page.getByRole('button', { name: label, exact: true })).first().click();
}

function historyFixture() {
  const messages = Array.from({ length: 240 }, (_, index) => ({
    id: `history-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: index === 239 ? LATEST : index === 0 ? '长会话最早的消息。' : index % 2 === 0
      ? `历史问题 ${index}：今天记下了一些小事，想在下次聊天时再说。${'窗外很安静，树叶慢慢落下。'.repeat(4)}`
      : `历史回复 ${index}：**先慢慢说。**\n\n${'这些日常片段可以留着，以后再一起回顾。'.repeat(4)}`,
    createdAt: index + 1,
    status: 'complete',
  }));
  return Buffer.from(JSON.stringify({
    schemaVersion: 1,
    conversations: [
      { id: 'scroll-long', title: LONG_TITLE, createdAt: 1, updatedAt: 500, messages },
      {
        id: 'scroll-short', title: SHORT_TITLE, createdAt: 1, updatedAt: 501,
        messages: [
          { id: 'short-user', role: 'user', content: '另一段对话的问题。', createdAt: 1, status: 'complete' },
          { id: 'short-answer', role: 'assistant', content: '另一段对话的最新回复。', createdAt: 2, status: 'complete' },
        ],
      },
    ],
  }));
}

async function importHistory(page: Page, fixture = historyFixture(), conversationCount = 2) {
  await navigate(page, '我的对话');
  const picker = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '导入旧对话', exact: true }).click();
  await (await picker).setFiles({ name: 'scrolling-fixture.json', mimeType: 'application/json', buffer: fixture });
  await expect(page.getByText('先看看，要带回哪些故事', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认合并导入', exact: true }).click();
  await expect(page.getByText(`已导入 ${conversationCount} 个对话，保留已有记录，跳过 0 个重复对话。`, { exact: true })).toBeVisible();
}

async function openConversation(page: Page, title: string) {
  await navigate(page, '我的对话');
  await page.getByRole('button', { name: `打开对话 ${title}`, exact: true }).click();
  await expect(page.getByTestId('chat-messages')).toBeVisible();
}

async function connect(page: Page) {
  await page.route('https://api.deepseek.com/user/balance', route => route.fulfill({ json: {
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '12.34' }],
  } }));
  await navigate(page, '连接与设置');
  await page.getByLabel('API Key', { exact: true }).fill('test-only-fake-api-key');
  await page.getByRole('button', { name: '验证并安全保存', exact: true }).click();
  await expect(page.getByText('连接成功，可以开始聊天了。', { exact: true })).toBeVisible();
}

async function installControlledStream(page: Page) {
  await page.addInitScript(() => {
    const originalFetch = globalThis.fetch.bind(globalThis);
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const writeFrame = (frame: unknown) => {
      if (!controller) throw new Error('No mocked stream is open');
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
    };
    window.__shiyuScrollStream = {
      requests: 0,
      emit(content) {
        writeFrame({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
      },
      finish() {
        writeFrame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        controller!.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller!.close();
        controller = undefined;
      },
    };
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url !== 'https://api.deepseek.com/chat/completions') return originalFetch(input, init);
      window.__shiyuScrollStream.requests++;
      const body = new ReadableStream<Uint8Array>({
        start(value) { controller = value; },
        cancel() { controller = undefined; },
      });
      init?.signal?.addEventListener('abort', () => {
        controller?.error(new DOMException('Mock stream aborted', 'AbortError'));
        controller = undefined;
      }, { once: true });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
  });
}

async function scrollIntoHistory(list: Locator) {
  await list.evaluate(root => {
    const candidates = [root, ...root.querySelectorAll('*')];
    const element = candidates.find(value => value instanceof HTMLElement
      && value.scrollHeight > value.clientHeight + 100
      && /auto|scroll/.test(getComputedStyle(value).overflowY)) as HTMLElement | undefined;
    if (!element) throw new Error('The message list has no scrollable viewport');
    const max = element.scrollHeight - element.clientHeight;
    const distance = Math.max(600, element.clientHeight * 1.5);
    // RN's inverted list starts at offset zero. This also supports a web adapter
    // using ordinary bottom-oriented scrolling without testing a CSS transform.
    element.scrollTop = element.scrollTop < max / 2
      ? Math.min(max, element.scrollTop + distance)
      : Math.max(0, element.scrollTop - distance);
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
}

async function visibleHistoryAnchor(list: Locator): Promise<string> {
  let anchor = '';
  await expect.poll(async () => {
    anchor = await list.evaluate(root => {
      const bounds = root.getBoundingClientRect();
      const candidates = [...root.querySelectorAll<HTMLElement>('[data-testid^="chat-message-history-"]')];
      const visible = candidates.map(row => {
        const rect = row.getBoundingClientRect();
        const overlap = Math.min(rect.bottom, bounds.bottom) - Math.max(rect.top, bounds.top);
        return { id: row.dataset.testid ?? '', overlap };
      }).filter(row => row.overlap > 35).sort((a, b) => b.overlap - a.overlap);
      return visible[0]?.id ?? '';
    });
    return anchor;
  }).not.toBe('');
  return anchor;
}

test.beforeEach(async ({ page }) => {
  // All requests outside the explicit mocks are blocked, including paid API calls.
  await page.route('https://api.deepseek.com/**', route => route.abort());
});

test('long conversations open at the latest message and keep a bounded render window', async ({ page }) => {
  test.setTimeout(45000);
  await page.goto('/');
  await importHistory(page);
  await openConversation(page, LONG_TITLE);
  const list = page.getByTestId('chat-messages');
  const latest = page.getByTestId('chat-message-history-239');
  await expect(latest).toBeInViewport({ ratio: 0.5 });
  await expect(page.getByTestId('chat-message-history-0')).toHaveCount(0);
  expect(await list.locator(ROW_SELECTOR).count()).toBeLessThan(120);

  await scrollIntoHistory(list);
  await expect(page.getByRole('button', { name: '回到最新', exact: true })).toBeVisible();
  const anchor = page.getByTestId(await visibleHistoryAnchor(list));
  await expect(anchor).toBeInViewport();
  await page.getByLabel('输入消息', { exact: true }).fill('正在回看历史时写下的草稿。');
  await expect(anchor).toBeInViewport();
  await expect(latest).not.toBeInViewport();
  expect(await list.locator(ROW_SELECTOR).count()).toBeLessThan(120);

  await openConversation(page, SHORT_TITLE);
  await expect(page.getByTestId('chat-message-short-answer')).toBeInViewport();
  await openConversation(page, LONG_TITLE);
  await expect(latest).toBeInViewport({ ratio: 0.5 });
  await expect(page.getByRole('button', { name: '回到最新', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('chat-message-history-0')).toHaveCount(0);
});

test('streaming follows new messages but preserves a reader browsing history', async ({ page }) => {
  test.setTimeout(45000);
  await installControlledStream(page);
  await page.goto('/');
  await connect(page);
  await importHistory(page);
  await openConversation(page, LONG_TITLE);
  await page.getByLabel('输入消息', { exact: true }).fill('请继续讲今天的小事。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__shiyuScrollStream.requests)).toBe(1);
  await page.evaluate(() => window.__shiyuScrollStream.emit('流式回复开头。\n\n'));
  const reply = page.locator(ROW_SELECTOR).filter({ hasText: '流式回复开头。' }).first();
  await expect(reply).toBeInViewport();

  const list = page.getByTestId('chat-messages');
  await scrollIntoHistory(list);
  const latestButton = page.getByRole('button', { name: '回到最新', exact: true });
  await expect(latestButton).toBeVisible();
  const anchor = page.getByTestId(await visibleHistoryAnchor(list));
  await expect(anchor).toBeInViewport();
  await page.evaluate(() => window.__shiyuScrollStream.emit('历史浏览期间新增第一段。\n\n历史浏览期间新增第二段。\n\n'));
  // About one viewport away, the streamed row remains in the configured render
  // window. Wait for its actual text update, rather than a fixed timer delay.
  await expect(reply).toContainText('历史浏览期间新增第二段。');
  await expect(anchor).toBeInViewport();
  await expect(reply).not.toBeInViewport();
  await expect(latestButton).toBeVisible();

  await latestButton.click();
  await expect(reply).toBeInViewport();
  await page.evaluate(() => window.__shiyuScrollStream.emit('回到最新后新增的一段。\n\n'));
  await expect(reply).toContainText('回到最新后新增的一段。');
  await expect(reply).toBeInViewport();
  await page.evaluate(() => {
    window.__shiyuScrollStream.emit('流式回复结束。');
    window.__shiyuScrollStream.finish();
  });
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
  await expect(page.getByText('流式回复结束。', { exact: true })).toBeInViewport();
  await expect(latestButton).toHaveCount(0);
});

test('hundreds of conversations remain virtualized and searchable', async ({ page }) => {
  test.setTimeout(45000);
  const fixture = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    conversations: Array.from({ length: 300 }, (_, index) => ({
      id: `bulk-${index}`,
      title: `批量会话 ${String(index).padStart(3, '0')}`,
      createdAt: index + 1,
      updatedAt: index + 1,
      messages: [
        { id: `bulk-user-${index}`, role: 'user', content: `第 ${index} 段故事的问题。`, status: 'complete', createdAt: 1 },
        { id: `bulk-answer-${index}`, role: 'assistant', content: `第 ${index} 段故事的最新回复。`, status: 'complete', createdAt: 2 },
      ],
    })),
  }));
  await page.goto('/');
  await importHistory(page, fixture, 300);
  const list = page.getByTestId('conversation-list');
  await expect(page.getByRole('button', { name: '打开对话 批量会话 299', exact: true })).toBeInViewport();
  expect(await list.locator('[data-testid^="conversation-bulk-"]').count()).toBeLessThan(100);
  await expect(page.getByTestId('conversation-bulk-0')).toHaveCount(0);
  await page.getByRole('button', { name: '打开对话 批量会话 299', exact: true }).click();
  await expect(page.getByTestId('chat-message-bulk-answer-299')).toBeInViewport();

  await navigate(page, '我的对话');
  await page.getByLabel('搜索对话', { exact: true }).fill('批量会话 000');
  await expect(page.getByRole('button', { name: '打开对话 批量会话 000', exact: true })).toBeVisible();
  await expect(list.locator('[data-testid^="conversation-bulk-"]')).toHaveCount(1);
  await page.getByRole('button', { name: '打开对话 批量会话 000', exact: true }).click();
  await expect(page.getByTestId('chat-message-bulk-answer-0')).toBeInViewport();
});
