import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EnterpriseConnectionNotice, EnterpriseKnowledgeCard, FlomoConnectionNotice, matchesKnowledgeCard } from "./EnterpriseConnectionNotice";

test("enterprise entry explains administrator enablement and uses the supplied contact QR", () => {
  const html = renderToStaticMarkup(createElement(EnterpriseConnectionNotice));
  assert.match(html, /需要企业管理员开通/); assert.match(html, /请让企业管理员联系我们/);
  assert.match(html, /src="\/enterprise-contact-qr.png"/); assert.match(html, /alt="联系 ONE 的微信二维码"/);
  const card = renderToStaticMarkup(createElement(EnterpriseKnowledgeCard, { id: "wechat", label: "微信", query: "", filter: "all" }));
  assert.match(card, /需管理员开通/); assert.doesNotMatch(card, /已连接|oauth|token/i);
});
test("flomo explains MAX requirement and read-only behavior before authorization", () => {
  const html = renderToStaticMarkup(createElement(FlomoConnectionNotice));
  assert.match(html, /MAX 会员/); assert.match(html, /免费版和 PRO 暂不支持/); assert.match(html, /不会修改或删除笔记/);
});
test("enterprise entries respect search and connection filtering without hiding connected Feishu", () => {
  assert.equal(matchesKnowledgeCard("钉钉", "dingtalk", false, "钉", "all"), true);
  assert.equal(matchesKnowledgeCard("微信", "wechat", false, "", "connected"), false);
  assert.equal(matchesKnowledgeCard("飞书", "feishu", true, "", "connected"), true);
  assert.equal(matchesKnowledgeCard("飞书", "feishu", true, "flomo", "all"), false);
});
