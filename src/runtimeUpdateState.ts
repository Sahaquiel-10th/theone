export type RuntimeUpdateStatus = {
  configured: boolean;
  supported: boolean;
  current?: { platform: "macos" | "windows"; architecture: string; version: string; updateProtocol: number };
  latestVersion?: string;
  available: boolean;
  connectionState?: 'connected' | 'reconnecting';
  confirmation?: { requestId: string; version: string };
  progress?: { requestId: string; status: "requested" | "downloading" | "verifying" | "installing" | "completed" | "failed"; version: string; message?: string; updatedAt: string; recoveryRequired?: boolean };
};

export function runtimeUpdateConfirmed(result: RuntimeUpdateStatus) {
  return Boolean(result.configured && result.supported && !result.available && result.connectionState === 'connected' && result.current
    && result.confirmation?.requestId && result.confirmation.version === result.current.version);
}

export function runtimeUpdateView(result: RuntimeUpdateStatus, wasUpdating: boolean, now = Date.now()) {
  if (result.connectionState === 'reconnecting') {
    const age = now - Date.parse(result.progress?.updatedAt || '');
    return { busy: false, issue: Number.isFinite(age) && age <= 90_000
      ? '更新后正在自动重新连接，请保持 Key 插入，无需反复插拔或安装。'
      : '新版尚未连接。请重新双击 U 盘中的 ONE，网页会自动确认结果，无需再次安装。' };
  }
  if (!result.available) return { busy: false, issue: "" };
  if (!result.progress) return { busy: false, issue: wasUpdating ? "连接已恢复，请检查更新状态" : "" };
  if (result.progress.status === "failed") return { busy: false, issue: "" };
  if (result.progress.status === 'completed' && result.latestVersion && result.latestVersion !== result.progress.version) return { busy: false, issue: "" };
  if (result.progress.recoveryRequired) return { busy: false, issue: '正在自动确认新版。若一直未恢复，请重新双击 U 盘中的 ONE；请勿重复安装。' };
  const age = now - Date.parse(result.progress.updatedAt);
  const limit = result.progress.status === "requested" || result.progress.status === "completed" ? 30_000 : 30 * 60_000;
  if (!Number.isFinite(age) || age > limit) {
    return { busy: false, issue: result.progress.status === "completed" ? "安装已完成，但新版尚未连接。请重新双击 U 盘中的 ONE，网页会自动确认，无需再次安装。" : "更新结果尚未确认。请重新双击 U 盘中的 ONE，网页会自动检查；请勿重复安装。" };
  }
  return { busy: true, issue: "" };
}
