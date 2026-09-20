import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CacheUsageDetails } from "./CacheUsageDetails";
import { usagePower, type PowerUsage } from "./usagePower";
const row: PowerUsage = { inputTokens: 2, outputTokens: 171, inputPowerPerMillionSnapshot: 1.8, outputPowerPerMillionSnapshot: 9,
  cacheUsage: { read: 0, write: 6684, write5m: 6684, write1h: 0 }, cachePricesSnapshot: { read: .18, write: 2.25, write1h: 3.6 }, chargedMicros: 16582, status: "success" };
test("discounted snapshot is applied once; components sum to settled charge", () => {
  const p = usagePower(row)!;
  assert.equal(p.total, 16582); assert.equal(p.input + p.output, p.total); assert.equal(p.adjustment, 0);
  assert.equal(p.write, 15039);
});
test("one-hour and unspecified cache buckets retain original billing", () => {
  const p = usagePower({ ...row, cacheUsage: { read: 10, write: 30, write5m: 10, write1h: 5 } })!;
  assert.equal(p.total, Math.ceil(3.6 + 1539 + 1.8 + 25 * 2.25 + 5 * 3.6 - 1e-7));
  assert.equal(p.input + p.output, p.total);
});
test("caps are explicit and unknown, waived, failed or fixed records do not invent detail", () => {
  assert.equal(usagePower({ ...row, chargedMicros: 100 })!.adjustment, 100 - 16582);
  for (const status of ["pending", "needs_review", "waived", "failed"]) assert.equal(usagePower({ ...row, status }), null);
  assert.equal(usagePower({ ...row, inputPowerPerMillionSnapshot: undefined }), null);
  assert.equal(usagePower({ ...row, cachePricesSnapshot: undefined }), null);
  assert.equal(usagePower({ ...row, source: "fixed" }), null);
});
test("user detail uses power, collapsed cache and no multiplier or raw usage", () => {
  const html = renderToStaticMarkup(createElement(CacheUsageDetails, { row }));
  assert.match(html, /输入 .* 电力 · 输出 .* 电力/);
  assert.match(html, /<details>/); assert.doesNotMatch(html, /Token|6684|×0.6|<details open/);
});
