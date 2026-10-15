import Foundation
import Darwin

// Real pipes and owned child processes, but a deterministic FAKE app-server.
// No Codex/model/account, user directory or user instruction is used. This is
// not real ONE acceptance and cannot establish official-Codex tool behavior.
private typealias ProtocolJSON = CodexAppServerJSON
private struct IntegrationFailure: Error { let message: String }
private func require(_ value: Bool, _ message: String) throws {
    if !value { throw IntegrationFailure(message: message) }
}
private func uptime() -> TimeInterval { ProcessInfo.processInfo.systemUptime }

private final class PipeEvidence: @unchecked Sendable {
    private let lock = NSLock()
    private var exitAt: TimeInterval?
    private var stdoutAt: TimeInterval?
    private var stderrAt: TimeInterval?
    private var errorText = ""
    private var writeError: String?
    private var eventCount = 0
    func exited() { lock.lock(); exitAt = uptime(); lock.unlock() }
    func stdoutEOF() { lock.lock(); stdoutAt = uptime(); lock.unlock() }
    func stderrEOF() { lock.lock(); stderrAt = uptime(); lock.unlock() }
    func stderr(_ text: String) { lock.lock(); errorText = String((errorText + text).suffix(8000)); lock.unlock() }
    func event() { lock.lock(); eventCount += 1; lock.unlock() }
    func inputFailed(_ error: Error) { lock.lock(); writeError = String(describing: error); lock.unlock() }
    var barriers: Bool { lock.lock(); defer { lock.unlock() }; return exitAt != nil && stdoutAt != nil && stderrAt != nil }
    var stdoutEnded: Bool { lock.lock(); defer { lock.unlock() }; return stdoutAt != nil }
    var processEnded: Bool { lock.lock(); defer { lock.unlock() }; return exitAt != nil }
    var stderrText: String { lock.lock(); defer { lock.unlock() }; return errorText }
    var inputFailure: String? { lock.lock(); defer { lock.unlock() }; return writeError }
    func summary() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        return ["processExit": exitAt as Any, "stdoutEOF": stdoutAt as Any,
            "stderrEOF": stderrAt as Any, "events": eventCount, "stderr": errorText, "inputFailure": writeError as Any]
            .mapValues { value in
                let mirror = Mirror(reflecting: value)
                return mirror.displayStyle == .optional && mirror.children.isEmpty ? NSNull() : value
            }
    }
}

private func temporaryEvidenceDirectory() throws -> URL {
    var template = Array((NSTemporaryDirectory() + "one-appserver-integration-XXXXXX").utf8CString)
    let path: String? = template.withUnsafeMutableBufferPointer { buffer in
        guard let base = buffer.baseAddress, let made = mkdtemp(base) else { return nil }
        return String(cString: made)
    }
    guard let path else { throw IntegrationFailure(message: "mkdtemp failed") }
    return URL(fileURLWithPath: path, isDirectory: true)
}
private func writeEvidence(_ directory: URL, _ name: String, _ text: String) {
    let url = directory.appendingPathComponent(name)
    FileManager.default.createFile(atPath: url.path, contents: Data(text.utf8), attributes: [.posixPermissions: 0o600])
}
private func readEvidence(_ directory: URL, _ name: String) -> String {
    (try? String(contentsOf: directory.appendingPathComponent(name), encoding: .utf8)) ?? ""
}

private final class ProtocolHarness: @unchecked Sendable {
    let directory: URL
    let process: Process
    let writer: CodexAppServerInput
    let controller: CodexAppServerController
    let tree: CodexProcessTree
    let evidence: PipeEvidence
    let exit: Task<Int32, Never>
    let output: Task<Void, Never>
    let errors: Task<Void, Never>

