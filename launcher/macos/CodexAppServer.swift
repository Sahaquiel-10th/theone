import Foundation

// Pinned Codex 0.160.1 app-server, stdio only. The caller owns the one-attempt
// Process, isolated gateway environment, process-tree registration and EOF join.
// This controller never launches a command, grants an approval, or sends signals.
enum CodexAppServerJSON: Codable, Sendable, Equatable {
    case object([String: CodexAppServerJSON]), array([CodexAppServerJSON])
    case string(String), number(Double), bool(Bool), null

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let object = try? value.decode([String: Self].self) { self = .object(object) }
        else if let array = try? value.decode([Self].self) { self = .array(array) }
        else if let string = try? value.decode(String.self) { self = .string(string) }
        else if let bool = try? value.decode(Bool.self) { self = .bool(bool) }
        else { self = .number(try value.decode(Double.self)) }
    }
    func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .object(let object): try value.encode(object)
        case .array(let array): try value.encode(array)
        case .string(let string): try value.encode(string)
        case .number(let number): try value.encode(number)
        case .bool(let bool): try value.encode(bool)
        case .null: try value.encodeNil()
        }
    }
    subscript(_ key: String) -> Self? { if case .object(let value) = self { return value[key] }; return nil }
    var string: String? { if case .string(let value) = self { return value }; return nil }
    var object: [String: Self]? { if case .object(let value) = self { return value }; return nil }
    var array: [Self]? { if case .array(let value) = self { return value }; return nil }
    var integer: Int? {
        guard case .number(let value) = self, value.isFinite, value.rounded(.towardZero) == value,
              value >= Double(Int32.min), value <= Double(Int32.max) else { return nil }
        return Int(value)
    }
    func line() throws -> String { String(decoding: try JSONEncoder().encode(self), as: UTF8.self) }
}

enum CodexAppServerError: Error, LocalizedError, Sendable {
    case invalidConfiguration, alreadyStarted, cancelledBeforeStart, transportClosed
    case timedOut(String), requestRejected(String), invalidProtocol
    var errorDescription: String? {
        switch self {
        case .invalidConfiguration: return "本机执行配置无效，尚未发送任务。"
        case .alreadyStarted: return "这轮任务已发送，不会重复执行。"
        case .cancelledBeforeStart: return "已停止，本机任务尚未开始。"
        case .transportClosed: return "本机执行连接已结束，完成情况需要核对。"
        case .timedOut: return "本机执行器未及时确认，ONE 不会自动重跑。"
        case .requestRejected: return "本机执行器没有接受这次操作，ONE 不会自动重跑。"
        case .invalidProtocol: return "本机执行器返回的记录无法对应本轮任务，请先核对。"
        }
    }
}

enum CodexAppServerTurnStatus: String, Sendable {
    case notStarted, inProgress, completed, failed, interrupted
    var terminal: Bool { self != .inProgress }
}

struct CodexAppServerTurnIdentity: Sendable, Equatable {
    let attemptId: String
    let threadId: String
    let turnId: String
}

struct CodexAppServerAssessment: Sendable {
    let cancellationConfirmed: Bool
    let requiresCheck: Bool
    let commandsResolvedByInterrupt: Bool
}

struct CodexAppServerSnapshot: Sendable {
    let attemptId: String
    let threadId: String?
    let turnId: String?
    let turnStatus: CodexAppServerTurnStatus?
    let turnStartSent: Bool
    let finalResponse: String?
    let hasFailedTools: Bool
    let hasUnconfirmedCommands: Bool
    let unconfirmedCommandCount: Int
    let interruptibleCommandCount: Int
    let hasPendingOtherTools: Bool
    let protocolIssue: String?
    let failureReason: String?
    let interruptRequested: Bool
    let interruptAcknowledged: Bool
    let interruptCompletedWithinDeadline: Bool
    let transportEnded: Bool

    var isTurnTerminal: Bool { turnStatus?.terminal == true }

