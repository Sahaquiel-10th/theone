import assert from "node:assert/strict";
import test from "node:test";
import { waitingForOfficialApproval, officialApprovalLabel, officialApprovalHint } from "./knowledgeAvailability.js";

test("unconfigured Yinxiang shows the official approval blocker for disconnected states", () => {
  for (const status of ["disconnected", "revoked", "pending", "error"]) {
    assert.equal(waitingForOfficialApproval("yinxiang", false, status), true);
  }
  assert.equal(officialApprovalLabel, "等待官方开通");
  assert.match(officialApprovalHint, /暂不可连接/);
});

test("official approval copy does not override connected accounts or other providers", () => {
  assert.equal(waitingForOfficialApproval("yinxiang", false, "connected"), false);
  assert.equal(waitingForOfficialApproval("yinxiang", true, "disconnected"), false);
  for (const provider of ["getnote", "notion", "flowus"]) {
    assert.equal(waitingForOfficialApproval(provider, false, "disconnected"), false);
  }
});
