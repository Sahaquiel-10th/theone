import Foundation
import Darwin

private typealias JSON = CodexAppServerJSON
private struct TestFailure: Error { let message: String }
private final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: TimeInterval = 100
    func now() -> TimeInterval { lock.lock(); defer { lock.unlock() }; return value }
    func advance(_ interval: TimeInterval) { lock.lock(); value += interval; lock.unlock() }
}
private actor WriterGate {
    private var continuation: CheckedContinuation<Void, Never>?
    func wait() async { await withCheckedContinuation { continuation = $0 } }
    func release() { continuation?.resume(); continuation = nil }
}
private func check(_ value: Bool, _ message: String) throws {
    if !value { throw TestFailure(message: message) }
}

private actor Fixture {
    var writes: [JSON] = []
    var events: [JSON] = []
    func send(_ line: String) throws { writes.append(try JSONDecoder().decode(JSON.self, from: Data(line.utf8))) }
    func event(_ line: String) { if let value = try? JSONDecoder().decode(JSON.self, from: Data(line.utf8)) { events.append(value) } }
    func request(_ method: String, occurrence: Int = 0) async throws -> JSON {
        let deadline = ProcessInfo.processInfo.systemUptime + 1
        while ProcessInfo.processInfo.systemUptime < deadline {
            let matches = writes.filter { $0["method"]?.string == method }
            if matches.count > occurrence { return matches[occurrence] }
            try await Task.sleep(for: .milliseconds(2))
        }
        throw TestFailure(message: "request absent: \(method)")
    }
    func methodCount(_ method: String) -> Int { writes.filter { $0["method"]?.string == method }.count }
    func lastWrite() -> JSON? { writes.last }
    func allEvents() -> [JSON] { events }
}

private func controller(_ fixture: Fixture, resume: String? = nil, timeout: TimeInterval = 1) throws -> CodexAppServerController {
    try CodexAppServerController(attemptId: "attempt_test_1", authorizedCWD: "/tmp/ONE-QA", resumeThreadId: resume,
        clientVersion: "0.4.19-test", requestTimeout: timeout,
        sendLine: { try await fixture.send($0) }, onExecEvent: { await fixture.event($0) })
}
private func receive(_ controller: CodexAppServerController, _ value: JSON) async throws { await controller.receive(line: try value.line()) }
private func reply(_ controller: CodexAppServerController, _ request: JSON, _ result: JSON = .object([:])) async throws {
    try await receive(controller, .object(["id": request["id"]!, "result": result]))
}
private func notification(_ controller: CodexAppServerController, _ method: String, turn: String = "turn_1", thread: String = "thread_1", fields: [String: JSON] = [:]) async throws {
    var params = fields
    params["threadId"] = .string(thread)
    if method == "turn/completed" || method == "turn/started" {
        if params["turn"] == nil { params["turn"] = .object(["id": .string(turn), "status": .string("inProgress"), "items": .array([])]) }
    } else { params["turnId"] = .string(turn) }
    try await receive(controller, .object(["method": .string(method), "params": .object(params)]))
}
private func command(_ id: String = "cmd_1", status: String = "inProgress", exit: JSON = .null) -> JSON {
    .object(["id": .string(id), "type": .string("commandExecution"), "status": .string(status), "exitCode": exit,
        "command": .string("fixture-only"), "aggregatedOutput": .string("test output")])
}
private func item(_ controller: CodexAppServerController, _ method: String, _ item: JSON, turn: String = "turn_1", thread: String = "thread_1") async throws {
    try await notification(controller, method, turn: turn, thread: thread, fields: ["item": item])
}
private func end(_ controller: CodexAppServerController, status: String, items: [JSON] = [], turn: String = "turn_1", thread: String = "thread_1") async throws {
    try await notification(controller, "turn/completed", turn: turn, thread: thread, fields: ["turn": .object([
        "id": .string(turn), "status": .string(status), "items": .array(items), "error": .null
    ])])
}
private func bootstrap(_ controller: CodexAppServerController, fixture: Fixture, resume: Bool = false,
                       instruction: String = "raw instruction", beforeTurnReply: (() async throws -> Void)? = nil) async throws -> JSON {
    let start = Task { try await controller.start(instruction: instruction) }
    try await reply(controller, fixture.request("initialize"))
    let thread = try await fixture.request(resume ? "thread/resume" : "thread/start")
    try await reply(controller, thread, .object(["thread": .object(["id": .string("thread_1")])]))
    let turn = try await fixture.request("turn/start")
    try await beforeTurnReply?()
    try await reply(controller, turn, .object(["turn": .object(["id": .string("turn_1"), "status": .string("inProgress"), "items": .array([])])]))
    _ = try await start.value
    return turn
}

