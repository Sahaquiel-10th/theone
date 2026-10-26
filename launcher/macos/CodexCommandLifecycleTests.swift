import Foundation

@main struct CodexCommandLifecycleTests {
    static func item(_ id: Any = "command-a", status: String? = nil, exitCode: Any? = nil) -> [String: Any] {
        var value: [String: Any] = ["id": id, "type": "command_execution"]
        if let status { value["status"] = status }
        if let exitCode { value["exit_code"] = exitCode }
        return value
    }
    static func main() {
        var normal = CodexCommandLifecycle(attemptId: "attempt-a")
        normal.observe(attemptId: "attempt-a", eventType: "item.started", item: item(status: "in_progress"))
        precondition(normal.hasUnconfirmedCommands)
        normal.observe(attemptId: "attempt-a", eventType: "item.updated", item: item(status: "running"))
        precondition(normal.hasUnconfirmedCommands)
        normal.observe(attemptId: "attempt-a", eventType: "item.completed", item: item(status: "completed", exitCode: 0))
        precondition(!normal.hasUnconfirmedCommands && !normal.hasFailedCommands && normal.commandCount == 1)
        normal.observe(attemptId: "attempt-a", eventType: "item.started", item: item(status: "in_progress"))
        precondition(!normal.hasUnconfirmedCommands, "late progress does not reopen confirmed exit")

        var failed = CodexCommandLifecycle(attemptId: "attempt-a")
        failed.observe(attemptId: "attempt-a", eventType: "item.completed", item: item(status: "failed", exitCode: 1))
        precondition(!failed.hasUnconfirmedCommands && failed.hasFailedCommands)
        failed.observe(attemptId: "attempt-a", eventType: "item.completed", item: item(status: "completed", exitCode: 0))
        precondition(failed.hasFailedCommands, "later completion cannot erase confirmed failure")

        for code in [NSNull(), true, false, 0.5, -1, "0"] as [Any] {
            var unknown = CodexCommandLifecycle(attemptId: "attempt-a")
            unknown.observe(attemptId: "attempt-a", eventType: "item.completed", item: item(status: "completed", exitCode: code))
            precondition(unknown.hasUnconfirmedCommands, "missing, malformed and negative exit codes stay unknown")
        }
        for status in ["in_progress", "running", "pending", "queued", "started"] {
            var running = CodexCommandLifecycle(attemptId: "attempt-a")
            running.observe(attemptId: "attempt-a", eventType: "item.completed", item: item(status: status, exitCode: 0))
            precondition(running.hasUnconfirmedCommands)
        }
        var missing = CodexCommandLifecycle(attemptId: "attempt-a")
        missing.observe(attemptId: "attempt-a", eventType: "item.completed", item: item(status: "completed"))
        precondition(missing.hasUnconfirmedCommands)
        var badId = CodexCommandLifecycle(attemptId: "attempt-a")
        badId.observe(attemptId: "attempt-a", eventType: "item.started", item: ["type": "command_execution"])
        badId.observe(attemptId: "attempt-a", eventType: "item.completed", item: item(status: "completed", exitCode: 0))
        precondition(badId.hasUnconfirmedCommands, "a later unrelated id cannot settle an uncorrelated command")
        for id in ["", " ", "bad\nid", 3, NSNull(), String(repeating: "i", count: 201)] as [Any] {
            var malformed = CodexCommandLifecycle(attemptId: "attempt-a")
            malformed.observe(attemptId: "attempt-a", eventType: "item.completed", item: item(id, status: "completed", exitCode: 0))
            precondition(malformed.hasUnconfirmedCommands)
        }
        for status in [nil, "unknown"] as [String?] {
            var unspecified = CodexCommandLifecycle(attemptId: "attempt-a")
            unspecified.observe(attemptId: "attempt-a", eventType: "item.completed", item: item(status: status, exitCode: 0))
            precondition(unspecified.hasUnconfirmedCommands)
        }
        var foreign = CodexCommandLifecycle(attemptId: "attempt-a")
        foreign.observe(attemptId: "attempt-old", eventType: "item.started", item: item())
        precondition(!foreign.hasUnconfirmedCommands && foreign.commandCount == 0)
        foreign.observe(attemptId: "attempt-a", eventType: "item.started", item: ["id": "message", "type": "agent_message"])
        precondition(foreign.commandCount == 0, "an agent answer is not a command exit")

        var multiple = CodexCommandLifecycle(attemptId: "attempt-a")
        multiple.observe(attemptId: "attempt-a", eventType: "item.started", item: item("one"))
        multiple.observe(attemptId: "attempt-a", eventType: "item.started", item: item("two"))
        multiple.observe(attemptId: "attempt-a", eventType: "item.completed", item: item("one", status: "completed", exitCode: 0))
        precondition(multiple.hasUnconfirmedCommands && multiple.commandCount == 2)
        multiple.observe(attemptId: "attempt-a", eventType: "item.updated", item: item("two", status: "completed", exitCode: 0))
        precondition(!multiple.hasUnconfirmedCommands)

        // Models the private QA-延迟写入20261015 evidence: a yielded tool was
        // never polled and teardown recorded -1. Original public stdout was
        // not retained, so these public-event fixtures are conservative inputs,
        // not a claim that the original public stream contained every event.
        var qa = CodexCommandLifecycle(attemptId: "attempt-qa")
        qa.observe(attemptId: "attempt-qa", eventType: "item.started", item: item("call-qa", status: "in_progress"))
        var yielded = item("call-qa", status: "in_progress", exitCode: NSNull())
        yielded["process_id"] = "80778"
        qa.observe(attemptId: "attempt-qa", eventType: "item.updated", item: yielded)
        precondition(qa.hasUnconfirmedCommands)
        var teardown = item("call-qa", status: "failed", exitCode: -1)
        teardown["type"] = "CommandExecution"; teardown["process_id"] = "80778"
        qa.observe(attemptId: "attempt-qa", eventType: "item.completed", item: teardown)
        precondition(qa.hasUnconfirmedCommands, "CLI exit and a final answer do not settle a yielded command")
        for cancelled in [true, false] {
            let terminal = CodexCommandLifecycle.unconfirmedTerminal(finalResponse: "真实回答：QA_CANCEL_B_STARTED", cancelled: cancelled)
            precondition(terminal.outcome == (cancelled ? "cancelled" : "failed") && terminal.error == "command_unconfirmed")
            precondition(terminal.response.contains("真实回答：QA_CANCEL_B_STARTED") && terminal.response.contains("没有确认结束"))
            precondition(!terminal.response.contains("已停止"), "a cancellation request is not proof that the yielded tool stopped")
        }
        let unstarted = CodexCommandLifecycle.terminalResponse(cancelled: true, status: "cancelled", text: "已停止，本机任务尚未开始。", error: nil)
        precondition(unstarted == "已停止，本机任务尚未开始。", "a known preparation stop must retain its actual reason")
        let lateCompletion = CodexCommandLifecycle.terminalResponse(cancelled: true, status: "completed", text: "everything complete", error: nil)
        precondition(!lateCompletion.contains("everything complete"), "late completion must not undo a user stop")
        let uncertain = CodexCommandLifecycle.terminalResponse(cancelled: true, status: "cancelled", text: "工具还没有确认结束", error: "command_unconfirmed")
        precondition(uncertain.contains("没有确认结束"), "unknown tool termination must retain its warning")
        print("Mac Codex command lifecycle tests passed (attempt isolation, confirmed exits, yielded sessions, missing and negative exits)")
    }
}
