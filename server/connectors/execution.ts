import type { OneKeyPresence } from "../oneKeyPresence.js";
import type { LocalAgentService } from "../localAgentService.js";
import type { ExecutionAdapter } from "./registry.js";

export type ExecutionPresence = Pick<OneKeyPresence, "isConnected" | "supportsLocalAgent" | "startExecution" | "continueExecution" | "cancelExecution">;
export type LocalExecutor = Pick<LocalAgentService, "start" | "cancel">;

export function executionConnectors(presence: ExecutionPresence, local: LocalExecutor): ExecutionAdapter[] {
  return (["codex", "local_agent"] as const).map(provider => ({
    kind: "execution",
    provider,
    manifest: { id: provider, name: provider === "codex" ? "Codex" : "ONE Local Agent", version: "0.1.0", kind: "execution", capabilities: ["execution.start", "execution.continue", "execution.cancel"], auth: "local_runtime" },
    status(db, scope) {
      const device = db.oneKeyDevices.find(item => item.id === scope.deviceId && item.workspaceId === scope.workspaceId && item.userId === scope.userId && item.status === "active");
      if (!device || !presence.isConnected(device.id)) return { state: "offline", code: "DEVICE_OFFLINE", message: "请通过当前账号的 ONE Key 打开本机执行", evidence: "transport" };
      const isLocal = presence.supportsLocalAgent(device.id);
      if ((provider === "local_agent") !== isLocal) return { state: "unavailable", code: "RUNTIME_NOT_SELECTED", message: "当前启动器使用另一条执行路径", evidence: "transport" };
      return { state: "transport_ready", code: "TRANSPORT_CONNECTED", message: "本机通道在线；运行环境、账号和目录权限仍需执行时确认", evidence: "transport" };
    },
    async dispatch(action, task, instruction) {
      if (provider === "local_agent") {
        if (action === "cancel") await local.cancel(task.id);
        else local.start(task.id, action === "continue" ? instruction : undefined);
      } else if (action === "start") await presence.startExecution(task.deviceId, task.id, task.instruction);
      else if (action === "continue") await presence.continueExecution(task.deviceId, task.id, instruction!);
      else await presence.cancelExecution(task.deviceId, task.id);
    }
  }));
}