private func normalAndPolicy() async throws {
    let fixture = Fixture(), actor = try controller(fixture, resume: "thread_1")
    let text = String(repeating: "原话🙂\n", count: 1500)
    let request = try await bootstrap(actor, fixture: fixture, resume: true, instruction: text)
    try check(request["params"]?["input"]?.array?.first?["text"]?.string == text, "raw instruction preserved")
    let policy = request["params"]?["sandboxPolicy"]
    try check(policy?["type"]?.string == "workspaceWrite", "workspace sandbox")
    try check(policy?["writableRoots"] == .array([.string("/tmp/ONE-QA")]), "only authorized root")
    try check(policy?["networkAccess"] == .bool(false), "network remains denied")
    try check(policy?["excludeTmpdirEnvVar"] == .bool(true) && policy?["excludeSlashTmp"] == .bool(true), "no implicit writable temp roots")
    try check(request["params"]?["approvalPolicy"]?.string == "never", "no extra grants")
    let initialization = try await fixture.request("initialize")
    try check(initialization["params"]?["capabilities"]?["experimentalApi"] == .bool(false), "experimental APIs off")
    let resumeRequest = try await fixture.request("thread/resume")
    try check(resumeRequest["params"]?["cwd"]?.string == "/tmp/ONE-QA" && resumeRequest["params"]?["approvalPolicy"]?.string == "never", "resume resets boundary")
    try check(CodexAppServerController.launchArguments == ["app-server", "--listen", "stdio://"], "stdio only")
    try await item(actor, "item/started", command())
    try await item(actor, "item/completed", command(status: "completed", exit: .number(0)))
    let answer: JSON = .object(["id": .string("msg_1"), "type": .string("agentMessage"), "text": .string("真实结果 /tmp/ONE-QA/result.md")])
    try await item(actor, "item/completed", answer)
    try await end(actor, status: "completed", items: [command(status: "completed", exit: .number(0)), answer])
    try check(try await actor.waitForTurnEnd(timeout: 0.1) == .completed, "turn barrier")
    let snapshot = await actor.snapshot()
    try check(snapshot.finalResponse == "真实结果 /tmp/ONE-QA/result.md", "final response retained")
    try check(!snapshot.hasUnconfirmedCommands && !snapshot.assessment(treeCleanupVerified: true).requiresCheck, "real command exit required")
    let events = await fixture.allEvents()
    try check(events.filter { $0["item"]?["id"]?.string == "msg_1" }.count == 1, "turn backfill does not duplicate answer")
    try check(!events.contains { $0["type"]?.string == "turn.completed" }, "no public terminal callback")
    do { _ = try await actor.start(instruction: "do not rerun"); throw TestFailure(message: "duplicate start accepted") }
    catch CodexAppServerError.alreadyStarted {}
    try check(await fixture.methodCount("turn/start") == 1, "one turn/start only")
}

