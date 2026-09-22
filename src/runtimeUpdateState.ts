export type RuntimeUpdateStatus = {
  configured: boolean;
  supported: boolean;
  current?: { platform: "macos" | "windows"; architecture: string; version: string; updateProtocol: number };
  latestVersion?: string;
  available: boolean;
  progress?: { requestId: string; status: "requested" | "downloading" | "verifying" | "installing" | "completed" | "failed"; version: string; message?: string; updatedAt: string };
};

export function runtimeUpdateView(result: RuntimeUpdateStatus, wasUpdating: boolean, now = Date.now()) {
  if (!result.available) return { busy: false, issue: "" };
  if (!result.progress) return { busy: false, issue: wasUpdating ? "连接已恢复，请检查更新状态" : "" };
  if (result.progress.status === "failed") return { busy: false, issue: "" };
  const age = now - Date.parse(result.progress.updatedAt);
  const limit = result.progress.status === "requested" || result.progress.status === "completed" ? 30_000 : 30 * 60_000;
  if (!Number.isFinite(age) || age > limit) {
    return { busy: false, issue: result.progress.status === "completed" ? "新版尚未连接，请从 U 盘打开 ONE" : "更新状态暂未确认，请检查连接" };
  }
  return { busy: true, issue: "" };
}