    init(root: URL, name: String, mode: String, writeTimeout: Duration = .seconds(1)) throws {
        let directory = root.appendingPathComponent(name, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let process = Process(), stdin = Pipe(), stdout = Pipe(), stderr = Pipe(), state = PipeEvidence()
        let writer = try CodexAppServerInput(fileHandle: stdin.fileHandleForWriting, timeout: writeTimeout)
        let controller = try CodexAppServerController(attemptId: "attempt_\(name)", authorizedCWD: directory.path,
            clientVersion: "fixture-test", requestTimeout: 3,
            sendLine: { line in
                do { try await writer.sendLine(line) }
                catch { state.inputFailed(error); throw error }
            }, onExecEvent: { _ in state.event() })
        process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
        process.arguments = ["--fake-protocol", mode, directory.path]
        process.environment = ["PATH": "/usr/bin:/bin", "LANG": "C", "TMPDIR": directory.path]
        process.currentDirectoryURL = directory
        process.standardInput = stdin; process.standardOutput = stdout; process.standardError = stderr
        let processExit = CodexProcessExit(process: process)
        try process.run()
        let tree: CodexProcessTree
        do {
            tree = try CodexProcessTree.begin(rootPID: process.processIdentifier, attemptId: "attempt_\(name)",
                timing: CodexProcessTreeTiming(interruptGrace: 0.15, killConfirmation: 1, observationInterval: 0.01))
        } catch {
            writer.close(); if process.isRunning { process.terminate() }; throw error
        }
        // The parent must not keep duplicate child-side pipe ends open, or an
        // actual child EOF/EPIPE cannot be observed correctly.
        try? stdin.fileHandleForReading.close()
        try? stdout.fileHandleForWriting.close(); try? stderr.fileHandleForWriting.close()
        let exit = Task { let status = await processExit.value(); state.exited(); return status }
        let output = Task.detached {
            defer { try? stdout.fileHandleForReading.close() }
            var pending = Data()
            while true {
                let bytes = stdout.fileHandleForReading.availableData
                if bytes.isEmpty { break }
                pending.append(bytes)
                while let newline = pending.firstIndex(of: 10) {
                    let line = String(decoding: pending[..<newline], as: UTF8.self)
                    pending.removeSubrange(...newline)
                    await controller.receive(line: line)
                }
                if pending.count > 2 * 1024 * 1024 { await controller.receive(line: ""); pending.removeAll() }
            }
            if !pending.isEmpty { await controller.receive(line: String(decoding: pending, as: UTF8.self)) }
            await controller.transportClosed(); state.stdoutEOF()
        }
        let errors = Task.detached {
            defer { try? stderr.fileHandleForReading.close() }
            while true {
                let bytes = stderr.fileHandleForReading.availableData
                if bytes.isEmpty { break }
                state.stderr(String(decoding: bytes, as: UTF8.self))
            }
            state.stderrEOF()
        }
        self.directory = directory; self.process = process; self.writer = writer; self.controller = controller
        self.tree = tree; evidence = state; self.exit = exit; self.output = output; self.errors = errors
    }

    func waitBarriers(timeout: TimeInterval = 2) async throws {
        let deadline = uptime() + timeout
        while !evidence.barriers && uptime() < deadline { try await Task.sleep(for: .milliseconds(5)) }
        try require(evidence.barriers, "actual process/dual EOF barriers timed out")
        _ = await exit.value; await output.value; await errors.value
    }
    func save(_ note: String) {
        var summary = evidence.summary(); summary["assertion"] = note
        let json = (try? JSONSerialization.data(withJSONObject: summary, options: [.prettyPrinted, .sortedKeys])) ?? Data()
        writeEvidence(directory, "parent-evidence.json", String(decoding: json, as: UTF8.self) + "\n")
    }
    func cleanup() async {
        writer.close()
        if !evidence.barriers { _ = await tree.requestCancellation() }
        try? await waitBarriers(timeout: 2)
        tree.finish()
    }
}

@MainActor private final class IntegrationSuite {
    let root: URL
    private var children: [ProtocolHarness] = []
    init() throws { root = try temporaryEvidenceDirectory() }
    private func harness(_ name: String, _ mode: String) throws -> ProtocolHarness {
        let value = try ProtocolHarness(root: root, name: name, mode: mode)
        children.append(value); return value
    }
    func cleanup() async { for child in children { await child.cleanup() } }

