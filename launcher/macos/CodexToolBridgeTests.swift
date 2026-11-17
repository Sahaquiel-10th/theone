import Foundation
import Darwin

private struct BridgeTestFailure: Error { let message: String }
private func check(_ condition: Bool, _ message: String) throws {
    if !condition { throw BridgeTestFailure(message: message) }
}
private actor OutboundRequests {
    private var requests: [CodexToolBridgeRequest] = []
    func send(_ request: CodexToolBridgeRequest) -> Bool { requests.append(request); return true }
    func next(_ index: Int) async throws -> CodexToolBridgeRequest {
        let deadline = ProcessInfo.processInfo.systemUptime + 1
        while requests.count <= index {
            guard ProcessInfo.processInfo.systemUptime < deadline else { throw BridgeTestFailure(message: "request missing") }
            try await Task.sleep(for: .milliseconds(2))
        }
        return requests[index]
    }
}
private func call(_ callId: String = "call_1") -> CodexDynamicToolCall {
    CodexDynamicToolCall(threadId: "thread_1", turnId: "turn_1", callId: callId,
        tool: "one_save_artifact", arguments: .object(["content": .string("synthetic")]))
}
private func reply(_ request: CodexToolBridgeRequest, round: Int? = nil) -> CodexToolBridgeReply {
    CodexToolBridgeReply(taskId: request.taskId, round: round ?? request.round, attemptId: request.attemptId,
        requestId: request.requestId, threadId: request.threadId, turnId: request.turnId, callId: request.callId,
        contentItems: [.object(["type": .string("inputText"), "text": .string("saved once")])], success: true)
}

@main private struct CodexToolBridgeTests {
    static func main() async {
        alarm(10)
        do {
            let channel = CodexToolBridgeChannel(timeout: 1), outbound = OutboundRequests()
            let task = Task { try await channel.call(call(), taskId: "task_1", round: 1, attemptId: "attempt_1", send: { await outbound.send($0) }) }
            let first = try await outbound.next(0)
            await channel.replay { await outbound.send($0) }
            let replay = try await outbound.next(1)
            try check(first.requestId == replay.requestId && first.callId == replay.callId,
                "reconnect retains original operation identity")
            let foreign = await channel.receive(reply(first, round: 2))
            try check(!foreign, "wrong execution round cannot settle a pending request")
            let accepted = await channel.receive(reply(first))
            try check(accepted, "exact reply accepted")
            let result = try await task.value
            try check(result.success && result.contentItems.first?["text"]?.string == "saved once", "result delivered to same callback")
            let duplicate = await channel.receive(reply(first))
            try check(!duplicate, "already settled reply stays idempotent")

            let cancelled = Task { try await channel.call(call("call_2"), taskId: "task_1", round: 2, attemptId: "attempt_2", send: { await outbound.send($0) }) }
            let pending = try await outbound.next(2)
            await channel.cancel(attemptId: "another_attempt")
            await channel.cancel(attemptId: "attempt_2")
            do { _ = try await cancelled.value; throw BridgeTestFailure(message: "cancelled callback succeeded") }
            catch CodexToolBridgeError.cancelled {}
            let late = await channel.receive(reply(pending))
            try check(!late, "late success cannot revive cancelled request")

            let timeout = CodexToolBridgeChannel(timeout: 0.02)
            do {
                _ = try await timeout.call(call(), taskId: "task_2", round: 1, attemptId: "attempt_timeout", send: { _ in false })
                throw BridgeTestFailure(message: "missing receipt silently succeeded")
            } catch CodexToolBridgeError.timedOut {}
            print("CodexToolBridgeTests: reconnect, exact reply, cancellation and deadline passed")
        } catch { fputs("CodexToolBridgeTests failed: \(error)\n", stderr); exit(1) }
    }
}
