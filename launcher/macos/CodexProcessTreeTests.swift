import Foundation
import Darwin

private final class FakeTree: CodexProcessTreeBackend, @unchecked Sendable {
    private let lock = NSLock()
    private var processes: [pid_t: CodexProcessIdentity]
    private var sent: [(pid_t, Int32)] = []
    private var failReads = Set<pid_t>()
    private var failLists = Set<pid_t>()
    private var ignoredStops = Set<pid_t>()
    private var deniedKills = Set<pid_t>()
    private var addChildOnStop: CodexProcessIdentity?
    private var replaceDuringList: (CodexProcessIdentity,CodexProcessIdentity)?
    private(set) var advancedParent = false

    init(_ nodes: [CodexProcessIdentity]) { processes = Dictionary(uniqueKeysWithValues: nodes.map { ($0.pid, $0) }) }
    func identity(_ pid: pid_t) throws -> CodexProcessIdentity? {
        lock.lock(); defer { lock.unlock() }
        if failReads.contains(pid) { throw CodexProcessTreeFailure.unavailable }
        return processes[pid]
    }
    func children(of pid: pid_t) throws -> [pid_t] {
        lock.lock(); defer { lock.unlock() }
        if failLists.contains(pid) { throw CodexProcessTreeFailure.unavailable }
        if let (parent,child) = replaceDuringList, parent.pid == pid {
            processes[parent.pid] = parent; processes[child.pid] = child; replaceDuringList = nil
        }
        return processes.values.filter { $0.parentPID == pid }.map(\.pid).sorted()
    }
    func signal(_ pid: pid_t, _ signal: Int32) throws -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard let node = processes[pid] else { return false }
        sent.append((pid, signal))
        if signal == SIGSTOP {
            if let child = addChildOnStop { processes[child.pid] = child; addChildOnStop = nil }
            if !ignoredStops.contains(pid) { processes[pid] = Self.stopping(node) }
        }
        if signal == SIGKILL {
            if deniedKills.contains(pid) { throw CodexProcessTreeFailure.unavailable }
            if let parent = processes[node.parentPID], !parent.stopped { advancedParent = true }
            processes.removeValue(forKey: pid)
        }
        return true
    }
    func replace(_ node: CodexProcessIdentity) { lock.lock(); processes[node.pid] = node; lock.unlock() }
    func remove(_ pid: pid_t) { lock.lock(); processes.removeValue(forKey: pid); lock.unlock() }
    func failRead(_ pid: pid_t) { lock.lock(); failReads.insert(pid); lock.unlock() }
    func failList(_ pid: pid_t) { lock.lock(); failLists.insert(pid); lock.unlock() }
    func replaceDuringChildren(_ parent: CodexProcessIdentity, child: CodexProcessIdentity) { lock.lock(); replaceDuringList = (parent,child); lock.unlock() }
    func ignoreStop(_ pid: pid_t) { lock.lock(); ignoredStops.insert(pid); lock.unlock() }
    func denyKill(_ pid: pid_t) { lock.lock(); deniedKills.insert(pid); lock.unlock() }
    func addOnStop(_ node: CodexProcessIdentity) { lock.lock(); addChildOnStop = node; lock.unlock() }
    func signals() -> [(pid_t, Int32)] { lock.lock(); defer { lock.unlock() }; return sent }
    func contains(_ pid: pid_t) -> Bool { lock.lock(); defer { lock.unlock() }; return processes[pid] != nil }
    private static func stopping(_ n: CodexProcessIdentity) -> CodexProcessIdentity {
        CodexProcessIdentity(pid:n.pid,parentPID:n.parentPID,uid:n.uid,realUID:n.realUID,
            startedSeconds:n.startedSeconds,startedMicroseconds:n.startedMicroseconds,stopped:true,zombie:n.zombie)
    }
}