    func normalAnswerAndAllBarriers() async throws {
        let h = try harness("normal", "normal")
        _ = try await h.controller.start(instruction: "fixture only: no real task")
        try require(try await h.controller.waitForTurnEnd(timeout: 1) == .completed, "normal terminal absent")
        let before = await h.controller.snapshot()
        try require(before.finalResponse == "FIXTURE_REAL_ANSWER_🙂", "fragmented UTF8 answer not preserved")
        try require(!h.evidence.barriers, "a turn event alone cannot establish EOF/exit")
        h.writer.close()
        try await h.waitBarriers()
        let cleanup = await h.tree.verifyTrackedExit(timeout: 0.3)
        let snapshot = await h.controller.snapshot()
        try require(await h.exit.value == 0, "normal process nonzero")
        try require(h.evidence.stderrText.contains("STDERR_AFTER_STDIN_EOF"), "late stderr lost")
        try require(!cleanup.requiresCheck && !snapshot.assessment(treeCleanupVerified: h.evidence.barriers).requiresCheck, "normal barriers failed")
        h.save("PASS normal answer retained until exit + actual stdout/stderr EOF")
        h.tree.finish()
    }

    func terminalBeforeInterruptACK() async throws {
        let h = try harness("interrupt_order", "interrupt-order")
        _ = try await h.controller.start(instruction: "fixture only")
        let stop = Task { await h.controller.requestInterrupt(timeout: 3) }
        try require(try await h.controller.waitForTurnEnd(timeout: 1) == .interrupted, "interrupted terminal absent")
        let beforeACK = await h.controller.snapshot()
        try require(!beforeACK.interruptAcknowledged, "fixture did not put terminal before ACK")
        try require(!beforeACK.assessment(treeCleanupVerified: true).cancellationConfirmed, "terminal alone incorrectly confirmed")
        writeEvidence(h.directory, "allow-ack", "fixture gate only\n")
        // Do not close stdin until the exact same stop worker has the ACK too.
        try require(await stop.value, "matching interrupt ACK missing")
        h.writer.close(); try await h.waitBarriers()
        let cleanup = await h.tree.verifyTrackedExit(timeout: 0.3)
        let snapshot = await h.controller.snapshot()
        try require(!readEvidence(h.directory, "fixture.log").contains("EARLY_STDIN_CLOSE"), "stdin closed before ACK")
        try require(snapshot.assessment(treeCleanupVerified: !cleanup.requiresCheck && h.evidence.barriers).cancellationConfirmed, "three independent cancellation checks absent")
        try require(snapshot.finalResponse == "FIXTURE_CANCEL_PARTIAL_RESULT", "real cancelled response lost")
        h.save("PASS terminal before matching ACK; close input only after shared stop future; no fake tool exit")
        h.tree.finish()
    }

    func earlyStopDoesNotDispatch() async throws {
        let h = try harness("early_stop", "normal")
        _ = await h.controller.requestInterrupt()
        do { _ = try await h.controller.start(instruction: "MUST_NOT_BE_SENT"); throw IntegrationFailure(message: "pre-stop dispatch accepted") }
        catch CodexAppServerError.cancelledBeforeStart {}
        h.writer.close(); try await h.waitBarriers()
        try require(!readEvidence(h.directory, "requests.log").contains("turn/start"), "early stop sent task")
        try require(!(await h.controller.snapshot()).turnStartSent, "early stop task latch changed")
        h.save("PASS Stop before bootstrap sent no turn/start and child exited with actual EOF")
        h.tree.finish()
    }

