import Foundation
import Darwin

struct CodexProcessIdentity: Sendable, Equatable {
    let pid: pid_t
    let parentPID: pid_t
    let uid: uid_t
    let realUID: uid_t
    let startedSeconds: UInt64
    let startedMicroseconds: UInt64
    let stopped: Bool
    let zombie: Bool

    func isSameProcess(as other: Self) -> Bool {
        pid == other.pid && uid == other.uid && realUID == other.realUID &&
            startedSeconds == other.startedSeconds && startedMicroseconds == other.startedMicroseconds
    }
    func wasBornAfter(_ parent: Self) -> Bool {
        startedSeconds > parent.startedSeconds ||
            (startedSeconds == parent.startedSeconds && startedMicroseconds >= parent.startedMicroseconds)
    }
}

enum CodexProcessTreeFailure: Error { case invalidRoot, unavailable, limitExceeded }

protocol CodexProcessTreeBackend: Sendable {
    func identity(_ pid: pid_t) throws -> CodexProcessIdentity?
    func children(of pid: pid_t) throws -> [pid_t]
    func signal(_ pid: pid_t, _ signal: Int32) throws -> Bool
}

struct DarwinCodexProcessTreeBackend: CodexProcessTreeBackend {
    func identity(_ pid: pid_t) throws -> CodexProcessIdentity? {
        var info = proc_bsdinfo()
        errno = 0
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        let count = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size)
        guard count == size else {
            if errno == ESRCH || errno == ENOENT { return nil }
            // Do not turn a denied or partial metadata read into "exited".
            if count == 0, Darwin.kill(pid, 0) == -1, errno == ESRCH { return nil }
            throw CodexProcessTreeFailure.unavailable
        }
        return CodexProcessIdentity(pid: pid, parentPID: pid_t(info.pbi_ppid), uid: info.pbi_uid,
            realUID: info.pbi_ruid, startedSeconds: info.pbi_start_tvsec,
            startedMicroseconds: info.pbi_start_tvusec, stopped: info.pbi_status == SSTOP,
            zombie: info.pbi_status == SZOMB)
    }
    func children(of pid: pid_t) throws -> [pid_t] {
        // proc_listpids returns bytes, unlike the convenience listchildpids
        // API. A full fixed buffer is incomplete, never a complete empty tree.
        var pids = [pid_t](repeating: 0, count: 1024)
        let capacity = pids.count * MemoryLayout<pid_t>.size
        errno = 0
        let bytes = pids.withUnsafeMutableBytes {
            proc_listpids(UInt32(PROC_PPID_ONLY), UInt32(pid), $0.baseAddress, Int32(capacity))
        }
        guard bytes >= 0, bytes < capacity, Int(bytes) % MemoryLayout<pid_t>.size == 0,
              bytes > 0 || errno == 0 else { throw CodexProcessTreeFailure.unavailable }
        return Array(Set(pids.prefix(Int(bytes) / MemoryLayout<pid_t>.size).filter { $0 > 1 })).sorted()
    }
    func signal(_ pid: pid_t, _ signal: Int32) throws -> Bool {
        guard pid > 1, pid != getpid() else { throw CodexProcessTreeFailure.invalidRoot }
        if Darwin.kill(pid, signal) == 0 { return true }
        if errno == ESRCH { return false }
        throw CodexProcessTreeFailure.unavailable
    }
}

struct CodexProcessTreeCancellation: Sendable {
    // This proves only the recorded kernel identities exited. It is not a
    // claim about arbitrary daemonized processes or a Codex tool final event.
    let trackedProcessesExited: Bool
    let requiresCheck: Bool
    let usedEscalation: Bool
    let trackedCount: Int
    let reasonCodes: [String]
}

struct CodexProcessTreeDescendantStop: Sendable {
    // The app-server stays alive to return its exact interrupt acknowledgement
    // and command terminals. This is not itself a protocol cancellation proof.
    let descendantsExited: Bool
    let rootAvailable: Bool
    let requiresCheck: Bool
    let trackedCount: Int
    let reasonCodes: [String]
}

struct CodexProcessTreeTiming: Sendable {
    var interruptGrace: TimeInterval = 3.5
    var killConfirmation: TimeInterval = 1.5
    var observationInterval: TimeInterval = 0.1
}