    // A PID disappearing is never enough. Missing/-1 command exits can only
    // become "interrupted" (never successful) after the official same-turn
    // terminal AND the exact RPC acknowledgement AND owned-tree cleanup.
    func assessment(treeCleanupVerified: Bool) -> CodexAppServerAssessment {
        let protocolClean = protocolIssue == nil
        let interrupted = interruptRequested && interruptAcknowledged && interruptCompletedWithinDeadline && turnStatus == .interrupted
        let covered = unconfirmedCommandCount == interruptibleCommandCount
        let cancelled = interrupted && treeCleanupVerified && protocolClean && covered && !hasPendingOtherTools
        let preparedOnly = turnStatus == .notStarted && !turnStartSent
        let unresolved = hasUnconfirmedCommands && !cancelled
        let check = !protocolClean || unresolved || hasPendingOtherTools || !isTurnTerminal
            || (turnStatus == .interrupted && !cancelled)
            || (interruptRequested && turnStartSent && !treeCleanupVerified)
            || (transportEnded && !isTurnTerminal && !preparedOnly)
        return CodexAppServerAssessment(cancellationConfirmed: cancelled, requiresCheck: check,
            commandsResolvedByInterrupt: cancelled && hasUnconfirmedCommands)
    }
}

actor CodexAppServerController {
    typealias SendLine = @Sendable (String) async throws -> Void
    typealias ExecEvent = @Sendable (String) async -> Void
    typealias InterruptAccepted = @Sendable () async -> Bool
    static let launchArguments = ["app-server", "--listen", "stdio://"]
    private struct Pending {
        let method: String
        let continuation: CheckedContinuation<CodexAppServerJSON, Error>
        let timeout: Task<Void, Never>
        let deadline: TimeInterval
    }
    private struct TurnWaiter {
        let continuation: CheckedContinuation<CodexAppServerTurnStatus, Error>
        let timeout: Task<Void, Never>
        let deadline: TimeInterval
    }
    private struct InterruptedCommandsWaiter {
        let continuation: CheckedContinuation<Bool, Never>
        let timeout: Task<Void, Never>
        let deadline: TimeInterval
    }
    private struct Command {
        var started = false
        var ended = false
        var interruptedCandidate = false
        var malformed = false
    }

    let attemptId: String
    private let cwd: String
    private let model: String
    private let resumeThreadId: String?
    private let clientVersion: String
    private let requestTimeout: TimeInterval
    private let now: @Sendable () -> TimeInterval
    private let sendLine: SendLine
    private let onExecEvent: ExecEvent
    private let onInterruptAccepted: InterruptAccepted
    private var sequence = 0
    private var pending: [String: Pending] = [:]
    private var turnWaiters: [UUID: TurnWaiter] = [:]
    private var started = false
    private var closed = false
    private var turnStartSent = false
    private var threadId: String?
    private var turnId: String?
    private var status: CodexAppServerTurnStatus?
    private var finalResponse: String?
    private var failedTools = false
    private var protocolIssue: String?
    private var failureReason: String?
    private var cancelRequested = false
    private var interruptACK = false
    private var interruptCompletedWithinDeadline = false
    private var interruptDeadline: TimeInterval?
    private var acceptingInterruptedCommandTerminals = false
    private var interruptedCommandsWaiter: InterruptedCommandsWaiter?
    private var interruptTask: Task<Bool, Never>?
    private var commands: [String: Command] = [:]
    private var itemTypes: [String: String] = [:]
    private var pendingOtherTools = Set<String>()
    private var completedItems = Set<String>()
    private var commandOutputs: [String: String] = [:]
    private var earlyFrames: [CodexAppServerJSON] = []
    private var earlyBytes = 0
    private var flushingEarlyFrames = false
    private var endingTurn = false

    init(attemptId: String, authorizedCWD: String, model: String = "one-executor", resumeThreadId: String? = nil,
         clientVersion: String, requestTimeout: TimeInterval = 10,
         now: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
         onInterruptAccepted: @escaping InterruptAccepted = { true },
         sendLine: @escaping SendLine, onExecEvent: @escaping ExecEvent) throws {
        guard Self.validID(attemptId), authorizedCWD.hasPrefix("/"), !authorizedCWD.contains("\0"),
              URL(fileURLWithPath: authorizedCWD).standardizedFileURL.path == authorizedCWD,
              model == "one-executor", requestTimeout.isFinite, requestTimeout > 0,
              resumeThreadId.map(Self.validID) ?? true else { throw CodexAppServerError.invalidConfiguration }
        self.attemptId = attemptId; cwd = authorizedCWD; self.model = model
        self.resumeThreadId = resumeThreadId; self.clientVersion = clientVersion
        self.requestTimeout = requestTimeout; self.sendLine = sendLine; self.onExecEvent = onExecEvent
        self.now = now; self.onInterruptAccepted = onInterruptAccepted
    }

    func start(instruction: String) async throws -> CodexAppServerTurnIdentity {
        guard !started else { throw CodexAppServerError.alreadyStarted }
        started = true
        try ensureMayStart()
        _ = try await request("initialize", params: .object([
            "clientInfo": .object(["name": .string("one_launcher"), "title": .string("ONE"), "version": .string(clientVersion)]),
            "capabilities": .object(["experimentalApi": .bool(false)])
        ]))
        try ensureMayStart()
        try await send(.object(["method": .string("initialized")]))
        try ensureMayStart()
        var threadParams: [String: CodexAppServerJSON] = [
            "model": .string(model), "cwd": .string(cwd), "approvalPolicy": .string("never"),
            "sandbox": .string("workspace-write")
        ]
        let method = resumeThreadId == nil ? "thread/start" : "thread/resume"
        if let resumeThreadId { threadParams["threadId"] = .string(resumeThreadId); threadParams["excludeTurns"] = .bool(true) }
        let thread = try await request(method, params: .object(threadParams))
        guard let id = thread["thread"]?["id"]?.string, Self.validID(id), resumeThreadId == nil || id == resumeThreadId else {
            poison("thread_identity_invalid"); throw CodexAppServerError.invalidProtocol
        }
        threadId = id
        await emit(.object(["type": .string("thread.started"), "thread_id": .string(id)]))
        try ensureMayStart()
        // The raw instruction is sent once, never truncated or regenerated.
        turnStartSent = true
        let turn = try await request("turn/start", params: .object([
            "threadId": .string(id), "input": .array([.object(["type": .string("text"), "text": .string(instruction), "text_elements": .array([])])]),
            "model": .string(model), "cwd": .string(cwd), "approvalPolicy": .string("never"),
            "sandboxPolicy": .object(["type": .string("workspaceWrite"), "writableRoots": .array([.string(cwd)]),
                "networkAccess": .bool(false), "excludeTmpdirEnvVar": .bool(true), "excludeSlashTmp": .bool(true)])
        ]))
        guard let newTurn = turn["turn"], let newID = newTurn["id"]?.string, Self.validID(newID),
              newTurn["status"]?.string == "inProgress" else {
            poison("turn_identity_invalid"); throw CodexAppServerError.invalidProtocol
        }
        turnId = newID; status = .inProgress
        flushingEarlyFrames = true
        while !earlyFrames.isEmpty {
            let frame = earlyFrames.removeFirst()
            await notification(frame)
        }
        earlyBytes = 0; flushingEarlyFrames = false
        return CodexAppServerTurnIdentity(attemptId: attemptId, threadId: id, turnId: newID)
    }

    // Called by the one owned stdout reader, in line order. No other stream is
    // accepted here. The Process/attempt binding must not change for this actor.
    func receive(line: String) async {
        guard !closed else { return }
        guard line.utf8.count <= 2 * 1024 * 1024, let bytes = line.data(using: .utf8),
              let value = try? JSONDecoder().decode(CodexAppServerJSON.self, from: bytes), value.object != nil else {
            poison("malformed_message"); return
        }
        if let method = value["method"]?.string {
            if let id = value["id"], id != .null { await rejectServerRequest(method: method, id: id); return }
            if turnStartSent && (turnId == nil || flushingEarlyFrames) && Self.scopedMethods.contains(method) {
                guard earlyFrames.count < 512, earlyBytes + bytes.count <= 2 * 1024 * 1024 else {
                    poison("early_event_limit"); return
                }
                earlyFrames.append(value); earlyBytes += bytes.count; return
            }
            await notification(value)
            return
        }
        guard let id = value["id"]?.string, let waiting = pending.removeValue(forKey: id) else { return }
        waiting.timeout.cancel()
        if now() > waiting.deadline {
            waiting.continuation.resume(throwing: CodexAppServerError.timedOut(waiting.method))
        } else if value["error"] != nil {
            waiting.continuation.resume(throwing: CodexAppServerError.requestRejected(waiting.method))
        } else if let result = value["result"], result.object != nil {
            waiting.continuation.resume(returning: result)
        } else {
            poison("malformed_response")
            waiting.continuation.resume(throwing: CodexAppServerError.invalidProtocol)
        }
    }

    func requestInterrupt(timeout: TimeInterval = 5) async -> Bool {
        cancelRequested = true
        if !turnStartSent {
            status = .notStarted; resolveTurnWaiters(); return true
        }
        if let interruptTask {
            let confirmed = await interruptTask.value
            if !confirmed { poison("interrupt_confirmation_failed") }
            return confirmed
        }
        let task = Task { await self.performInterrupt(timeout: timeout) }
        interruptTask = task
        let confirmed = await task.value
        if !confirmed { poison("interrupt_confirmation_failed") }
        return confirmed
    }

    // Must be called on actual stdio EOF/closed transport, not merely WS loss.
    func transportClosed() {
        guard !closed else { return }; closed = true
        finishInterruptedCommandsWaiter(confirmed: false)
        let requests = Array(pending.values); pending = [:]
        requests.forEach { $0.timeout.cancel(); $0.continuation.resume(throwing: CodexAppServerError.transportClosed) }
        if status?.terminal != true {
            let waiters = Array(turnWaiters.values); turnWaiters = [:]
            waiters.forEach { $0.timeout.cancel(); $0.continuation.resume(throwing: CodexAppServerError.transportClosed) }
        }
    }

    func waitForTurnEnd(timeout: TimeInterval = 900) async throws -> CodexAppServerTurnStatus {
        guard protocolIssue == nil else { throw CodexAppServerError.invalidProtocol }
        if let status, status.terminal { return status }
        guard !closed else { throw CodexAppServerError.transportClosed }
        guard timeout.isFinite, timeout > 0 else { throw CodexAppServerError.timedOut("turn/completed") }
        let id = UUID()
        return try await withTaskCancellationHandler(operation: {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                let timer = Task { try? await Task.sleep(for: .seconds(timeout)); if !Task.isCancelled { self.expireTurnWaiter(id) } }
                turnWaiters[id] = TurnWaiter(continuation: continuation, timeout: timer,
                    deadline: now() + timeout)
            }
        }, onCancel: { Task { await self.cancelTurnWaiter(id) } })
    }

    func snapshot() -> CodexAppServerSnapshot {
        let unknown = commands.values.filter { !$0.ended || $0.malformed }
        return CodexAppServerSnapshot(attemptId: attemptId, threadId: threadId, turnId: turnId,
            turnStatus: status, turnStartSent: turnStartSent, finalResponse: finalResponse,
            hasFailedTools: failedTools, hasUnconfirmedCommands: !unknown.isEmpty,
            unconfirmedCommandCount: unknown.count,
            interruptibleCommandCount: unknown.filter { $0.started && $0.interruptedCandidate && !$0.malformed }.count,
            hasPendingOtherTools: !pendingOtherTools.isEmpty, protocolIssue: protocolIssue,
            failureReason: failureReason, interruptRequested: cancelRequested,
            interruptAcknowledged: interruptACK, interruptCompletedWithinDeadline: interruptCompletedWithinDeadline, transportEnded: closed)
    }

    private func performInterrupt(timeout: TimeInterval) async -> Bool {
        guard timeout.isFinite, timeout > 0 else { return false }
        let deadline = now() + timeout
        interruptDeadline = deadline; acceptingInterruptedCommandTerminals = true
        defer { acceptingInterruptedCommandTerminals = false }
        while turnId == nil, !closed, now() < deadline {
            try? await Task.sleep(for: .milliseconds(10))
        }
        guard let threadId, let turnId, !closed else { return false }
        do {
            let remaining = deadline - now()
            guard remaining > 0 else { return false }
            let result = try await request("turn/interrupt", params: .object(["threadId": .string(threadId), "turnId": .string(turnId)]), timeout: remaining)
            guard result.object?.isEmpty == true, now() <= deadline else { return false }
            interruptACK = true
            if status != .interrupted {
                let left = deadline - now()
                guard left > 0, try await waitForTurnEnd(timeout: left) == .interrupted else { return false }
            }
            // An interrupted turn can leave a unified-exec shell running.
            // Stop only this attempt's owned descendants while keeping the
            // app-server alive for its command terminals. Never spend a new
            // timeout budget or accept the hook alone as cancellation proof.
            let hookTime = deadline - now(), hook = onInterruptAccepted
            guard hookTime > 0, protocolIssue == nil, !closed else { return false }
            try await codexAppServerBoundedSend(timeout: hookTime) {
                guard await hook() else { throw CodexAppServerError.invalidProtocol }
            }
            guard now() <= deadline, protocolIssue == nil, !closed else { return false }
            // 0.160.1 interrupted notifications intentionally contain no
            // items. Canonical command item/completed can follow the turn by
            // a few milliseconds. Keep stdin open until those exact already-
            // started commands settle, within this SAME original deadline.
            let settled = await waitForInterruptedCommandTerminals(deadline: deadline)
            interruptCompletedWithinDeadline = settled && now() <= deadline && protocolIssue == nil && !closed
            return interruptCompletedWithinDeadline
        } catch { return false }
    }

    private var interruptedCommandsSettled: Bool {
        pendingOtherTools.isEmpty && commands.values.allSatisfy {
            $0.started && !$0.malformed && ($0.ended || $0.interruptedCandidate)
        }
    }
    private func waitForInterruptedCommandTerminals(deadline: TimeInterval) async -> Bool {
        guard !closed, protocolIssue == nil, status == .interrupted, now() <= deadline else { return false }
        if interruptedCommandsSettled { return true }
        let remaining = deadline - now()
        guard remaining > 0 else { return false }
        return await withCheckedContinuation { continuation in
            let timer = Task {
                try? await Task.sleep(for: .seconds(remaining))
                if !Task.isCancelled { self.finishInterruptedCommandsWaiter(confirmed: false) }
            }
            interruptedCommandsWaiter = InterruptedCommandsWaiter(continuation: continuation, timeout: timer, deadline: deadline)
        }
    }
    private func finishInterruptedCommandsWaiter(confirmed: Bool) {
        guard let waiter = interruptedCommandsWaiter else { return }
        interruptedCommandsWaiter = nil; waiter.timeout.cancel()
        waiter.continuation.resume(returning: confirmed && now() <= waiter.deadline && !closed && protocolIssue == nil)
    }

    private func ensureMayStart() throws {
        if cancelRequested { throw CodexAppServerError.cancelledBeforeStart }
        if closed { throw CodexAppServerError.transportClosed }
        if protocolIssue != nil { throw CodexAppServerError.invalidProtocol }
    }
    private func request(_ method: String, params: CodexAppServerJSON, timeout: TimeInterval? = nil) async throws -> CodexAppServerJSON {
        guard !closed else { throw CodexAppServerError.transportClosed }
        sequence += 1
        let id = "one-\(attemptId)-\(sequence)", limit = timeout ?? requestTimeout
        let line = try CodexAppServerJSON.object(["id": .string(id), "method": .string(method), "params": params]).line()
        return try await withTaskCancellationHandler(operation: {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                let timer = Task { try? await Task.sleep(for: .seconds(limit)); if !Task.isCancelled { self.expireRequest(id, method: method) } }
                pending[id] = Pending(method: method, continuation: continuation, timeout: timer,
                    deadline: now() + limit)
                Task {
                    guard self.pending[id] != nil, !self.closed else { return }
                    do { try await self.sendLine(line) }
                    catch { self.failRequest(id, error: CodexAppServerError.transportClosed) }
                }
            }
        }, onCancel: { Task { await self.failRequest(id, error: CancellationError()) } })
    }
    private func expireRequest(_ id: String, method: String) { failRequest(id, error: CodexAppServerError.timedOut(method)) }
    private func failRequest(_ id: String, error: Error) {
        guard let value = pending.removeValue(forKey: id) else { return }
        value.timeout.cancel(); value.continuation.resume(throwing: error)
    }
    private func expireTurnWaiter(_ id: UUID) {
        guard let value = turnWaiters.removeValue(forKey: id) else { return }
        value.continuation.resume(throwing: CodexAppServerError.timedOut("turn/completed"))
    }
    private func cancelTurnWaiter(_ id: UUID) {
        guard let value = turnWaiters.removeValue(forKey: id) else { return }
        value.timeout.cancel(); value.continuation.resume(throwing: CancellationError())
    }
    private func resolveTurnWaiters() {
        guard let status, status.terminal else { return }
        let values = Array(turnWaiters.values); turnWaiters = [:]
        let currentTime = now()
        values.forEach {
            $0.timeout.cancel()
            if currentTime > $0.deadline { $0.continuation.resume(throwing: CodexAppServerError.timedOut("turn/completed")) }
            else { $0.continuation.resume(returning: status) }
        }
    }
    private func send(_ value: CodexAppServerJSON) async throws {
        let line = try value.line(), writer = sendLine
        try await codexAppServerBoundedSend(timeout: requestTimeout) { try await writer(line) }
    }
    private func emit(_ value: CodexAppServerJSON) async { if let line = try? value.line() { await onExecEvent(line) } }

    private func rejectServerRequest(method: String, id: CodexAppServerJSON) async {
        failedTools = true; failureReason = "unsupported_approval_or_tool"
        // No accept/acceptForSession, permission amendment or executable tool
        // implementation exists. Unknown requests get a JSON-RPC error.
        let result: CodexAppServerJSON
        switch method {
        case "item/commandExecution/requestApproval", "item/fileChange/requestApproval":
            result = .object(["id": id, "result": .object(["decision": .string("decline")])])
        case "mcpServer/elicitation/request":
            result = .object(["id": id, "result": .object(["action": .string("decline"), "content": .null, "_meta": .null])])
        default:
            result = .object(["id": id, "error": .object(["code": .number(-32601), "message": .string("ONE does not grant this request")])])
        }
        do { try await send(result) } catch { poison("denial_delivery_failed") }
        await emit(.object(["type": .string("error"), "message": .string("这项操作需要额外授权，ONE 没有扩大权限，本轮不会算作完成。")]))
        // Stopping is safe; starting a replacement task or granting anything is not.
        Task { _ = await self.requestInterrupt() }
    }

    private static let scopedMethods: Set<String> = ["turn/started", "turn/completed", "item/started", "item/completed", "item/updated",
        "item/agentMessage/delta", "item/commandExecution/outputDelta", "error"]
    private func notification(_ value: CodexAppServerJSON) async {
        guard let method = value["method"]?.string, Self.scopedMethods.contains(method),
              let params = value["params"], params.object != nil else { return }
        guard let threadId, let turnId, params["threadId"]?.string == threadId else { return }
        let frameTurn = method == "turn/started" || method == "turn/completed" ? params["turn"]?["id"]?.string : params["turnId"]?.string
        guard frameTurn == turnId else { return }
        if status == .interrupted {
            await interruptedCommandTerminal(method: method, params: params)
            return
        }
        // Terminal first-wins; stale progress must never replace it.
        guard status == .inProgress, !endingTurn else { return }
        if method == "turn/completed" {
            guard let turn = params["turn"], let rawStatus = turn["status"]?.string,
                  let end = CodexAppServerTurnStatus(rawValue: rawStatus), [.completed, .failed, .interrupted].contains(end),
                  let items = turn["items"]?.array else { poison("malformed_turn_terminal"); return }
            endingTurn = true
            for item in items { await handleItem(item, event: "item.completed", terminalBackfill: true) }
            status = end
            if end == .failed {
                failedTools = true
                await emit(.object(["type": .string("turn.failed"), "error": .object(["message": turn["error"]?["message"] ?? .string("本轮执行未完成")])]))
            }
            resolveTurnWaiters(); return
        }
        if method == "error" {
            failedTools = true
            await emit(.object(["type": .string("error"), "message": params["error"]?["message"] ?? .string("本机执行器返回错误")]))
        } else if method == "item/started" || method == "item/completed" || method == "item/updated" {
            guard let item = params["item"] else { poison("missing_item"); return }
            await handleItem(item, event: method.replacingOccurrences(of: "/", with: "."), terminalBackfill: false)
        } else if method == "item/commandExecution/outputDelta" {
            guard let id = params["itemId"]?.string, let delta = params["delta"]?.string, commands[id]?.started == true else {
                poison("uncorrelated_command_output"); return
            }
            let output = String(((commandOutputs[id] ?? "") + delta).suffix(6000)); commandOutputs[id] = output
            await emit(.object(["type": .string("item.updated"), "item": .object(["id": .string(id), "type": .string("command_execution"),
                "status": .string("in_progress"), "aggregated_output": .string(output)])]))
        }
    }

    private func interruptedCommandTerminal(method: String, params: CodexAppServerJSON) async {
        guard cancelRequested, acceptingInterruptedCommandTerminals, protocolIssue == nil,
              let deadline = interruptDeadline, now() <= deadline, !closed else { return }
        // No late answer, progress, new command or other tool can alter this
        // turn. Only terminal evidence for a command observed BEFORE the turn
        // ended may settle its existing record; the turn itself stays cancelled.
        guard ["item/started", "item/completed"].contains(method) else { return }
        guard let item = params["item"], let id = item["id"]?.string,
              let type = item["type"]?.string else { poison("malformed_late_item"); return }
        if type == "agentMessage", itemTypes[id] != "commandExecution" { return }
        guard method == "item/completed", type == "commandExecution", itemTypes[id] == type,
              commands[id]?.started == true else { poison("uncorrelated_late_command_terminal"); return }
        await handleItem(item, event: "item.completed", terminalBackfill: false, emitEvent: false)
        if commands[id]?.malformed == true { poison("malformed_late_command_terminal"); return }
        if interruptedCommandsSettled { finishInterruptedCommandsWaiter(confirmed: true) }
    }

    private func handleItem(_ item: CodexAppServerJSON, event: String, terminalBackfill: Bool, emitEvent: Bool = true) async {
        guard let type = item["type"]?.string, let id = item["id"]?.string, Self.validID(id) else { poison("malformed_item"); return }
        let allowed = ["userMessage", "hookPrompt", "agentMessage", "functionCallOutput", "plan", "reasoning", "commandExecution",
            "fileChange", "mcpToolCall", "collabAgentToolCall", "webSearch", "imageView", "enteredReviewMode", "exitedReviewMode", "contextCompaction"]
        guard allowed.contains(type) else { poison("unsupported_execution_item"); return }
        if let previous = itemTypes[id], previous != type { poison("item_type_changed"); return }
        itemTypes[id] = type
        if completedItems.contains(id) { return }
        if type == "commandExecution" {
            var command = commands[id] ?? Command()
            let rawStatus = item["status"]?.string
            if event == "item.started" {
                if rawStatus == "inProgress" { command.started = true }
                else { command.malformed = true }
            } else if event == "item.completed" {
                if let exit = item["exitCode"]?.integer, exit >= 0, ["completed", "failed"].contains(rawStatus ?? ""), command.started {
                    command.ended = true; if exit != 0 || rawStatus == "failed" { failedTools = true }
                } else if rawStatus == "failed", command.started,
                          item["exitCode"] == .null || item["exitCode"]?.integer == -1 {
                    command.interruptedCandidate = true
                } else { command.malformed = true }
                if !command.started { command.malformed = true }
            }
            commands[id] = command
        } else if ["fileChange", "mcpToolCall", "collabAgentToolCall", "dynamicToolCall"].contains(type) {
            if event == "item.started" { pendingOtherTools.insert(id) }
            if event == "item.completed" {
                guard ["completed", "failed", "declined", "interrupted"].contains(item["status"]?.string ?? "") else {
                    poison("malformed_tool_terminal"); return
                }
                pendingOtherTools.remove(id)
                if item["status"]?.string != "completed" { failedTools = true }
            }
        }
        let map = ["agentMessage": "agent_message", "commandExecution": "command_execution", "fileChange": "file_change",
            "mcpToolCall": "mcp_tool_call", "collabAgentToolCall": "collab_tool_call", "reasoning": "reasoning", "webSearch": "web_search"]
        guard let mappedType = map[type] else { return }
        if type == "agentMessage", event == "item.completed", let text = item["text"]?.string {
            finalResponse = String(text.prefix(120000))
        }
        var adapted = item.object ?? [:]
        adapted["type"] = .string(mappedType)
        if type == "commandExecution" {
            adapted["exit_code"] = item["exitCode"] ?? .null
            adapted["aggregated_output"] = item["aggregatedOutput"] ?? .string(commandOutputs[id] ?? "")
            if item["status"]?.string == "inProgress" { adapted["status"] = .string("in_progress") }
        }
        // Backfill only unfinished items. Never replay already completed answers.
        if event == "item.completed" { completedItems.insert(id) }
        if emitEvent { await emit(.object(["type": .string(event), "item": .object(adapted)])) }
    }
    private static func validID(_ id: String) -> Bool {
        !id.isEmpty && id.utf8.count <= 200 && id.utf8.allSatisfy {
            (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95
        }
    }
    private func poison(_ reason: String) {
        if protocolIssue == nil { protocolIssue = reason }
        finishInterruptedCommandsWaiter(confirmed: false)
        let requests = Array(pending.values); pending = [:]
        let waiters = Array(turnWaiters.values); turnWaiters = [:]
        requests.forEach { $0.timeout.cancel(); $0.continuation.resume(throwing: CodexAppServerError.invalidProtocol) }
        waiters.forEach { $0.timeout.cancel(); $0.continuation.resume(throwing: CodexAppServerError.invalidProtocol) }
    }
}

