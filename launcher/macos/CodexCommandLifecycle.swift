import Foundation
import CoreFoundation

// A Codex turn or CLI process ending is not proof that a yielded command ended.
// Keep only tool identities and state, never command text, arguments or output.
struct CodexCommandLifecycle {
    private enum CommandState {
        case pending
        case ended(failed: Bool)
    }
    let attemptId: String
    private var commands: [String: CommandState] = [:]
    private var uncorrelatedCommand = false

    init(attemptId: String) { self.attemptId = attemptId }

    mutating func observe(attemptId: String, eventType: String, item: [String: Any]) {
        guard self.attemptId == attemptId,
              ["item.started", "item.updated", "item.completed"].contains(eventType),
              let type = item["type"] as? String,
              ["command_execution", "CommandExecution"].contains(type) else { return }
        guard let id = item["id"] as? String, !id.isEmpty, id.utf8.count <= 200,
              id.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95 }) else {
            uncorrelatedCommand = true
            return
        }
        let previous = commands[id]
        let status = (item["status"] as? String)?.lowercased()
        let running = ["in_progress", "running", "pending", "queued", "started"].contains(status ?? "")
        // JSON booleans bridge to NSNumber, as do fractional values. Neither
        // is an exit code. Negative sentinels (-1 on CLI teardown) are unknown,
        // not evidence that the underlying yielded command stopped safely.
        let exitCode = Self.confirmedExitCode(item["exit_code"])
        if eventType != "item.started", !running, ["completed", "failed"].contains(status ?? ""), let exitCode {
            let failed = status == "failed" || exitCode != 0
            if case .some(.ended(let previouslyFailed)) = previous {
                commands[id] = .ended(failed: previouslyFailed || failed)
            } else { commands[id] = .ended(failed: failed) }
            return
        }
        // Late/repeated progress must not resurrect a command whose exit was
        // already confirmed; a different command gets a different item id.
        if case nil = previous { commands[id] = .pending }
    }

    var hasUnconfirmedCommands: Bool {
        uncorrelatedCommand || commands.values.contains { if case .pending = $0 { return true }; return false }
    }

    var hasFailedCommands: Bool {
        commands.values.contains { if case .ended(let failed) = $0 { return failed }; return false }
    }

    var commandCount: Int { commands.count + (uncorrelatedCommand ? 1 : 0) }

    static func unconfirmedTerminal(finalResponse: String?, cancelled: Bool) -> (outcome: String, response: String, error: String) {
        let warning = cancelled
            ? "已收到停止请求，但还有工具没有确认结束。请先核对本机文件，不要重复操作；ONE 不会自动重新执行。"
            : "这轮还有工具没有确认结束，暂时不能算完成。请先核对本机文件，不要重复操作；ONE 不会自动重新执行。"
        return (cancelled ? "cancelled" : "failed",
                [finalResponse, warning].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n\n"),
                "command_unconfirmed")
    }

    private static func confirmedExitCode(_ raw: Any?) -> Int? {
        guard let number = raw as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite,
              number.doubleValue.rounded(.towardZero) == number.doubleValue,
              number.doubleValue >= 0, number.doubleValue <= Double(Int32.max) else { return nil }
        return number.intValue
    }
}