private func exactCancellation() async throws {
    let fixture = Fixture(), actor = try controller(fixture)
    _ = try await bootstrap(actor, fixture: fixture)
    try await item(actor, "item/started", command())
    let a = Task { await actor.requestInterrupt(timeout: 0.5) }
    let b = Task { await actor.requestInterrupt(timeout: 0.5) }
    let stop = try await fixture.request("turn/interrupt")
    try check(stop["params"]?["threadId"]?.string == "thread_1" && stop["params"]?["turnId"]?.string == "turn_1", "exact interrupt identity")
    try await end(actor, status: "interrupted", items: [command(status: "failed", exit: .number(-1))])
    var snapshot = await actor.snapshot()
    try check(!snapshot.assessment(treeCleanupVerified: true).cancellationConfirmed, "terminal without matching ACK insufficient")
    try await receive(actor, .object(["id": .string("unrelated_ack"), "result": .object([:])]))
    snapshot = await actor.snapshot()
    try check(!snapshot.interruptAcknowledged, "unknown RPC id ignored")
    try await reply(actor, stop)
    let firstStop = await a.value, secondStop = await b.value
    try check(firstStop && secondStop, "same-turn terminal plus exact ACK")
    snapshot = await actor.snapshot()
    try check(!snapshot.assessment(treeCleanupVerified: false).cancellationConfirmed, "tree check independently required")
    let confirmed = snapshot.assessment(treeCleanupVerified: true)
    try check(confirmed.cancellationConfirmed && confirmed.commandsResolvedByInterrupt && !confirmed.requiresCheck, "cancelled command resolved, not successful")
    try check(snapshot.turnStatus == .interrupted && snapshot.hasUnconfirmedCommands, "raw missing exit not fabricated")
    try check(await fixture.methodCount("turn/interrupt") == 1, "concurrent stop sends once")
    try await end(actor, status: "completed")
    try check(await actor.snapshot().turnStatus == .interrupted, "late completion never overrides cancellation")
}

private func unknownCommandsStayUnknown() async throws {
    for mode in ["started_only", "boolean_exit", "fractional_exit", "missing_id", "changed_type", "missing_start", "running_terminal", "updated_only"] {
        let fixture = Fixture(), actor = try controller(fixture)
        _ = try await bootstrap(actor, fixture: fixture)
        if mode != "missing_start" { try await item(actor, "item/started", command()) }
        let task = Task { await actor.requestInterrupt(timeout: 0.5) }
        let stop = try await fixture.request("turn/interrupt")
        switch mode {
        case "boolean_exit": try await item(actor, "item/completed", command(status: "failed", exit: .bool(false)))
        case "fractional_exit": try await item(actor, "item/completed", command(status: "failed", exit: .number(0.5)))
        case "missing_id": try await item(actor, "item/completed", .object(["type": .string("commandExecution"), "status": .string("failed"), "exitCode": .null]))
        case "changed_type": try await item(actor, "item/completed", .object(["id": .string("cmd_1"), "type": .string("agentMessage"), "text": .string("not a command end")]))
        case "missing_start": try await item(actor, "item/completed", command(status: "failed", exit: .null))
        case "running_terminal": try await item(actor, "item/completed", command())
        case "updated_only": try await item(actor, "item/updated", command(status: "failed", exit: .null))
        default: break
        }
        try await reply(actor, stop)
        try await end(actor, status: "interrupted")
        _ = await task.value
        let assessment = await actor.snapshot().assessment(treeCleanupVerified: true)
        try check(assessment.requiresCheck && !assessment.cancellationConfirmed, "unknown must remain held: \(mode)")
    }
}

private func earlyAndForeignEvents() async throws {
    let fixture = Fixture(), actor = try controller(fixture)
    _ = try await bootstrap(actor, fixture: fixture, beforeTurnReply: {
        try await item(actor, "item/started", command(), turn: "old_turn")
        try await item(actor, "item/started", command())
        try await item(actor, "item/completed", command(status: "completed", exit: .number(0)))
        try await end(actor, status: "failed", thread: "other_thread")
    })
    try check(!(await actor.snapshot()).hasUnconfirmedCommands, "early events replay only exact thread/turn")
    try await end(actor, status: "completed", turn: "old_turn")
    try check(!(await actor.snapshot()).isTurnTerminal, "old turn cannot complete current")
    try await end(actor, status: "completed")
    try check(await actor.snapshot().turnStatus == .completed, "current exact terminal accepted")
}