// The caller supplies only the PID returned by its own Process.run(), before
// writing the prompt. Session ids, process names and working directories are
// never used as ownership evidence. No process-group-wide signals are sent.
final class CodexProcessTree: @unchecked Sendable {
    private struct Node { let identity: CodexProcessIdentity; let depth: Int }
    let attemptId: String
    private let root: CodexProcessIdentity
    private let backend: any CodexProcessTreeBackend
    private let timing: CodexProcessTreeTiming
    private let maximumTracked: Int
    private let lock = NSLock()
    private var nodes: [pid_t: Node]
    private var reasons = Set<String>()
    private var frozen = Set<pid_t>()
    private var monitoring = true
    private var finishRequested = false
    private var observer: Task<Void, Never>?
    private var cancellation: Task<CodexProcessTreeCancellation, Never>?
    private var descendantStop: Task<CodexProcessTreeDescendantStop, Never>?

    static func begin(rootPID: pid_t, attemptId: String,
        backend: any CodexProcessTreeBackend = DarwinCodexProcessTreeBackend(),
        timing: CodexProcessTreeTiming = CodexProcessTreeTiming(), maximumTracked: Int = 256) throws -> CodexProcessTree {
        guard rootPID > 1, rootPID != getpid(), !attemptId.isEmpty,
              let root = try backend.identity(rootPID), root.pid == rootPID,
              root.parentPID == getpid(), root.uid == getuid(), root.realUID == getuid(),
              !root.zombie, root.startedSeconds > 0 else { throw CodexProcessTreeFailure.invalidRoot }
        let handle = CodexProcessTree(root: root, attemptId: attemptId, backend: backend,
            timing: timing, maximumTracked: maximumTracked)
        handle.captureNow()
        guard handle.synchronized({ handle.reasons.isEmpty }) else { throw CodexProcessTreeFailure.unavailable }
        handle.observer = Task.detached { [weak handle] in
            while handle?.observe() == true {
                do { try await Task.sleep(for: .seconds(max(0.01, timing.observationInterval))) } catch { return }
            }
        }
        return handle
    }

    private init(root: CodexProcessIdentity, attemptId: String, backend: any CodexProcessTreeBackend,
        timing: CodexProcessTreeTiming, maximumTracked: Int) {
        self.root = root; self.attemptId = attemptId; self.backend = backend; self.timing = timing
        self.maximumTracked = min(512, max(1, maximumTracked)); nodes = [root.pid: Node(identity: root, depth: 0)]
    }

    private func synchronized<T>(_ body: () -> T) -> T { lock.lock(); defer { lock.unlock() }; return body() }
    private func observe() -> Bool {
        synchronized { guard monitoring else { return false }; captureLocked(); return true }
    }
    func captureNow() { synchronized { captureLocked() } }

    // Stop observing after normal cleanup; never abandon a frozen prompt stop
    // or in-flight full cancellation. A prompt-owned root is fully cleaned up
    // before monitoring ends. Cancellation evidence is never erased.
    func finish() {
        let pending = synchronized { () -> (Task<CodexProcessTreeDescendantStop, Never>?, Task<CodexProcessTreeCancellation, Never>?) in
            finishRequested = true
            if let prompt = descendantStop, cancellation == nil {
                // The owner is finished with this tree. Reserve full-cleanup
                // priority now, before the prompt worker could resume its root.
                cancellation = Task.detached { [self] in
                    _ = await prompt.value
                    return await cancelRecordedTree(skipNativeInterrupt: true)
                }
            }
            if descendantStop == nil && cancellation == nil { monitoring = false; observer?.cancel(); observer = nil }
            return (descendantStop, cancellation)
        }
        if pending.0 != nil || pending.1 != nil {
            Task.detached { [self] in
                if let prompt = pending.0 { _ = await prompt.value }
                if let full = pending.1 { _ = await full.value }
                synchronized { monitoring = false; observer?.cancel(); observer = nil }
            }
        }
    }

    // The app-server protocol can acknowledge an exact interrupted turn before
    // its stdio process finishes shutting down. Wait for the already-owned tree
    // without sending another interrupt. This alone never proves a tool ended.
    func verifyTrackedExit(timeout: TimeInterval = 3.5) async -> CodexProcessTreeCancellation {
        guard synchronized({ monitoring }) else {
            return CodexProcessTreeCancellation(trackedProcessesExited: false, requiresCheck: true,
                usedEscalation: false, trackedCount: synchronized { nodes.count }, reasonCodes: ["monitoring_finished"])
        }
        _ = await waitForTrackedExit(timeout.isFinite ? timeout : 0)
        return result(escalated: false)
    }

