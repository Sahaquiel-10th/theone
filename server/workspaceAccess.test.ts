import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorkspaceAccess } from "./workspaceAccess.js";
import type { Database, User } from "./types.js";

const userA: User = { id: "user-a", defaultWorkspaceId: "workspace-a", username: "a", passwordHash: "x", role: "user", enabled: true, createdAt: "2026-01-01" };
const database = {
  workspaces: [
    { id: "workspace-a", name: "A", slug: "a", status: "active", createdAt: "2026-01-01", updatedAt: "2026-01-01" },
    { id: "workspace-b", name: "B", slug: "b", status: "active", createdAt: "2026-01-01", updatedAt: "2026-01-01" }
  ],
  workspaceMembers: [
    { id: "member-a", workspaceId: "workspace-a", userId: "user-a", role: "owner", createdAt: "2026-01-01" },
    { id: "member-b", workspaceId: "workspace-b", userId: "user-b", role: "owner", createdAt: "2026-01-01" }
  ]
} as Database;

test("uses a user's default workspace", () => {
  assert.equal(resolveWorkspaceAccess(database, userA)?.workspaceId, "workspace-a");
});

test("rejects a workspace owned by another tenant", () => {
  assert.equal(resolveWorkspaceAccess(database, userA, "workspace-b"), null);
});