private func stopBeforeDispatch() async throws {
    for phase in ["before_initialize", "during_initialize", "during_thread"] {
        let fixture = Fixture(), actor = try controller(fixture)
        if phase == "before_initialize" {
            _ = await actor.requestInterrupt()
            do { _ = try await actor.start(instruction: "never start"); throw TestFailure(message: "cancelled start") }
            catch CodexAppServerError.cancelledBeforeStart {}
        } else {
            let start = Task { try await actor.start(instruction: "never start") }
            let initRequest = try await fixture.request("initialize")
            if phase == "during_initialize" {
                _ = await actor.requestInterrupt()
                try await reply(actor, initRequest)
            } else {
                try await reply(actor, initRequest)
                let thread = try await fixture.request("thread/start")
                _ = await actor.requestInterrupt()
                try await reply(actor, thread, .object(["thread": .object(["id": .string("thread_1")])]))
            }
            do { _ = try await start.value; throw TestFailure(message: "cancelled bootstrap continued") }
            catch CodexAppServerError.cancelledBeforeStart {}
        }
        try check(await fixture.methodCount("turn/start") == 0, "prepare-only stop never sends task: \(phase)")
        try check(!(await actor.snapshot()).assessment(treeCleanupVerified: true).requiresCheck, "prepare-only stop settled")
    }
}

private func deadlinesAndEOF() async throws {
    let fixture = Fixture(), actor = try controller(fixture, timeout: 0.04)
    let start = Task { try await actor.start(instruction: "not sent") }
    let first = try await fixture.request("initialize")
    do { _ = try await start.value; throw TestFailure(message: "missing reply did not time out") }
    catch CodexAppServerError.timedOut {}
    try await reply(actor, first)
    try check(await fixture.methodCount("turn/start") == 0, "late initialization cannot dispatch")
    let f2 = Fixture(), a2 = try controller(f2)
    _ = try await bootstrap(a2, fixture: f2)
    let waiter = Task { try await a2.waitForTurnEnd(timeout: 1) }
    await a2.transportClosed()
    do { _ = try await waiter.value; throw TestFailure(message: "EOF waiter stayed pending") }
    catch CodexAppServerError.transportClosed {}
    try check((await a2.snapshot()).assessment(treeCleanupVerified: true).requiresCheck, "EOF without terminal unknown")
    try await end(a2, status: "completed")
    try check(!(await a2.snapshot()).isTurnTerminal, "after-EOF frame cannot revive transport")
    let f3 = Fixture(), a3 = try controller(f3)
    _ = try await bootstrap(a3, fixture: f3)
    let interrupt = Task { await a3.requestInterrupt(timeout: 0.04) }
    let request = try await f3.request("turn/interrupt")
    try check(!(await interrupt.value), "no ACK times out")
    try await reply(a3, request)
    try await end(a3, status: "interrupted")
    try check(!(await a3.snapshot()).interruptAcknowledged, "late ACK cannot unlock")
    try check((await a3.snapshot()).assessment(treeCleanupVerified: true).requiresCheck, "late ACK hold")
    let f4 = Fixture(), a4 = try controller(f4)
    _ = try await bootstrap(a4, fixture: f4)
    let lateTerminal = Task { await a4.requestInterrupt(timeout: 0.04) }
    try await reply(a4, f4.request("turn/interrupt"))
    try check(!(await lateTerminal.value), "ACK alone cannot pass deadline")
    try await end(a4, status: "interrupted")
    let lateSnapshot = await a4.snapshot()
    try check(lateSnapshot.interruptAcknowledged && !lateSnapshot.interruptCompletedWithinDeadline,
        "late terminal cannot retroactively confirm timed-out stop")
    try check(lateSnapshot.assessment(treeCleanupVerified: true).requiresCheck, "late pair remains unknown")
}

private func malformedProtocolReleasesWaiter() async throws {
    let fixture = Fixture(), actor = try controller(fixture)
    _ = try await bootstrap(actor, fixture: fixture)
    let waiter = Task { try await actor.waitForTurnEnd(timeout: 5) }
    try await item(actor, "item/started", .object(["id": .string("unknown_tool"), "type": .string("futureTool")]))
    do { _ = try await waiter.value; throw TestFailure(message: "unknown tool did not release waiter") }
    catch CodexAppServerError.invalidProtocol {}
    try check((await actor.snapshot()).assessment(treeCleanupVerified: true).requiresCheck, "unknown tool cannot disappear")
    do { _ = try await actor.waitForTurnEnd(timeout: 5); throw TestFailure(message: "new waiter ignored protocol failure") }
    catch CodexAppServerError.invalidProtocol {}
}

