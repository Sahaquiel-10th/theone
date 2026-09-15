// Generated and persisted on the computer, never distributed on the USB.
// This separates browser sessions between computers; it is not hardware attestation.
export function validInstallationId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{32,80}$/.test(value);
}

export function requireInstallationId(value: unknown): string {
  if (!validInstallationId(value)) throw new Error("请更新 ONE Key 启动器，再从 U 盘双击 ONE 图标登录");
  return value;
}
