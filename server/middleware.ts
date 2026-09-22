import { NextFunction, Request, Response } from "express";
import { verifyToken } from "./security.js";
import { Role, User } from "./types.js";
import { resolveWorkspaceAccess } from "./workspaceAccess.js";
import type { Store } from "./db.js";
import type { OneKeyPresence } from "./oneKeyPresence.js";

declare global {
  namespace Express {
    interface Request {
      user?: User;
      workspaceId?: string;
      oneKeyDeviceId?: string;
      oneKeyInstallationId?: string;
    }
  }
}

type AuthDependencies = { store: Pick<Store, "read">; oneKeyPresence: Pick<OneKeyPresence, "requireProof" | "runtimeStatus"> };

export function auth(secret: string, injected?: AuthDependencies, options?: { runtimeStatusOnly: true }) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    const cookieToken = req.headers.cookie
      ?.split(";")
      .map((item) => item.trim())
      .find((item) => item.startsWith("one_session="))
      ?.slice("one_session=".length);
    let payload: ReturnType<typeof verifyToken> = null;
    try {
      const token = header?.startsWith("Bearer ") ? header.slice(7) : decodeURIComponent(cookieToken || "");
      payload = token ? verifyToken(token, secret) : null;
    } catch {
      // Invalid signatures and malformed cookie encodings are failed authentication.
    }
    if (!payload) return res.status(401).json({ error: "未登录或登录已过期" });

    const dependencies = injected ?? { store: (await import("./db.js")).store, oneKeyPresence: (await import("./runtime.js")).oneKeyPresence };
    const db = await dependencies.store.read();
    const user = db.users.find((item) => item.id === payload.sub && item.enabled);
    if (!user) return res.status(401).json({ error: "账号不可用" });
    // A login in another tab changes the cookie. Never silently execute an old
    // tab's request under the newly logged-in person's account.
    const expectedUser = req.headers["x-one-user"];
    if (expectedUser && expectedUser !== user.id) return res.status(409).json({ error: "登录账号已切换，请重新确认当前页面", code: "SESSION_CHANGED" });

    const requestedWorkspace = payload.workspaceId || req.headers["x-workspace-id"]?.toString();
    const access = resolveWorkspaceAccess(db, user, requestedWorkspace);
    if (!access) return res.status(403).json({ error: "Workspace 不存在或无权访问" });

    req.user = user;
    req.workspaceId = access.workspaceId;
    req.oneKeyDeviceId = payload.deviceId;
    req.oneKeyInstallationId = payload.installationId;
    if (payload.deviceId) {
      try {
        const binding = { deviceId: payload.deviceId, installationId: payload.installationId, userId: user.id, workspaceId: access.workspaceId };
        // Old launchers cannot answer challenges while installing. This one
        // metadata-only route still checks the exact owner, Key and computer.
        if (options?.runtimeStatusOnly && req.method === "GET" && req.path === "/api/runtime/update") {
          await dependencies.oneKeyPresence.runtimeStatus(binding);
        } else {
          await dependencies.oneKeyPresence.requireProof({ ...binding, method: req.method, path: req.originalUrl });
        }
      } catch (error) {
        return res.status(428).json({ error: error instanceof Error ? error.message : "请插入 ONE Key", code: error && typeof error === "object" && "code" in error ? error.code : "ONE_KEY_REQUIRED", requestId: res.locals.requestId });
      }
    }
    next();
  };
}

export function requireRole(role: Role) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.user?.role !== role) return res.status(403).json({ error: "权限不足" });
    next();
  };
}

export function requireOneKeySession(req: Request, res: Response, next: NextFunction) {
  if (!req.oneKeyDeviceId) {
    return res.status(428).json({
      error: "请插入 ONE Key，并双击 ONE 图标重新打开",
      code: "ONE_KEY_LOGIN_REQUIRED",
      requestId: res.locals.requestId
    });
  }
  next();
}

export function asyncRoute(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}
