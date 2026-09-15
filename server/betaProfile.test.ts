import assert from "node:assert/strict";
import test from "node:test";
import { accountProfile, BetaInputError, onboardingStep, updateAccountProfile } from "./betaProfile.js";
import type { Database } from "./types.js";

function database() {
  return {
    users: [{ id: "a", username: "internal-a", role: "user", defaultWorkspaceId: "wa", enabled: true, createdAt: "2026-01-01T00:00:00Z" }, { id: "b", username: "internal-b", role: "user", defaultWorkspaceId: "wb", enabled: true, createdAt: "2026-01-01T00:00:00Z" }],
    workspaces: [{ id: "wa", status: "active" }, { id: "wb", status: "active" }],
    workspaceMembers: [{ workspaceId: "wa", userId: "a" }, { workspaceId: "wb", userId: "b" }],
    knowledgeConnections: []
  } as unknown as Database;
}

const a = { userId: "a", workspaceId: "wa" };

test("a display name is independent of username and onboarding survives another device or later name change", () => {
  const db = database();
  assert.equal(onboardingStep(accountProfile(db, a)), "name");
  updateAccountProfile(db, a, { displayName: "  小马 🐴  " }, "2026-01-02T00:00:00Z");
  assert.equal(db.users[0].username, "internal-a");
  assert.equal(accountProfile(db, a).displayName, "小马 🐴");
  assert.equal(onboardingStep(accountProfile(db, a)), "knowledge");
  updateAccountProfile(db, a, { onboardingAction: "knowledge_skipped" }, "2026-01-02T00:01:00Z");
  assert.equal(onboardingStep(accountProfile(db, a)), "ready");
  updateAccountProfile(db, a, { onboardingAction: "complete" }, "2026-01-02T00:02:00Z");
  const reopened = JSON.parse(JSON.stringify(db)) as Database;
  assert.equal(onboardingStep(accountProfile(reopened, a)), "complete");
  updateAccountProfile(reopened, a, { displayName: "马先生" }, "2026-01-03T00:00:00Z");
  assert.equal(onboardingStep(accountProfile(reopened, a)), "complete");
  assert.equal(accountProfile(reopened, a).onboarding.completedAt, "2026-01-02T00:02:00Z");
  assert.equal(onboardingStep(accountProfile(db, { userId: "b", workspaceId: "wb" })), "name");
});

test("profile rejects a foreign workspace, missing membership, or disabled account", () => {
  const db = database();
  assert.throws(() => updateAccountProfile(db, { userId: "a", workspaceId: "wb" }, { displayName: "overwrite" }), BetaInputError);
  db.workspaceMembers = [];
  assert.throws(() => accountProfile(db, a), BetaInputError);
  db.workspaceMembers = [{ workspaceId: "wa", userId: "a" }] as Database["workspaceMembers"];
  db.users[0].enabled = false;
  assert.throws(() => updateAccountProfile(db, a, { displayName: "disabled" }), BetaInputError);
});

test("onboarding does not accept a different user's connected knowledge or a client-forged completion", () => {
  const db = database();
  assert.throws(() => updateAccountProfile(db, a, { onboardingAction: "complete" }), /称呼/);
  updateAccountProfile(db, a, { displayName: "A" });
  assert.throws(() => updateAccountProfile(db, a, { onboardingAction: "complete" }), /连接/);
  db.knowledgeConnections = [{ workspaceId: "wb", status: "connected" }] as Database["knowledgeConnections"];
  assert.throws(() => updateAccountProfile(db, a, { onboardingAction: "knowledge_connected" }), /还没有连接/);
  db.knowledgeConnections.push({ workspaceId: "wa", status: "connected" } as Database["knowledgeConnections"][number]);
  updateAccountProfile(db, a, { onboardingAction: "knowledge_connected" });
  assert.equal(accountProfile(db, a).onboarding.knowledgeChoice, "connected");
});

test("profile rejects invisible and overlong names, returns a defensive copy, and does not partially apply failed edits", () => {
  const db = database();
  for (const displayName of ["", "  ", "a\nb", "\u202eevil", "x".repeat(41), 42]) {
    assert.throws(() => updateAccountProfile(db, a, { displayName }), BetaInputError);
  }
  updateAccountProfile(db, a, { displayName: "A" });
  const profile = accountProfile(db, a);
  profile.displayName = "not saved";
  assert.equal(accountProfile(db, a).displayName, "A");
  assert.throws(() => updateAccountProfile(db, a, { displayName: "B", onboardingAction: "forged" }), BetaInputError);
  assert.equal(accountProfile(db, a).displayName, "A");
});