@main struct CodexProcessTreeTests {
    static func node(_ pid: pid_t, _ parent: pid_t, birth: UInt64 = 10) -> CodexProcessIdentity {
        CodexProcessIdentity(pid:pid,parentPID:parent,uid:getuid(),realUID:getuid(),startedSeconds:birth,
            startedMicroseconds:UInt64(pid),stopped:false,zombie:false)
    }
    static var fast: CodexProcessTreeTiming {
        var value = CodexProcessTreeTiming(); value.interruptGrace = 0; value.killConfirmation = 0.02; value.observationInterval = 60; return value
    }
    static func testExactTreeAndIdempotence() async throws {
        let backend = FakeTree([node(20001,getpid()),node(20002,20001,birth:11),node(20003,20002,birth:12),node(20004,99999,birth:13)])
        let tree = try CodexProcessTree.begin(rootPID:20001,attemptId:"attempt-unit",backend:backend,timing:fast)
        defer { tree.finish() }
        async let first = tree.requestCancellation()
        async let second = tree.requestCancellation()
        let (a,b) = await (first,second)
        precondition(a.trackedProcessesExited && !a.requiresCheck && a.usedEscalation && a.trackedCount == 3)
        precondition(b.trackedProcessesExited && b.trackedCount == a.trackedCount)
        let signals = backend.signals()
        precondition(signals.filter { $0.1 == SIGINT }.map(\.0) == [20001], "one native interrupt per attempt")
        precondition(signals.filter { $0.1 == SIGKILL }.map(\.0) == [20001,20002,20003], "parents die before their leaves")
        precondition(!signals.contains { $0.0 == 20004 || $0.1 == SIGCONT || $0.1 == SIGTERM })
        precondition(backend.contains(20004) && !backend.advancedParent)
    }
    static func testExitVerificationDoesNotSignal() async throws {
        let backend = FakeTree([node(20101,getpid()),node(20102,20101,birth:11)])
        let tree = try CodexProcessTree.begin(rootPID:20101,attemptId:"attempt-verify",backend:backend,timing:fast)
        let live = await tree.verifyTrackedExit(timeout:0)
        precondition(!live.trackedProcessesExited && live.requiresCheck && backend.signals().isEmpty)
        backend.remove(20101); backend.remove(20102)
        let gone = await tree.verifyTrackedExit(timeout:0)
        precondition(gone.trackedProcessesExited && !gone.requiresCheck && !gone.usedEscalation)
        precondition(backend.signals().isEmpty,"protocol-confirmed shutdown must not receive another signal")
        tree.finish()
        let closed = await tree.verifyTrackedExit(timeout:0)
        precondition(closed.requiresCheck && !closed.trackedProcessesExited)
    }
    static func testReuseAndUncertainty() async throws {
        let backend = FakeTree([node(21001,getpid()),node(21002,21001,birth:11)])
        let tree = try CodexProcessTree.begin(rootPID:21001,attemptId:"attempt-reuse",backend:backend,timing:fast)
        defer { tree.finish() }
        backend.replace(node(21002,99999,birth:999))
        let result = await tree.requestCancellation()
        precondition(result.requiresCheck && result.reasonCodes.contains("identity_changed"))
        precondition(backend.contains(21002) && !backend.signals().contains { $0.0 == 21002 })
        let failed = FakeTree([node(22001,getpid()),node(22002,22001,birth:11)])
        let unknown = try CodexProcessTree.begin(rootPID:22001,attemptId:"attempt-unknown",backend:failed,timing:fast)
        defer { unknown.finish() }
        failed.failRead(22002)
        let held = await unknown.requestCancellation()
        precondition(held.requiresCheck && !held.trackedProcessesExited)
        precondition(!failed.signals().contains { $0.0 == 22002 }, "unreadable identity must never be signalled")
        let switched = FakeTree([node(22501,getpid())])
        let reusedParent = try CodexProcessTree.begin(rootPID:22501,attemptId:"attempt-parent-reuse",backend:switched,timing:fast)
        defer { reusedParent.finish() }
        switched.replaceDuringChildren(node(22501,99999,birth:99),child:node(22502,22501,birth:100))
        reusedParent.captureNow()
        let reused = await reusedParent.requestCancellation()
        precondition(reused.requiresCheck && reused.trackedCount == 1)
        precondition(switched.signals().isEmpty && switched.contains(22502),"PID-reused parent's unrelated child must not be attached or signalled")
        let deniedList = FakeTree([node(22601,getpid())])
        let incomplete = try CodexProcessTree.begin(rootPID:22601,attemptId:"attempt-list-failed",backend:deniedList,timing:fast)
        defer { incomplete.finish() }; deniedList.failList(22601)
        let listFailure = await incomplete.requestCancellation(); precondition(listFailure.requiresCheck)
    }
    static func testFreezeFailureCannotAdvanceParent() async throws {
        let backend = FakeTree([node(23001,getpid()),node(23002,23001,birth:11),node(23003,23002,birth:12)])
        let tree = try CodexProcessTree.begin(rootPID:23001,attemptId:"attempt-freeze",backend:backend,timing:fast)
        defer { tree.finish() }
        backend.ignoreStop(23002)
        let result = await tree.requestCancellation()
        precondition(result.requiresCheck && result.reasonCodes.contains("freeze_unconfirmed"))
        precondition(result.trackedProcessesExited && !backend.advancedParent)
        let denied = FakeTree([node(24001,getpid()),node(24002,24001,birth:11),node(24003,24002,birth:12)])
        let blocked = try CodexProcessTree.begin(rootPID:24001,attemptId:"attempt-denied",backend:denied,timing:fast)
        defer { blocked.finish() }
        denied.denyKill(24002)
        let unknown = await blocked.requestCancellation()
        precondition(unknown.requiresCheck && !unknown.trackedProcessesExited)
        precondition(unknown.reasonCodes.contains("frozen_cleanup_unconfirmed"))
        precondition(!denied.signals().contains { $0.0 == 24003 && $0.1 == SIGKILL })
        precondition(!denied.signals().contains { $0.1 == SIGCONT } && !denied.advancedParent)
    }
    static func testLateChildLimitsAndFinish() async throws {
        let backend = FakeTree([node(25001,getpid()),node(25002,25001,birth:11)])
        let tree = try CodexProcessTree.begin(rootPID:25001,attemptId:"attempt-late",backend:backend,timing:fast)
        defer { tree.finish() }
        backend.addOnStop(node(25003,25002,birth:12))
        let result = await tree.requestCancellation()
        precondition(result.trackedCount == 3 && result.trackedProcessesExited && !result.requiresCheck)
        let crowded = FakeTree([node(26001,getpid())])
        let limited = try CodexProcessTree.begin(rootPID:26001,attemptId:"attempt-limited",backend:crowded,timing:fast,maximumTracked:1)
        defer { limited.finish() }
        crowded.replace(node(26002,26001,birth:11))
        limited.captureNow()
        let limitResult = await limited.requestCancellation(); precondition(limitResult.requiresCheck)
        let normal = FakeTree([node(27001,getpid())])
        let finished = try CodexProcessTree.begin(rootPID:27001,attemptId:"attempt-finished",backend:normal,timing:fast)
        finished.finish()
        let finishedResult = await finished.requestCancellation(); precondition(finishedResult.requiresCheck)
        precondition(normal.signals().isEmpty)
    }