private func stopDuringTurnStart() async throws {
    let fixture = Fixture(), actor = try controller(fixture)
    let start = Task { try await actor.start(instruction: "sent once") }
    try await reply(actor, fixture.request("initialize"))
    try await reply(actor, fixture.request("thread/start"), .object(["thread": .object(["id": .string("thread_1")])]))
    let turnStart = try await fixture.request("turn/start")
    let stop = Task { await actor.requestInterrupt(timeout: 0.5) }
    try await reply(actor, turnStart, .object(["turn": .object(["id": .string("turn_1"), "status": .string("inProgress"), "items": .array([])])]))
    _ = try await start.value
    let interrupt = try await fixture.request("turn/interrupt")
    try await reply(actor, interrupt); try await end(actor, status: "interrupted")
    try check(await stop.value, "stop waits for exact pending turn identity")
    try check(await fixture.methodCount("turn/start") == 1, "stop never reissues task")
}

private func monotonicDeadlineAndStuckWriter() async throws {
    let clock = TestClock(), fixture = Fixture()
    let actor = try CodexAppServerController(attemptId: "attempt_clock", authorizedCWD: "/tmp/ONE-QA", clientVersion: "test",
        requestTimeout: 1, now: { clock.now() }, sendLine: { try await fixture.send($0) }, onExecEvent: { await fixture.event($0) })
    _ = try await bootstrap(actor, fixture: fixture)
    let stop = Task { await actor.requestInterrupt(timeout: 0.5) }
    try await reply(actor, fixture.request("turn/interrupt"))
    // Timer task is not due in wall time. A stalled caller can still not use a
    // terminal whose monotonic arrival is after the original deadline.
    clock.advance(1)
    try await end(actor, status: "interrupted")
    try check(!(await stop.value), "late terminal cannot win a delayed timer")
    try check((await actor.snapshot()).assessment(treeCleanupVerified: true).requiresCheck, "strict original deadline")

    let stalled = Fixture(), gate = WriterGate()
    let a2 = try CodexAppServerController(attemptId: "attempt_writer", authorizedCWD: "/tmp/ONE-QA", clientVersion: "test",
        requestTimeout: 0.04, sendLine: { line in
            try await stalled.send(line)
            let json = try JSONDecoder().decode(JSON.self, from: Data(line.utf8))
            if json["method"]?.string == "initialized" { await gate.wait() }
        }, onExecEvent: { await stalled.event($0) })
    let start = Task { try await a2.start(instruction: "never dispatched") }
    try await reply(a2, stalled.request("initialize"))
    do { _ = try await start.value; throw TestFailure(message: "stuck writer blocked deadline") }
    catch CodexAppServerError.timedOut {}
    await a2.transportClosed(); await gate.release()
    try await Task.sleep(for: .milliseconds(10))
    try check(await stalled.methodCount("turn/start") == 0, "late write cannot resume bootstrap")
}

private func serverRequestsDenied() async throws {
    for method in ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "mcpServer/elicitation/request", "item/tool/call", "item/permissions/requestApproval", "account/login/start"] {
        let fixture = Fixture(), actor = try controller(fixture)
        _ = try await bootstrap(actor, fixture: fixture)
        let requestID: JSON = .number(512)
        try await receive(actor, .object(["id": requestID, "method": .string(method), "params": .object([:])]))
        let writes = await fixture.writes
        let answer = writes.first { $0["id"] == requestID }
        try check(answer != nil, "request explicitly answered")
        if method.contains("requestApproval") && !method.contains("permissions") {
            try check(answer?["result"]?["decision"]?.string == "decline", "approval denied")
        } else if method == "mcpServer/elicitation/request" {
            try check(answer?["result"]?["action"]?.string == "decline", "elicitation denied")
        } else { try check(answer?["error"]?["code"]?.integer == -32601, "unknown operation not implemented") }
        let stop = try await fixture.request("turn/interrupt")
        try await reply(actor, stop); try await end(actor, status: "interrupted")
        let snapshot = await actor.snapshot()
        try check(snapshot.hasFailedTools && snapshot.failureReason == "unsupported_approval_or_tool", "denial retained as explicit failure")
        try check(await fixture.methodCount("turn/start") == 1, "unsupported request never creates another turn")
    }
}

