import assert from "node:assert/strict";
import test from "node:test";
import type { NextFunction, Request, Response } from "express";
import type { Database } from "./types.js";
import { signToken } from "./security.js";

process.env.ADMIN_INITIAL_PASSWORD ||= "one-key-middleware-test-password";
const { auth, requireOneKeySession, requireRole } = await import("./middleware.js");

function responseRecorder() {
  const recorded: { status?: number; payload?: unknown } = {};
  const response = {
    locals: { requestId: "req-test" },
    status(code: number) { recorded.status = code; return this; },
    json(payload: unknown) { recorded.payload = payload; return this; }
  } as unknown as Response;
  return { recorded, response };
}

test("password sessions cannot call ONE Key protected routes", () => {
  const { recorded, response } = responseRecorder();
  let continued = false;
  requireOneKeySession({} as Request, response, (() => { continued = true; }) as NextFunction);
  assert.equal(continued, false);
  assert.equal(recorded.status, 428);
  assert.deepEqual(recorded.payload, {
    error: "请插入 ONE Key，并双击 ONE 图标重新打开",
    code: "ONE_KEY_LOGIN_REQUIRED",
    requestId: "req-test"
  });
});

test("a previously verified ONE Key session can continue to the protected route", () => {
  const { recorded, response } = responseRecorder();
  let continued = false;
  requireOneKeySession({ oneKeyDeviceId: "device-a" } as Request, response, (() => { continued = true; }) as NextFunction);
  assert.equal(continued, true);
  assert.equal(recorded.status, undefined);
});

function authFixture() {
  const db = {
    users: [
      { id: "admin", role: "admin", enabled: true, defaultWorkspaceId: "admin-workspace" },
      { id: "user", role: "user", enabled: true, defaultWorkspaceId: "user-workspace" }
    ],
    workspaceMembers: [{ userId: "admin", workspaceId: "admin-workspace" }, { userId: "user", workspaceId: "user-workspace" }],
    workspaces: [{ id: "admin-workspace", status: "active" }, { id: "user-workspace", status: "active" }]
  } as unknown as Database;
  const proofs: Array<{ deviceId: string; userId: string; workspaceId: string }> = [];
  const dependencies = {
    store: { read: async () => db },
    oneKeyPresence: { requireProof: async (params: { deviceId: string; userId: string; workspaceId: string }) => {
      proofs.push(params);
      if (params.deviceId !== `${params.userId}-key`) throw new Error("ONE Key 已挂失或不属于当前账号");
    } }
  };
  return { db, proofs, dependencies };
}

test("admin routes require both the admin's own live Key and current database role", async () => {
  for (const scenario of [
    { sub: "admin", deviceId: undefined, expectedStatus: 428 },
    { sub: "admin", deviceId: "user-key", expectedStatus: 428 },
    { sub: "user", deviceId: "user-key", expectedStatus: 403 },
    { sub: "admin", deviceId: "admin-key", expectedStatus: undefined }
  ]) {
    const { dependencies } = authFixture();
    const { recorded, response } = responseRecorder();
    const token = signToken({ sub: scenario.sub, role: "admin", deviceId: scenario.deviceId }, "test-secret");
    const request = { headers: { authorization: `Bearer ${token}` }, method: "GET", originalUrl: "/api/admin/operations" } as Request;
    let continued = false;
    await auth("test-secret", dependencies)(request, response, (() => {
      requireOneKeySession(request, response, (() => {
        requireRole("admin")(request, response, (() => { continued = true; }) as NextFunction);
      }) as NextFunction);
    }) as NextFunction);
    assert.equal(recorded.status, scenario.expectedStatus, JSON.stringify(scenario));
    assert.equal(continued, scenario.expectedStatus === undefined);
  }
});

test("Key sessions cannot override their exact workspace binding with a browser header", async () => {
  const { dependencies, proofs } = authFixture();
  const { recorded, response } = responseRecorder();
  const token = signToken({ sub: "user", deviceId: "user-key", workspaceId: "user-workspace" }, "test-secret");
  const request = { headers: { authorization: `Bearer ${token}`, "x-workspace-id": "admin-workspace" }, method: "GET", originalUrl: "/api/conversations" } as unknown as Request;
  let continued = false;
  await auth("test-secret", dependencies)(request, response, (() => { continued = true; }) as NextFunction);
  assert.equal(recorded.status, undefined);
  assert.equal(continued, true);
  assert.equal(proofs[0].workspaceId, "user-workspace");
  assert.equal(request.workspaceId, "user-workspace");
});

test("unplugged Keys and disabled users cannot reach private routes", async () => {
  const { db, dependencies } = authFixture();
  dependencies.oneKeyPresence.requireProof = async () => { throw new Error("请插入 ONE Key"); };
  const token = signToken({ sub: "user", deviceId: "user-key" }, "test-secret");
  for (const enabled of [true, false]) {
    db.users.find((user) => user.id === "user")!.enabled = enabled;
    const { recorded, response } = responseRecorder();
    let continued = false;
    await auth("test-secret", dependencies)({ headers: { authorization: `Bearer ${token}` }, method: "POST", originalUrl: "/api/attachments" } as Request, response, (() => { continued = true; }) as NextFunction);
    assert.equal(continued, false);
    assert.equal(recorded.status, enabled ? 428 : 401);
  }
});

test("malformed login credentials return 401 without throwing or checking USB presence", async () => {
  const { dependencies, proofs } = authFixture();
  for (const headers of [{ cookie: "one_session=%E0%A4%A" }, { authorization: "Bearer body.invalid-length" }]) {
    const { recorded, response } = responseRecorder();
    await auth("test-secret", dependencies)({ headers } as Request, response, (() => { throw new Error("must not continue"); }) as NextFunction);
    assert.equal(recorded.status, 401);
  }
  assert.equal(proofs.length, 0);
});