    static func childMode() -> Bool {
        let args = CommandLine.arguments
        if args.count > 1 && args[1] == "--native-test-root" {
            signal(SIGINT) { _ in _exit(0) }
            print("READY"); fflush(stdout)
            while true { pause() }
        }
        if args.count > 2 && args[1] == "--new-session-shell" {
            guard setsid() >= 0 else { _exit(125) }
            let strings = ["/bin/sh","-c","trap '' INT; /bin/sleep 2; /usr/bin/printf 'SHOULD_NOT_EXIST' > \"$1\"","one-owned-test",args[2]]
            let cargs = strings.map { strdup($0) } + [nil]
            cargs.withUnsafeBufferPointer { _ = execv($0[0]!,$0.baseAddress!) }
            _exit(126)
        }
        if args.count > 2 && args[1] == "--detached-test-shell" {
            // Foundation starts a group leader, which cannot setsid itself.
            // Keep it alive and posix_spawn a child in the wrapper's group,
            // so that child is not a leader and can start its own session.
            var attributes: posix_spawnattr_t?
            guard posix_spawnattr_init(&attributes) == 0 else { _exit(124) }
            guard posix_spawnattr_setpgroup(&attributes,getpgrp()) == 0,
                  posix_spawnattr_setflags(&attributes,Int16(POSIX_SPAWN_SETPGROUP)) == 0 else { _exit(124) }
            let childArguments: [String] = [args[0],"--new-session-shell",args[2]]
            let cargs: [UnsafeMutablePointer<CChar>?] = childArguments.map { value in value.withCString { strdup($0) } } + [nil]
            let environment = ProcessInfo.processInfo.environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
            var child: pid_t = 0
            let spawned = cargs.withUnsafeBufferPointer { argv in
                environment.withUnsafeBufferPointer { env in posix_spawn(&child,argv[0]!,nil,&attributes,argv.baseAddress!,env.baseAddress!) }
            }
            posix_spawnattr_destroy(&attributes)
            guard spawned == 0 else { _exit(124) }
            var status: Int32 = 0
            while waitpid(child,&status,0) < 0 && errno == EINTR { }
            _exit(0)
        }
        if args.count > 2 && args[1] == "--stubborn-test-root" {
            signal(SIGINT,SIG_IGN)
            let child = Process(); child.executableURL = URL(fileURLWithPath:args[0]); child.arguments = ["--detached-test-shell",args[2]]
            do { try child.run() } catch { _exit(126) }
            print("CHILD \(child.processIdentifier)"); fflush(stdout)
            child.waitUntilExit(); _exit(0)
        }
        return false
    }
    static func launch(_ arguments: [String]) throws -> (Process,String) {
        let process = Process(), output = Pipe()
        process.executableURL = URL(fileURLWithPath:CommandLine.arguments[0]); process.arguments = arguments
        process.standardOutput = output; process.standardError = FileHandle.nullDevice
        try process.run(); try? output.fileHandleForWriting.close()
        var line = Data()
        while let next = try output.fileHandleForReading.read(upToCount:1), !next.isEmpty {
            if next[0] == 10 { break }; line.append(next)
        }
        return (process,String(decoding:line,as:UTF8.self))
    }
    static func testRealNativeInterrupt() async throws {
        let (process,ready) = try launch(["--native-test-root"])
        precondition(ready == "READY")
        let tree = try CodexProcessTree.begin(rootPID:process.processIdentifier,attemptId:"attempt-native-real")
        defer { tree.finish(); if process.isRunning { process.terminate() } }
        let result = await tree.requestCancellation()
        process.waitUntilExit()
        precondition(result.trackedProcessesExited && !result.requiresCheck && !result.usedEscalation)
    }
    static func testRealDetachedShellCannotWriteAfterStop() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("one-owned-tree-test-\(UUID().uuidString)",isDirectory:true)
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
        defer { try? FileManager.default.removeItem(at:directory) }
        let marker = directory.appendingPathComponent("must-not-write.txt")
        let (process,ready) = try launch(["--stubborn-test-root",marker.path])
        let wrapperPID = pid_t(ready.split(separator:" ").last ?? "")!
        let tree = try CodexProcessTree.begin(rootPID:process.processIdentifier,attemptId:"attempt-detached-real",timing:fast)
        defer { tree.finish(); if process.isRunning { process.terminate() } }
        let backend = DarwinCodexProcessTreeBackend()
        var childPID: pid_t = 0
        for _ in 0..<50 {
            childPID = (try backend.children(of:wrapperPID)).first ?? 0
            if childPID > 1 && getsid(childPID) == childPID { break }
            try await Task.sleep(for:.milliseconds(10))
        }
        precondition(childPID > 1 && getsid(childPID) == childPID && getsid(process.processIdentifier) != childPID,"test child must actually escape the CLI session")
        tree.captureNow()
        let result = await tree.requestCancellation()
        process.waitUntilExit()
        precondition(result.trackedProcessesExited && !result.requiresCheck && result.usedEscalation && result.trackedCount >= 2)
        try await Task.sleep(for:.milliseconds(2200))
        precondition(!FileManager.default.fileExists(atPath:marker.path),"cancelled shell advanced to its delayed write")
    }
    static func main() async throws {
        if childMode() { return }
        alarm(20)
        try await testExactTreeAndIdempotence(); try await testReuseAndUncertainty()
        try await testExitVerificationDoesNotSignal()
        try await testFreezeFailureCannotAdvanceParent(); try await testLateChildLimitsAndFinish()
        try await testRealNativeInterrupt(); try await testRealDetachedShellCannotWriteAfterStop()
        alarm(0)
        print("Mac owned process tree tests passed (identity, idempotence, uncertainty, parent-first cleanup, native SIGINT, real detached shell delayed write)")
    }
}