    func partialInstructionWriteIsUnknown() async throws {
        let h = try harness("partial_write", "close-mid-turn")
        do {
            _ = try await h.controller.start(instruction: String(repeating: "fixture_input_", count: 80000))
            throw IntegrationFailure(message: "partial write unexpectedly accepted")
        } catch is IntegrationFailure { throw IntegrationFailure(message: "partial write accepted as task start") }
        catch { /* Actual child closes its reading fd after only 128 bytes. */ }
        let writeDeadline = uptime() + 0.5
        while h.evidence.inputFailure == nil && uptime() < writeDeadline { try await Task.sleep(for: .milliseconds(5)) }
        h.writer.close(); try await h.waitBarriers()
        let snapshot = await h.controller.snapshot()
        try require(readEvidence(h.directory, "fixture.log").contains("PARTIAL_TURN_BYTES=128"), "partial pipe evidence missing")
        try require(snapshot.turnStartSent && !snapshot.isTurnTerminal, "partial turn write falsely became not-started/terminal")
        try require(snapshot.assessment(treeCleanupVerified: true).requiresCheck, "partial write incorrectly succeeded")
        try require(h.evidence.inputFailure?.contains("writeFailed(32)") == true, "real EPIPE evidence absent: \(h.evidence.inputFailure ?? "nil")")
        h.save("PASS real EPIPE/partial turn/start frame retained possible-execution unknown; no restart")
        h.tree.finish()
    }

    func missingExitNeverCompletes() async throws {
        let h = try harness("missing_exit", "missing-exit")
        _ = try await h.controller.start(instruction: "fixture only")
        _ = try await h.controller.waitForTurnEnd(timeout: 1)
        h.writer.close(); try await h.waitBarriers()
        let snapshot = await h.controller.snapshot()
        try require(await h.exit.value == 0 && h.evidence.barriers, "fixture process barriers absent")
        try require(snapshot.hasUnconfirmedCommands && snapshot.assessment(treeCleanupVerified: true).requiresCheck,
            "exit0 + completed turn incorrectly hides missing command exit")
        h.save("PASS CLI exit0 + dual EOF + answer do not convert missing command exit to success")
        h.tree.finish()
    }

    func heldStdoutNeedsOwnedTreeCleanup() async throws {
        let h = try harness("held_stdout", "held-stdout")
        _ = try await h.controller.start(instruction: "fixture only")
        _ = try await h.controller.waitForTurnEnd(timeout: 1)
        h.tree.captureNow(); h.writer.close()
        let deadline = uptime() + 1
        while !h.evidence.processEnded && uptime() < deadline { try await Task.sleep(for: .milliseconds(5)) }
        try require(h.evidence.processEnded && !h.evidence.stdoutEnded, "fixture child did not keep stdout after root exit")
        let before = await h.tree.verifyTrackedExit(timeout: 0.05)
        try require(before.requiresCheck && before.trackedCount >= 2, "live owned child incorrectly clean")
        let cleanup = await h.tree.requestCancellation()
        try await h.waitBarriers()
        try require(cleanup.trackedProcessesExited && !cleanup.requiresCheck, "owned descendant cleanup unconfirmed")
        h.save("PASS real child held stdout past root exit; actual EOF arrived only after exact owned-tree cleanup")
        h.tree.finish()
    }

    func ignoredInterruptAndEOFFailClosed() async throws {
        let h = try harness("ignored_stop", "ignore-interrupt")
        _ = try await h.controller.start(instruction: "fixture only")
        let mainWaiter = Task { try await h.controller.waitForTurnEnd(timeout: 5) }
        try await Task.sleep(for: .milliseconds(10))
        let startedAt = uptime()
        try require(!(await h.controller.requestInterrupt(timeout: 0.1)), "ignored interrupt acknowledged")
        do { _ = try await mainWaiter.value; throw IntegrationFailure(message: "main waiter did not fail closed") }
        catch CodexAppServerError.invalidProtocol {}
        h.writer.close()
        try await Task.sleep(for: .milliseconds(30))
        try require(!h.evidence.barriers && !h.evidence.stdoutEnded, "fixture incorrectly synthesized EOF")
        h.tree.captureNow()
        let cleanup = await h.tree.requestCancellation()
        try await h.waitBarriers()
        let snapshot = await h.controller.snapshot()
        try require(uptime() - startedAt < 3, "owned fallback did not bound ignored stop")
        try require(cleanup.trackedProcessesExited, "fallback left tracked child live")
        try require(snapshot.protocolIssue != nil && snapshot.assessment(treeCleanupVerified: !cleanup.requiresCheck).requiresCheck,
            "tree cleanup incorrectly changed unknown tool into cancelled success")
        h.save("PASS ignored interrupt+stdin EOF required real owned fallback; main waiter released promptly; hold stays unknown")
        h.tree.finish()
    }