private func missingCommandTerminalFailsNormalCompletion() async throws {
    let fixture = Fixture(), actor = try controller(fixture)
    _ = try await bootstrap(actor, fixture: fixture)
    try await item(actor, "item/started", command())
    try await item(actor, "item/completed", .object(["id": .string("answer"), "type": .string("agentMessage"), "text": .string("still waiting")]))
    try await end(actor, status: "completed", items: [command(status: "failed", exit: .number(-1))])
    let snapshot = await actor.snapshot()
    try check(snapshot.finalResponse == "still waiting" && snapshot.assessment(treeCleanupVerified: true).requiresCheck, "answer plus completed turn cannot hide unconfirmed command")
}

private func emptyInterrupted(_ actor: CodexAppServerController) async throws {
    try await notification(actor, "turn/completed", fields: ["turn": .object([
        "id": .string("turn_1"), "status": .string("interrupted"), "items": .array([]),
        "itemsView": .string("notLoaded"), "error": .null
    ])])
}

private func realShapeDelayedCommandTerminals() async throws {
    for exit in [JSON.number(-1), .null, .number(130)] {
        let fixture = Fixture(), actor = try controller(fixture)
        _ = try await bootstrap(actor, fixture: fixture)
        try await item(actor, "item/started", command())
        try await item(actor, "item/started", command()) // repeated progress for one command identity is not another task
        try await item(actor, "item/started", command("cmd_2"))
        try await item(actor, "item/completed", .object(["id": .string("before_stop"), "type": .string("agentMessage"), "text": .string("保留已返回的原话")]))
        let stop = Task { await actor.requestInterrupt(timeout: 0.5) }
        let sharedStop = Task { await actor.requestInterrupt(timeout: 0.5) }
        try await reply(actor, fixture.request("turn/interrupt"))
        try await emptyInterrupted(actor)
        try await Task.sleep(for: .milliseconds(10))
        var snapshot = await actor.snapshot()
        try check(snapshot.interruptAcknowledged && !snapshot.interruptCompletedWithinDeadline,
            "ACK + empty interrupted must leave shared stop worker waiting")
        try await item(actor, "item/completed", .object(["id": .string("late_answer"), "type": .string("agentMessage"), "text": .string("不得替换原话")]))
        try await item(actor, "item/completed", command(status: "failed", exit: exit))
        snapshot = await actor.snapshot()
        try check(!snapshot.interruptCompletedWithinDeadline, "one of two tool terminals cannot release shared future")
        try await item(actor, "item/completed", command("cmd_2", status: "failed", exit: .number(-1)))
        let first = await stop.value, second = await sharedStop.value
        try check(first && second, "known delayed command terminals release same stop future")
        snapshot = await actor.snapshot()
        try check(snapshot.turnStatus == .interrupted && snapshot.finalResponse == "保留已返回的原话", "late evidence changes neither cancelled turn nor answer")
        try check(snapshot.assessment(treeCleanupVerified: true).cancellationConfirmed, "pair + exact late terminals + tree confirmation")
        try check(!snapshot.assessment(treeCleanupVerified: false).cancellationConfirmed, "tree/EOF proof remains independent")
        let interrupts = await fixture.methodCount("turn/interrupt"), starts = await fixture.methodCount("turn/start")
        try check(interrupts == 1 && starts == 1,
            "late reconciliation never dispatches or sends duplicate interrupt")
        let events = await fixture.allEvents()
        try check(!events.contains { $0["item"]?["id"]?.string == "late_answer" }, "late answer never emitted")
        try check(!events.contains { $0["item"]?["type"]?.string == "command_execution" && $0["type"]?.string == "item.completed" },
            "post-terminal command receipt is internal evidence, not public progress")
        try await end(actor, status: "completed")
        try check(await actor.snapshot().turnStatus == .interrupted, "late successful turn cannot overwrite cancelled")
    }
}

