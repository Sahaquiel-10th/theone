import { NextFunction, Request, Response } from "express";
import { store } from "./db.js";
import { verifyToken } from "./security.js";
import { Role, User } from "./types.js";
import { resolveWorkspaceAccess } from "./workspaceAccess.js";
import { oneKeyPresence } from "./runtime.js";

declare global {
  namespace Express {
    interface Request {
      user?: User;
      workspaceId?: string;
      oneKeyDeviceId?: string;
    }
  }
}

export function auth(secret: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    const cookieToken = req.headers.cookie
      ?.split(";")
      .map((item) => item.trim())
      .find((item) => item.startsWith("one_session="))
      ?.slice("one_session=".length);
    const token = header?.startsWith("Bearer ") ? header.slice(7) : decodeURIComponent(cookieToken || "");
    const payload = token ? verifyToken(token, secret) : null;
    if (!payload) return res.status(401).json({ error: "未登录或登录已过期" });

    const db = await store.read();
    const user = db.users.find((item) => item.id === payload.sub && item.enabled);
    if (!user) return res.status(401).json({ error: "账号不可用" });

    const requestedWorkspace = payload.workspaceId || req.headers["x-workspace-id"]?.toString();
    const access = resolveWorkspaceAccess(db, user, requestedWorkspace);
    if (!access) return res.status(403).json({ error: "Workspace 不存在或无权访问" });

    req.user = user;
    req.workspaceId = access.workspaceId;
    req.oneKeyDeviceId = payload.deviceId;
    if (payload.deviceId) {
      try {
        await oneKeyPresence.requireProof({ deviceId: payload.deviceId, userId: user.id, workspaceId: access.workspaceId, method: req.method, path: req.originalUrl });
      } catch (error) {
        return res.status(428).json({ error: error instanceof Error ? error.message : "请插入 ONE Key", code: "ONE_KEY_REQUIRED", requestId: res.locals.requestId });
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

export function asyncRoute(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}