    func run() async throws {
        try await normalAnswerAndAllBarriers()
        try await terminalBeforeInterruptACK()
        try await earlyStopDoesNotDispatch()
        try await partialInstructionWriteIsUnknown()
        try await missingExitNeverCompletes()
        try await heldStdoutNeedsOwnedTreeCleanup()
        try await ignoredInterruptAndEOFFailClosed()
    }
}

// Fixture-only subprocess: reads synthetic JSON protocol, not a shell or a
// user's payload. Its sole descendant is our deliberately owned /bin/sleep.
private func fakeProtocol(mode: String, directory: URL) throws {
    let requestURL = directory.appendingPathComponent("requests.log")
    FileManager.default.createFile(atPath: requestURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
    let requests = try FileHandle(forWritingTo: requestURL)
    defer { try? requests.close() }
    var log = ""
    func note(_ text: String) { log += text + "\n"; writeEvidence(directory, "fixture.log", log) }
    func emit(_ value: ProtocolJSON) throws {
        let bytes = Data((try value.line() + "\n").utf8)
        // Deliberately split JSON and multibyte UTF8 across actual reads.
        var offset = 0
        while offset < bytes.count {
            let end = min(bytes.count, offset + 7)
            try FileHandle.standardOutput.write(contentsOf: bytes[offset..<end]); offset = end
        }
    }
    func reply(_ id: ProtocolJSON, _ value: ProtocolJSON) throws { try emit(.object(["id": id, "result": value])) }
    func command(_ status: String, exit: ProtocolJSON = .null) -> ProtocolJSON {
        .object(["id": .string("fixture_cmd"), "type": .string("commandExecution"), "status": .string(status),
            "exitCode": exit, "command": .string("synthetic fixture; not executed"), "aggregatedOutput": .string("fixture output")])
    }
    func item(_ method: String, _ value: ProtocolJSON) throws {
        try emit(.object(["method": .string(method), "params": .object([
            "threadId": .string("fixture_thread"), "turnId": .string("fixture_turn"), "item": value])]))
    }
    func terminal(_ status: String, _ items: [ProtocolJSON]) throws {
        try emit(.object(["method": .string("turn/completed"), "params": .object([
            "threadId": .string("fixture_thread"), "turn": .object(["id": .string("fixture_turn"),
                "status": .string(status), "items": .array(items), "error": .null])])]))
    }
    var holder: Process?
    while let line = readLine() {
        let value = try JSONDecoder().decode(ProtocolJSON.self, from: Data(line.utf8))
        let method = value["method"]?.string ?? ""
        try requests.write(contentsOf: Data((method + "\n").utf8))
        guard let id = value["id"] else { continue }
        if method == "initialize" { try reply(id, .object(["userAgent": .string("ONE fixture only")])) }
        else if method == "thread/start" {
            try reply(id, .object(["thread": .object(["id": .string("fixture_thread")])]))
            if mode == "close-mid-turn" {
                let prefix = try FileHandle.standardInput.read(upToCount: 128) ?? Data()
                note("PARTIAL_TURN_BYTES=\(prefix.count)")
                try? FileHandle.standardInput.close()
                return
            }
        } else if method == "turn/start" {
            try reply(id, .object(["turn": .object(["id": .string("fixture_turn"), "status": .string("inProgress"), "items": .array([])])]))
            try item("item/started", command("inProgress"))
            if ["held-stdout", "ignore-interrupt"].contains(mode) {
                let child = Process()
                child.executableURL = URL(fileURLWithPath: "/bin/sleep"); child.arguments = ["10"]
                child.environment = ["PATH": "/usr/bin:/bin"]
                child.standardInput = FileHandle.nullDevice; child.standardOutput = FileHandle.standardOutput; child.standardError = FileHandle.nullDevice
                try child.run(); holder = child; note("OWNED_PIPE_HOLDER=\(child.processIdentifier)")
                usleep(150000) // allow exact ancestry sampling before root exits
            }
            if mode == "interrupt-order" || mode == "ignore-interrupt" { continue }
            let completed = mode == "missing-exit" ? command("failed", exit: .number(-1)) : command("completed", exit: .number(0))
            try item("item/completed", completed)
            let answer: ProtocolJSON = .object(["id": .string("fixture_answer"), "type": .string("agentMessage"), "text": .string("FIXTURE_REAL_ANSWER_🙂")])
            try item("item/completed", answer); try terminal("completed", [completed, answer])
        } else if method == "turn/interrupt" {
            if mode == "ignore-interrupt" { note("IGNORED_INTERRUPT"); continue }
            let interrupted = command("failed", exit: .number(-1))
            try item("item/completed", interrupted)
            let answer: ProtocolJSON = .object(["id": .string("fixture_answer"), "type": .string("agentMessage"), "text": .string("FIXTURE_CANCEL_PARTIAL_RESULT")])
            try item("item/completed", answer); try terminal("interrupted", [interrupted, answer])
            let ackDeadline = uptime() + 3
            // A test-owned gate, rather than a scheduling-sensitive sleep,
            // proves the parent observed the terminal before releasing ACK.
            while !FileManager.default.fileExists(atPath: directory.appendingPathComponent("allow-ack").path) {
                var descriptor = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN | POLLHUP), revents: 0)
                if poll(&descriptor, 1, 0) > 0 {
                    var byte: UInt8 = 0
                    if Darwin.read(STDIN_FILENO, &byte, 1) == 0 { note("EARLY_STDIN_CLOSE"); return }
                }
                guard uptime() < ackDeadline else { note("ACK_GATE_TIMEOUT"); return }
                usleep(5000)
            }
            try reply(id, .object([:])); note("MATCHED_ACK_SENT")
        }
    }
    if mode == "ignore-interrupt" {
        note("IGNORED_STDIN_EOF")
        while true { usleep(100000) }
    }
    _ = holder // retain Process until fixture return; does not kill child
    try FileHandle.standardError.write(contentsOf: Data("STDERR_AFTER_STDIN_EOF\n".utf8))
    usleep(100000)
}

@main private struct CodexAppServerIntegrationTests {
    static func main() async {
        if CommandLine.arguments.count == 4, CommandLine.arguments[1] == "--fake-protocol" {
            do { try fakeProtocol(mode: CommandLine.arguments[2], directory: URL(fileURLWithPath: CommandLine.arguments[3])); exit(0) }
            catch { fputs("fixture error: \(error)\n", stderr); exit(91) }
        }
        alarm(30)
        var suite: IntegrationSuite?
        do {
            let value = try IntegrationSuite(); suite = value
            try await value.run(); await value.cleanup()
            print("CodexAppServerIntegrationTests: 7 real-pipe fixture groups passed; NOT real ONE/Codex acceptance")
            print("Evidence retained: \(value.root.path)")
        } catch {
            if let suite {
                await suite.cleanup()
                writeEvidence(suite.root, "FAILURE.txt", String(describing: error))
                fputs("Failure evidence retained: \(suite.root.path)\n", stderr)
            }
            fputs("CodexAppServerIntegrationTests failed: \(error)\n", stderr); exit(1)
        }
    }
}
