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

// The status endpoint remains authenticated during a runtime handoff. A failed
// /me check must not erase the installation result or masquerade as a lost Key.
export function runtimeRecoveryMessage(result: RuntimeUpdateStatus): string {
  if (!result.configured || !result.supported || !result.progress || runtimeUpdateConfirmed(result)) return '';
  if (result.progress.status === 'completed' && result.current?.platform === 'macos'
    && (result.available || result.connectionState === 'reconnecting')) {
    return `更新文件已安装（${result.progress.version}）。旧启动器已退出，请重新双击同一枚 U 盘中的 ONE。无需拔插、重装或重启电脑；新版连接后本页会自动恢复。`;
  }
  if (result.connectionState === 'reconnecting' && result.progress.status !== 'failed') {
    return '更新连接尚未恢复。若正在安装，请保持 Key 插入；若安装已结束，请重新打开同一枚 U 盘中的 ONE。不要重复安装，本页会自动检查连接。';
  }
  return '';
}

export function runtimeUpdateView(result: RuntimeUpdateStatus, wasUpdating: boolean, now = Date.now()) {
  if (result.current?.platform === 'macos' && result.progress?.status === 'completed'
    && !runtimeUpdateConfirmed(result) && (result.available || result.connectionState === 'reconnecting')) {
    return { busy: false, issue: '更新文件已安装。请重新双击同一枚 U 盘中的 ONE；连接成功后网页会自动确认，无需再次安装。' };
  }
  if (result.connectionState === 'reconnecting') {
    const age = now - Date.parse(result.progress?.updatedAt || '');
    return { busy: false, issue: Number.isFinite(age) && age <= 90_000
      ? '正在等待新版连接。如果中途拔出了 Key，请插回同一枚；网页会自动确认结果。'
      : '新版仍未连接。如果拔出了 Key，请插回同一枚，再打开盘中的 ONE。请勿重复安装；若仍打不开，需要修复启动器。' };
  }
  if (!result.available) return { busy: false, issue: "" };
  if (!result.progress) return { busy: false, issue: wasUpdating ? "连接已恢复，请检查更新状态" : "" };
  if (result.progress.status === "failed") return { busy: false, issue: "" };
  if (result.progress.status === 'completed' && result.latestVersion && result.latestVersion !== result.progress.version) return { busy: false, issue: "" };
  const age = now - Date.parse(result.progress.updatedAt);
  if (result.progress.recoveryRequired) return { busy: false, issue: Number.isFinite(age)&&age<=90_000
    ? '正在等待新版连接。如果中途拔出了 Key，请插回同一枚；网页会自动确认结果。请勿重复安装。'
    : '新版启动尚未确认。请重新打开同一枚 Key 中的 ONE；如果仍无法打开，需要修复启动器，不用重新灌装。请勿重复安装。' };
  const limit = result.progress.status === "requested" || result.progress.status === "completed" ? 30_000 : 30 * 60_000;
  if (!Number.isFinite(age) || age > limit) {
    return { busy: false, issue: result.progress.status === "completed" ? "安装已完成，但新版尚未连接。请重新双击 U 盘中的 ONE，网页会自动确认，无需再次安装。" : "更新结果尚未确认。请重新双击 U 盘中的 ONE，网页会自动检查；请勿重复安装。" };
  }
  return { busy: true, issue: "" };
}