    func requestCancellation() async -> CodexProcessTreeCancellation {
        let work = synchronized { () -> Task<CodexProcessTreeCancellation, Never> in
            if let cancellation { return cancellation }
            guard monitoring, !finishRequested else {
                let result = CodexProcessTreeCancellation(trackedProcessesExited: false, requiresCheck: true,
                    usedEscalation: false, trackedCount: nodes.count, reasonCodes: ["monitoring_finished"])
                return Task { result }
            }
            // A full cleanup cannot race the prompt stop's final root CONT.
            // Latch priority under the same lock; the prompt worker never waits
            // for this full worker, so this join cannot form a cycle.
            let previous = descendantStop
            let task = Task.detached { [self] in
                if let previous { _ = await previous.value }
                return await cancelRecordedTree(skipNativeInterrupt: previous != nil)
            }
            cancellation = task; return task
        }
        // Caller cancellation cannot abandon a partially frozen owned tree.
        return await work.value
    }

    func requestOwnedDescendantStop() async -> CodexProcessTreeDescendantStop {
        let work = synchronized { () -> Task<CodexProcessTreeDescendantStop, Never> in
            if let descendantStop { return descendantStop }
            guard monitoring, !finishRequested, cancellation == nil else {
                let result = CodexProcessTreeDescendantStop(descendantsExited: false, rootAvailable: false,
                    requiresCheck: true, trackedCount: nodes.count,
                    reasonCodes: [monitoring ? "cancellation_started" : "monitoring_finished"])
                return Task { result }
            }
            let task = Task.detached { [self] in await stopRecordedDescendants() }
            descendantStop = task; return task
        }
        // Do not abandon a frozen root or subtree if the protocol times out.
        // Full cancellation joins this same worker before escalating.
        return await work.value
    }

    private func descendantResult(rootAvailable: Bool) -> CodexProcessTreeDescendantStop {
        let exited = allDescendantsExited()
        return synchronized {
            CodexProcessTreeDescendantStop(descendantsExited: exited, rootAvailable: rootAvailable,
                requiresCheck: !exited || !rootAvailable || !reasons.isEmpty,
                trackedCount: nodes.count, reasonCodes: reasons.sorted())
        }
    }

    private func allDescendantsExited() -> Bool {
        synchronized {
            var exited = true
            for node in nodes.values where node.identity.pid != root.pid {
                do {
                    if let current = try backend.identity(node.identity.pid) {
                        if !node.identity.isSameProcess(as: current) { reasons.insert("identity_changed") }
                        else if !current.zombie { exited = false }
                    }
                } catch { reasons.insert("identity_unavailable"); exited = false }
            }
            return exited
        }
    }

