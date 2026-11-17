import Foundation

struct CodexToolBridgeRequest: Encodable, Sendable {
    let type = "executor_tool_call"
    let taskId: String
    let round: Int
    let attemptId: String
    let requestId: String
    let threadId: String
    let turnId: String
    let callId: String
    let tool: String
    let arguments: CodexAppServerJSON
}

struct CodexToolBridgeReply: Decodable, Sendable {
    let taskId: String
    let round: Int
    let attemptId: String
    let requestId: String
    let threadId: String
    let turnId: String
    let callId: String
    let contentItems: [CodexAppServerJSON]
    let success: Bool
}

enum CodexToolBridgeError: Error, LocalizedError {
    case cancelled, timedOut, invalidResult, unavailable
    var errorDescription: String? {
        switch self {
        case .cancelled: return "本轮已停止，工具结果已留在原任务中。"
        case .timedOut: return "工具回执还没回来。已有调用记录已保留，恢复后会先查询原结果。"
        case .invalidResult: return "工具返回的结果暂时无法对应原调用，请核对任务记录。"
        case .unavailable: return "本机工具连接暂时不可用，原任务和调用编号已保留。"
        }
    }
}

// This channel belongs to one authenticated launcher runner. Reconnecting only
// resends the same request identity; ONE owns durable call deduplication.
actor CodexToolBridgeChannel {
    typealias Sender = @Sendable (CodexToolBridgeRequest) async -> Bool
    private struct Pending {
        let request: CodexToolBridgeRequest
        let continuation: CheckedContinuation<CodexDynamicToolResult, Error>
        let timer: Task<Void, Never>
    }
    private var pending: [String: Pending] = [:]
    private let timeout: TimeInterval

    init(timeout: TimeInterval = 180) { self.timeout = timeout }

    func call(_ call: CodexDynamicToolCall, taskId: String, round: Int, attemptId: String,
              send: @escaping Sender) async throws -> CodexDynamicToolResult {
        guard timeout.isFinite, timeout > 0, pending.count < 32 else { throw CodexToolBridgeError.unavailable }
        let requestId = "tool_" + UUID().uuidString.lowercased()
        let request = CodexToolBridgeRequest(taskId: taskId, round: round, attemptId: attemptId,
            requestId: requestId, threadId: call.threadId, turnId: call.turnId,
            callId: call.callId, tool: call.tool, arguments: call.arguments)
        return try await withTaskCancellationHandler(operation: {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                let timer = Task {
                    try? await Task.sleep(for: .seconds(timeout))
                    if !Task.isCancelled { expire(requestId) }
                }
                pending[requestId] = Pending(request: request, continuation: continuation, timer: timer)
                Task { _ = await send(request) }
            }
        }, onCancel: { Task { await self.cancel(requestId: requestId) } })
    }

    func receive(_ reply: CodexToolBridgeReply) -> Bool {
        guard let value = pending[reply.requestId], value.request.taskId == reply.taskId,
              value.request.round == reply.round, value.request.attemptId == reply.attemptId,
              value.request.threadId == reply.threadId, value.request.turnId == reply.turnId,
              value.request.callId == reply.callId else { return false }
        guard !reply.contentItems.isEmpty, reply.contentItems.allSatisfy({
            $0["type"]?.string == "inputText" && $0["text"]?.string != nil
        }), let bytes = try? JSONEncoder().encode(reply.contentItems), bytes.count <= 1536 * 1024 else {
            finish(reply.requestId, result: .failure(CodexToolBridgeError.invalidResult)); return false
        }
        finish(reply.requestId, result: .success(CodexDynamicToolResult(contentItems: reply.contentItems, success: reply.success)))
        return true
    }

    func replay(send: @escaping Sender) async {
        for value in Array(pending.values) {
            guard pending[value.request.requestId] != nil else { continue }
            _ = await send(value.request)
        }
    }

    func cancel(attemptId: String) {
        for value in Array(pending.values) where value.request.attemptId == attemptId {
            finish(value.request.requestId, result: .failure(CodexToolBridgeError.cancelled))
        }
    }

    private func cancel(requestId: String) {
        finish(requestId, result: .failure(CodexToolBridgeError.cancelled))
    }
    private func expire(_ requestId: String) {
        finish(requestId, result: .failure(CodexToolBridgeError.timedOut))
    }
    private func finish(_ requestId: String, result: Result<CodexDynamicToolResult, Error>) {
        guard let value = pending.removeValue(forKey: requestId) else { return }
        value.timer.cancel()
        value.continuation.resume(with: result)
    }
}
