import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { zeroWidthHspacePlugin } from '../src/core/markdown-spacing';

interface MarkdownToken {
  type: string;
  content: string;
  children?: MarkdownToken[] | null;
  attrs?: [string, string][] | null;
}

interface MarkdownParser {
  use(plugin: typeof zeroWidthHspacePlugin): MarkdownParser;
  render(source: string): string;
  parse(source: string, environment: object): MarkdownToken[];
}

const require = createRequire(import.meta.url);
const MarkdownIt = require('markdown-it') as new (options?: { typographer?: boolean }) => MarkdownParser;
const plain = new MarkdownIt({ typographer: true });
const compatible = new MarkdownIt({ typographer: true }).use(zeroWidthHspacePlugin);

function childrenOf(tokens: MarkdownToken[]): MarkdownToken[] {
  return tokens.flatMap(token => [token, ...childrenOf(token.children ?? [])]);
}

test('zero-width spacing between every character renders as continuous prose without changing source data', () => {
  const content = String.raw`\hspace{0cm}今\hspace{0cm}天\hspace{0cm}天\hspace{0cm}气\hspace{0cm}很\hspace{0cm}好\hspace{0cm}。`;
  const source = { content, originalData: { messages: [{ content }] } };
  const snapshot = JSON.stringify(source);
  assert.equal(compatible.render(source.content), plain.render('今天天气很好。'));
  assert.equal(JSON.stringify(source), snapshot);
  assert.equal(source.content, content);
});

test('only recognized signed zero cm/pt dimensions are hidden', () => {
  const zeros = [String.raw`\hspace{0cm}`, String.raw`\hspace{0pt}`, String.raw`\hspace*{0cm}`,
    String.raw`\hspace { +0.00 cm }`, String.raw`\hspace*{ -00.0pt }`, String.raw`\hspace{.0pt}`, String.raw`\hspace{0.pt}`];
  for (const value of zeros) assert.equal(compatible.render(`甲${value}乙`), plain.render('甲乙'), value);
  const untouched = [String.raw`\hspace{1cm}`, String.raw`\hspace{0.01pt}`, String.raw`\hspace{-1cm}`,
    String.raw`\hspace{0em}`, String.raw`\hspace{0mm}`, String.raw`\hspace{0}`, String.raw`\hspace{0.0e9cm}`,
    String.raw`\hspace{0pt plus 1pt}`, String.raw`\hspace{0cm`, String.raw`\Hspace{0cm}`, String.raw`\vspace{0cm}`,
    '\\hspace{0\ncm}', '\\hspace\n{0cm}'];
  for (const value of untouched) assert.equal(compatible.render(`甲${value}乙`), plain.render(`甲${value}乙`), value);
});

test('inline code, fenced code, and indented code keep literal spacing commands', () => {
  const examples = [
    '`\\hspace{0cm}`',
    '``a ` \\hspace{0cm}``',
    '```tex\n\\hspace{0cm}\n```',
    '~~~text\n\\hspace{0pt}\n~~~',
    '    \\hspace{0cm}\n',
  ];
  for (const source of examples) {
    assert.equal(compatible.render(source), plain.render(source));
    const tokens = childrenOf(compatible.parse(source, {}));
    assert.ok(tokens.some(token => ['code_inline', 'code_block', 'fence'].includes(token.type) && token.content.includes('\\hspace')));
  }
});

test('explicitly escaped commands and ordinary Markdown backslash escapes are preserved', () => {
  const sources = [String.raw`\\hspace{0cm}`, String.raw`解释：\\hspace*{0pt}`, String.raw`\\\\hspace{0cm}`,
    String.raw`\*普通星号\* 与 \[方括号\]`, String.raw`\未知指令{0cm}`];
  for (const source of sources) assert.equal(compatible.render(source), plain.render(source));
  assert.equal(compatible.render(String.raw`前\\\hspace{0cm}后`), plain.render(String.raw`前\\后`));
});

test('Markdown link destinations and titles stay unchanged while visible link labels can be cleaned', () => {
  const source = String.raw`[导\hspace{0cm}航](https://example.test/\hspace{0cm}?q=keep "标题\hspace{0pt}")`;
  const baseline = childrenOf(plain.parse(source, {})).find(token => token.type === 'link_open');
  const tokens = childrenOf(compatible.parse(source, {}));
  const link = tokens.find(token => token.type === 'link_open');
  assert.ok(baseline); assert.ok(link);
  assert.deepEqual(link.attrs, baseline.attrs);
  assert.ok(tokens.some(token => token.type === 'text' && token.content === '导航'));

  for (const preserved of [String.raw`<https://example.test/\hspace{0cm}>`,
    '[ref][key]\n\n[key]: https://example.test/\\hspace{0cm} "\\hspace{0pt}"',
    String.raw`![图](https://example.test/\hspace{0cm}.png "\hspace{0pt}")`]) {
    assert.equal(compatible.render(preserved), plain.render(preserved));
  }
});

test('normal Markdown structure and formatting remain intact', () => {
  const source = '# 标题\n\n- **今\\hspace{0cm}天**\n- *明天*\n\n> 一段\\hspace{0pt}引文\n\n[链接](https://example.test)\n';
  const expected = '# 标题\n\n- **今天**\n- *明天*\n\n> 一段引文\n\n[链接](https://example.test)\n';
  assert.equal(compatible.render(source), plain.render(expected));
  const unchanged = '# 普通标题\n\n表头 | 值\n--- | ---\n甲 | 乙\n\n**粗体**、*斜体*、~~删除线~~ 和换行。\n';
  assert.equal(compatible.render(unchanged), plain.render(unchanged));
});

test('bare HTTP URLs keep literal commands without disabling spacing in surrounding prose', () => {
  const preserved = [String.raw`https://example.test/\hspace{0cm}`, String.raw`HTTP://example.test/a?value=\hspace{0pt}`,
    String.raw`网址https://example.test/(part/\hspace{0cm})`, String.raw`https://[2001:db8::1]/\hspace*{0cm}`,
    String.raw`https://example.test/\hspace{0cm}/\hspace{0pt}`];
  for (const source of preserved) assert.equal(compatible.render(source), plain.render(source));
  const source = String.raw`甲\hspace{0cm}乙 https://example.test/\hspace{0cm} 丙\hspace{0cm}丁 [链接](https://example.test)戊\hspace{0cm}己`;
  const expected = String.raw`甲乙 https://example.test/\hspace{0cm} 丙丁 [链接](https://example.test)戊己`;
  assert.equal(compatible.render(source), plain.render(expected));
  const longUrl = `https://example.test/${String.raw`x\hspace{0cm}`.repeat(10000)}`;
  assert.equal(compatible.render(longUrl), plain.render(longUrl));
});

test('many spacing commands are consumed without altering the original string or swallowing malformed tails', () => {
  const repeated = String.raw`文\hspace{0cm}`.repeat(20000);
  const tail = String.raw`\hspace{1cm}末尾`;
  const source = repeated + tail;
  assert.equal(compatible.render(source), plain.render('文'.repeat(20000) + tail));
  assert.equal(source, repeated + tail);
});