    private func stopRecordedDescendants() async -> CodexProcessTreeDescendantStop {
        captureNow()
        let rootStoppedByUs = synchronized { () -> Bool in
            guard reasons.isEmpty, let node = nodes[root.pid], let current = liveLocked(node) else { return false }
            // Never resume a process another actor had already stopped.
            guard !current.stopped else { reasons.insert("root_already_stopped"); return false }
            guard signalLocked(node, SIGSTOP) else { reasons.insert("root_freeze_unconfirmed"); return false }
            frozen.insert(root.pid)
            return true
        }
        guard rootStoppedByUs else { return descendantResult(rootAvailable: false) }

        // SIGSTOP delivery is asynchronous. Verify the root is stopped before
        // touching any command: a live parent must not advance after a leaf dies.
        var rootIsStopped = false
        for _ in 0..<10 {
            rootIsStopped = synchronized {
                guard let node = nodes[root.pid], let current = liveLocked(node) else { return false }
                return current.stopped
            }
            if rootIsStopped { break }
            try? await Task.sleep(for: .milliseconds(10))
        }
        guard rootIsStopped else {
            _ = synchronized { reasons.insert("root_freeze_unconfirmed") }
            return descendantResult(rootAvailable: false)
        }

        // Freeze parents before children, discover forks already in flight, and
        // require two stable frozen observations. No child is ever resumed.
        var stablePasses = 0
        for _ in 0..<8 {
            let before = synchronized { nodes.count }
            captureNow()
            synchronized {
                for node in nodes.values.sorted(by: { $0.depth < $1.depth }) where node.identity.pid != root.pid {
                    if let current = liveLocked(node), !current.stopped {
                        if signalLocked(node, SIGSTOP) { frozen.insert(node.identity.pid) }
                        else { reasons.insert("freeze_unconfirmed") }
                    }
                }
            }
            try? await Task.sleep(for: .milliseconds(20))
            captureNow()
            let stable = synchronized { () -> Bool in
                guard reasons.isEmpty, nodes.count == before else { return false }
                return nodes.values.allSatisfy { node in
                    guard let current = liveLocked(node) else { return true }
                    return current.stopped
                } && reasons.isEmpty
            }
            stablePasses = stable ? stablePasses + 1 : 0
            if stablePasses >= 2 { break }
        }
        guard stablePasses >= 2 else {
            _ = synchronized { reasons.insert("freeze_unconfirmed") }
            return descendantResult(rootAvailable: false)
        }

        synchronized {
            var blocked = Set<pid_t>()
            for node in nodes.values.sorted(by: { $0.depth < $1.depth }) where node.identity.pid != root.pid {
                if blocked.contains(node.identity.parentPID) { blocked.insert(node.identity.pid); continue }
                do {
                    guard let current = try backend.identity(node.identity.pid), !current.zombie else { continue }
                    guard node.identity.isSameProcess(as: current), current.stopped else {
                        reasons.insert("identity_or_freeze_unconfirmed"); blocked.insert(node.identity.pid); continue
                    }
                    do { _ = try backend.signal(node.identity.pid, SIGKILL) }
                    catch { reasons.insert("signal_failed"); blocked.insert(node.identity.pid) }
                } catch { reasons.insert("identity_unavailable"); blocked.insert(node.identity.pid) }
            }
        }
        let deadline = ProcessInfo.processInfo.systemUptime + max(0, min(2, timing.killConfirmation))
        while !allDescendantsExited(), ProcessInfo.processInfo.systemUptime < deadline {
            try? await Task.sleep(for: .milliseconds(10))
        }
        let descendantsExited = allDescendantsExited()
        let resumed = synchronized { () -> Bool in
            guard descendantsExited, reasons.isEmpty, monitoring, cancellation == nil,
                  frozen.contains(root.pid), let node = nodes[root.pid], let current = liveLocked(node),
                  current.stopped, reasons.isEmpty else {
                if !descendantsExited { reasons.insert("descendant_exit_unconfirmed") }
                return false
            }
            // The full worker's priority and exact birth are checked in the
            // same lock immediately before this one permitted CONT.
            guard signalLocked(node, SIGCONT) else { reasons.insert("root_resume_unconfirmed"); return false }
            frozen.remove(root.pid)
            return true
        }
        return descendantResult(rootAvailable: resumed)
    }

    private func captureLocked() {
        var queue = nodes.values.sorted { $0.depth < $1.depth }, index = 0
        while index < queue.count {
            let parent = queue[index]; index += 1
            do {
                guard let liveParent = try backend.identity(parent.identity.pid), !liveParent.zombie else { continue }
                guard parent.identity.isSameProcess(as: liveParent) else { reasons.insert("identity_changed"); continue }
                for pid in try backend.children(of: liveParent.pid) {
                    guard let child = try backend.identity(pid), !child.zombie else { continue }
                    // PPID is only a number. The parent may exit and its PID
                    // be reused while enumerating: bracket child observation
                    // with the same kernel parent birth/uid before attaching.
                    guard let parentAfter = try backend.identity(liveParent.pid),
                          liveParent.isSameProcess(as: parentAfter), !parentAfter.zombie else {
                        reasons.insert("ancestry_unconfirmed"); continue
                    }
                    guard child.parentPID == liveParent.pid, child.uid == root.uid, child.realUID == root.realUID,
                          child.wasBornAfter(liveParent), pid != getpid() else { reasons.insert("ancestry_unconfirmed"); continue }
                    if let previous = nodes[pid] {
                        if !previous.identity.isSameProcess(as: child) { reasons.insert("identity_changed") }
                        continue
                    }
                    guard nodes.count < maximumTracked else { reasons.insert("limit_exceeded"); continue }
                    let node = Node(identity: child, depth: parent.depth + 1); nodes[pid] = node; queue.append(node)
                }
            } catch { reasons.insert("enumeration_failed") }
        }
    }

    private func liveLocked(_ node: Node) -> CodexProcessIdentity? {
        do {
            guard let current = try backend.identity(node.identity.pid), !current.zombie else { return nil }
            guard node.identity.isSameProcess(as: current) else { reasons.insert("identity_changed"); return nil }
            return current
        } catch { reasons.insert("identity_unavailable"); return nil }
    }

