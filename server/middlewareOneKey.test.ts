import assert from "node:assert/strict";
import test from "node:test";
import type { NextFunction, Request, Response } from "express";
import { requireOneKeySession } from "./middleware.js";

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
