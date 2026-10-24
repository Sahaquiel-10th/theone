import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageMarkdown, hasInlineImage } from "./MessageMarkdown.js";
const render = (children: string) => renderToStaticMarkup(createElement(MessageMarkdown, { children }));
test('missing, placeholder and unsupported artifact links never navigate to the homepage',()=>{
 for(const url of ['', '#', 'attachment:att_test', 'javascript:alert(1)']) {
  const html=render(`[查看成果](${url})`);
  assert.doesNotMatch(html, /<a\b/);
  assert.match(html, /查看成果/);
 }
 assert.match(render('[查看成果](/api/welcome-pages/att_test/view)'), /href="\/api\/welcome-pages\/att_test\/view"/);
});
test("inline images use a compact accessible preview and repeated attachment images can be omitted",()=>{
 const url='/api/attachments/att_test/content',text=`![结果](${url})`;
 assert.match(render(text),/class="one-image-preview"/);
 assert.match(render(text),/查看大图/);
 assert.equal(hasInlineImage(text,url),true);
 assert.equal(hasInlineImage('[下载]('+url+')',url),false);
 assert.equal(hasInlineImage(text,url+'2'),false);
});

test("local artifact links show the actual copyable path instead of a broken website route", () => {
  for (const path of ['/Users/machao/Desktop/test/order.md', '/home/test/order.md', 'file:///Users/test/order.md', 'file:///C:/test/order.md']) {
    const html = render(`[订单文件](${path})`);
    assert.doesNotMatch(html, /<a\b/);
    assert.match(html, /<code class="one-local-artifact-path">/);
    assert.match(html, /(?:\/Users\/|\/home\/|C:\/)\S*order\.md/);
  }
  for (const path of ['/api/attachments/att_test/content', '/?task=cnv_test', 'https://example.com/home/test']) {
    assert.match(render(`[结果](${path})`), /<a\b/);
  }
});

test("public text answers cannot automatically load model-supplied remote images", () => {
  const html = renderToStaticMarkup(createElement(MessageMarkdown, { children: "![tracking](https://example.com/private-query)\n\nAnswer", allowImages: false }));
  assert.doesNotMatch(html, /<img|example.com/);
  assert.match(html, /Answer/);
});

test("inline and block mathematics render, including the reported meeting probability notation", () => {
  const html = render("区间 $[0,T]$，时间 $t$，$0<t\\le T$\n\n$$|X-Y|\\le t$$\n\n$$\n\\Omega=\\{(x,y):0\\le x\\le T,0\\le y\\le T\\}\n$$");
  assert.match(html, /class="katex"/);
  assert.match(html, /katex-display/);
  assert.doesNotMatch(html, /katex-error/);
});
test("code stays literal and malformed math never breaks the rest of the answer", () => {
  const html = render("`$x$`\n\n```tex\n$$x^2$$\n```\n\n$\\invalidcommand{x}$\n\n后续正文");
  assert.match(html, /<code>\$x\$<\/code>/);
  assert.match(html, /\$\$x\^2\$\$/);
  assert.match(html, /后续正文/);
});
test("untrusted HTML and TeX cannot execute scripts or create javascript links", () => {
  const html = render('<script>alert(1)</script>\n\n$\\href{javascript:alert(1)}{bad}$\n\n$\\htmlClass{injected}{x}$');
  assert.doesNotMatch(html, /<script>|href="javascript:|class="injected"/);
});

test("conversation code tools keep semantic markdown and literal code in safe direct-child blocks", () => {
  const html = renderToStaticMarkup(createElement(MessageMarkdown, { codeTools: true, children: '## 建议\n\n先看 **重点** 和 `inline()`。\n\n- 第一项\n- 第二项\n\n| 名称 | 状态 |\n| --- | --- |\n| 测试 | 完成 |\n\n```js\nconst html = "<script>literal</script>";\nconst value = "$x$";\n```' }));
  assert.match(html, /^<h2>建议<\/h2>/);
  assert.match(html, /<strong>重点<\/strong>/);
  assert.match(html, /<ul>\s*<li>第一项<\/li>/);
  assert.match(html, /<table>/);
  assert.match(html, /<div class="one-markdown-code-block"><div class="one-markdown-code-toolbar"><span>js<\/span>/);
  assert.match(html, /aria-label="复制代码"/);
  assert.match(html, /<pre><code class="language-js">/);
  assert.match(html, /&lt;script&gt;literal&lt;\/script&gt;/);
  assert.match(html, /\$x\$/);
  assert.doesNotMatch(html, /<script>|class="katex"/);
  assert.doesNotMatch(render('```js\nconst x = 1;\n```'), /one-markdown-code-toolbar/);
});