    @discardableResult private func signalLocked(_ node: Node, _ signal: Int32) -> Bool {
        guard liveLocked(node) != nil else { return false }
        do { return try backend.signal(node.identity.pid, signal) }
        catch { reasons.insert("signal_failed"); return false }
    }

    private func allTrackedExited() -> Bool {
        synchronized {
            var allExited = true
            for node in nodes.values {
                do {
                    if let current = try backend.identity(node.identity.pid) {
                        if !node.identity.isSameProcess(as: current) { reasons.insert("identity_changed") }
                        else if !current.zombie { allExited = false }
                    }
                } catch { reasons.insert("identity_unavailable"); allExited = false }
            }
            return allExited
        }
    }

    private func waitForTrackedExit(_ seconds: TimeInterval) async -> Bool {
        let deadline = ProcessInfo.processInfo.systemUptime + max(0, min(5, seconds))
        repeat {
            captureNow()
            if allTrackedExited() { return true }
            do { try await Task.sleep(for: .milliseconds(25)) } catch { break }
        } while ProcessInfo.processInfo.systemUptime < deadline
        return allTrackedExited()
    }

    private func result(escalated: Bool) -> CodexProcessTreeCancellation {
        let exited = allTrackedExited()
        return synchronized {
            CodexProcessTreeCancellation(trackedProcessesExited: exited, requiresCheck: !exited || !reasons.isEmpty,
                usedEscalation: escalated, trackedCount: nodes.count, reasonCodes: reasons.sorted())
        }
    }

    private func cancelRecordedTree(skipNativeInterrupt: Bool = false) async -> CodexProcessTreeCancellation {
        captureNow()
        // Give Codex its native turn/interrupt path once, before forceful cleanup.
        // The managed prompt worker is invoked only after the protocol already
        // acknowledged interruption. Its unknown path must not grant a still-
        // live command a second 3.5-second grace to perform more side effects.
        if !skipNativeInterrupt {
            synchronized { if let root = nodes[root.pid] { signalLocked(root, SIGINT) } }
            if await waitForTrackedExit(timing.interruptGrace) { return result(escalated: false) }
        }

        // Killing only sleep can advance a still-running parent shell into its
        // next write. Freeze exact parents first and discover last children.
        // KILL shallow-first: never let a failed freeze turn leaf termination
        // into permission for a still-live ancestor to run the next command.
        for _ in 0..<3 {
            captureNow()
            synchronized {
                for node in nodes.values.sorted(by: { $0.depth < $1.depth }) {
                    if let current = liveLocked(node), !current.stopped, signalLocked(node, SIGSTOP) {
                        frozen.insert(node.identity.pid)
                    }
                }
            }
            do { try await Task.sleep(for: .milliseconds(20)) } catch { }
        }
        captureNow()
        synchronized {
            for node in nodes.values {
                if let current = liveLocked(node), !current.stopped { reasons.insert("freeze_unconfirmed") }
            }
        }
        // A frozen process cannot run a TERM handler; skip a pointless grace.
        // If an ancestor cannot be verified/killed, do not kill its leaves and
        // inadvertently advance it. Cleanup stays unknown rather than CONT.
        synchronized {
            var blocked = Set<pid_t>()
            for node in nodes.values.sorted(by: { $0.depth < $1.depth }) {
                if blocked.contains(node.identity.parentPID) { blocked.insert(node.identity.pid); continue }
                do {
                    guard let current = try backend.identity(node.identity.pid), !current.zombie else { continue }
                    guard node.identity.isSameProcess(as: current) else {
                        reasons.insert("identity_changed")
                        if current.startedSeconds == node.identity.startedSeconds && current.startedMicroseconds == node.identity.startedMicroseconds { blocked.insert(node.identity.pid) }
                        continue
                    }
                    do { _ = try backend.signal(node.identity.pid, SIGKILL) }
                    catch { reasons.insert("signal_failed"); blocked.insert(node.identity.pid) }
                } catch { reasons.insert("identity_unavailable"); blocked.insert(node.identity.pid) }
            }
        }
        let exited = await waitForTrackedExit(timing.killConfirmation)
        synchronized {
            if !exited { reasons.insert("exit_unconfirmed") }
            for pid in frozen {
                if let node = nodes[pid], let current = liveLocked(node), current.stopped { reasons.insert("frozen_cleanup_unconfirmed") }
            }
        }
        return result(escalated: true)
    }
}
