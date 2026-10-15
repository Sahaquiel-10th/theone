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
    private var observer: Task<Void, Never>?
    private var cancellation: Task<CodexProcessTreeCancellation, Never>?

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

    // stop observing on normal run cleanup; never abandon an in-flight cancel.
    // finish() does not terminate a process or erase cancellation evidence.
    func finish() { synchronized { monitoring = false; observer?.cancel(); observer = nil } }

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
            guard monitoring else {
                let result = CodexProcessTreeCancellation(trackedProcessesExited: false, requiresCheck: true,
                    usedEscalation: false, trackedCount: nodes.count, reasonCodes: ["monitoring_finished"])
                return Task { result }
            }
            let task = Task.detached { [self] in await cancelRecordedTree() }
            cancellation = task; return task
        }
        // Caller cancellation cannot abandon a partially frozen owned tree.
        return await work.value
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

    private func cancelRecordedTree() async -> CodexProcessTreeCancellation {
        captureNow()
        // Give Codex its native turn/interrupt path once, before forceful cleanup.
        synchronized { if let root = nodes[root.pid] { signalLocked(root, SIGINT) } }
        if await waitForTrackedExit(timing.interruptGrace) { return result(escalated: false) }

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