private func lateCommandEvidenceMustBeExact() async throws {
    for mode in ["missing", "foreign_thread", "foreign_turn", "new_id", "new_start", "same_id_start", "new_tool", "wrong_type", "boolean_exit", "updated_only", "EOF"] {
        let fixture = Fixture(), actor = try controller(fixture)
        _ = try await bootstrap(actor, fixture: fixture)
        try await item(actor, "item/started", command())
        let stop = Task { await actor.requestInterrupt(timeout: 0.04) }
        try await reply(actor, fixture.request("turn/interrupt"))
        try await emptyInterrupted(actor)
        switch mode {
        case "foreign_thread": try await item(actor, "item/completed", command(status: "failed", exit: .number(-1)), thread: "other_thread")
        case "foreign_turn": try await item(actor, "item/completed", command(status: "failed", exit: .number(-1)), turn: "old_turn")
        case "new_id": try await item(actor, "item/completed", command("unseen_command", status: "failed", exit: .number(-1)))
        case "new_start": try await item(actor, "item/started", command("new_command"))
        case "same_id_start": try await item(actor, "item/started", command())
        case "new_tool": try await item(actor, "item/completed", .object(["id": .string("file_late"), "type": .string("fileChange"), "status": .string("completed"), "changes": .array([])]))
        case "wrong_type": try await item(actor, "item/completed", .object(["id": .string("cmd_1"), "type": .string("agentMessage"), "text": .string("not evidence")]))
        case "boolean_exit": try await item(actor, "item/completed", command(status: "failed", exit: .bool(false)))
        case "updated_only": try await item(actor, "item/updated", command(status: "failed", exit: .number(-1)))
        case "EOF": await actor.transportClosed()
        default: break
        }
        try check(!(await stop.value), "invalid late evidence must fail shared stop: \(mode)")
        var snapshot = await actor.snapshot()
        try check(snapshot.protocolIssue != nil && snapshot.assessment(treeCleanupVerified: true).requiresCheck,
            "invalid late evidence retains poisoned hold: \(mode)")
        try await item(actor, "item/completed", command(status: "failed", exit: .number(-1)))
        snapshot = await actor.snapshot()
        try check(!snapshot.interruptCompletedWithinDeadline && snapshot.assessment(treeCleanupVerified: true).requiresCheck,
            "a later valid terminal cannot revive failed stop: \(mode)")
    }
}

private func lateCommandUsesOriginalDeadline() async throws {
    let fixture = Fixture(), clock = TestClock()
    let actor = try CodexAppServerController(attemptId: "attempt_late_clock", authorizedCWD: "/tmp/ONE-QA", clientVersion: "test",
        now: { clock.now() }, sendLine: { try await fixture.send($0) }, onExecEvent: { await fixture.event($0) })
    _ = try await bootstrap(actor, fixture: fixture)
    try await item(actor, "item/started", command())
    let stop = Task { await actor.requestInterrupt(timeout: 0.05) }
    try await reply(actor, fixture.request("turn/interrupt")); try await emptyInterrupted(actor)
    clock.advance(1)
    try await item(actor, "item/completed", command(status: "failed", exit: .number(-1)))
    try check(!(await stop.value), "late command cannot renew original interrupt deadline")
    let snapshot = await actor.snapshot()
    try check(snapshot.interruptibleCommandCount == 0 && !snapshot.interruptCompletedWithinDeadline,
        "after-deadline command evidence is not adopted even if timer was delayed")
    try check(snapshot.assessment(treeCleanupVerified: true).requiresCheck, "expired stop retains hold")
}

@main private struct CodexAppServerTests {
    static func main() async {
        alarm(15)
        do {
            try await normalAndPolicy()
            try await exactCancellation()
            try await unknownCommandsStayUnknown()
            try await earlyAndForeignEvents()
            try await stopBeforeDispatch()
            try await deadlinesAndEOF()
            try await malformedProtocolReleasesWaiter()
            try await stopDuringTurnStart()
            try await monotonicDeadlineAndStuckWriter()
            try await serverRequestsDenied()
            try await missingCommandTerminalFailsNormalCompletion()
            try await realShapeDelayedCommandTerminals()
            try await lateCommandEvidenceMustBeExact()
            try await lateCommandUsesOriginalDeadline()
            print("CodexAppServerTests: 14 groups passed (mocked stdio only)")
        } catch { fputs("CodexAppServerTests failed: \(error)\n", stderr); exit(1) }
    }
}
