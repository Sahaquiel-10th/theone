import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageMarkdown } from "./MessageMarkdown.js";
const render = (children: string) => renderToStaticMarkup(createElement(MessageMarkdown, { children }));

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
