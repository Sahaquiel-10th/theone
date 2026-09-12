import assert from "node:assert/strict";
import test from "node:test";
import { backupFreshness } from "./operationsHealth.js";

test("backup status never claims a missing verification marker is healthy", () => {
  const now = Date.parse("2026-09-12T10:00:00Z");
  assert.equal(backupFreshness(undefined, now).status, "unverified");
  assert.equal(backupFreshness(now - 25 * 60 * 60 * 1000, now).status, "ok");
  assert.equal(backupFreshness(now - 40 * 60 * 60 * 1000, now).status, "stale");
});