private final class CodexAppServerSendOutcome: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, Error>?
    private var result: Result<Void, Error>?
    func install(_ value: CheckedContinuation<Void, Error>) {
        lock.lock()
        if let result { lock.unlock(); value.resume(with: result); return }
        continuation = value; lock.unlock()
    }
    func resolve(_ value: Result<Void, Error>) {
        lock.lock()
        guard result == nil else { lock.unlock(); return }
        result = value; let waiter = continuation; continuation = nil; lock.unlock()
        waiter?.resume(with: value)
    }
}

// Do not task-group race an arbitrary Foundation writer: it may ignore cancel.
// Returning a timeout does not authorize retry; caller must close/join its own
// Process and retain unknown if turn/start might already have reached it.
private func codexAppServerBoundedSend(timeout: TimeInterval,
    work: @escaping @Sendable () async throws -> Void) async throws {
    let outcome = CodexAppServerSendOutcome()
    let deadline = ProcessInfo.processInfo.systemUptime + timeout
    let worker = Task {
        do {
            try await work()
            if ProcessInfo.processInfo.systemUptime > deadline { throw CodexAppServerError.timedOut("stdio") }
            outcome.resolve(.success(()))
        } catch { outcome.resolve(.failure(error)) }
    }
    let timer = Task {
        try? await Task.sleep(for: .seconds(timeout))
        if !Task.isCancelled { outcome.resolve(.failure(CodexAppServerError.timedOut("stdio"))) }
    }
    defer { worker.cancel(); timer.cancel() }
    try await withTaskCancellationHandler(operation: {
        try Task.checkCancellation()
        try await withCheckedThrowingContinuation { outcome.install($0) }
    }, onCancel: { outcome.resolve(.failure(CancellationError())) })
}
