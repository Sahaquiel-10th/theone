import Foundation

enum LauncherConnectionError: Error { case timeout, staleSession, monitorEnded }

// Transport freshness is not a ONE Key proof. This state grants no authority;
// the server still requires its original, fresh signed request challenge.
final class LauncherConnectionLiveness: @unchecked Sendable {
    let sessionID: UUID
    private let lock = NSLock()
    private let freshness: TimeInterval
    private var active = true
    private var lastEvidence: TimeInterval
    private var invalidationWaiters: [UUID: @Sendable () -> Void] = [:]

    init(sessionID: UUID, now: TimeInterval, freshness: TimeInterval = 15) {
        self.sessionID = sessionID; lastEvidence = now; self.freshness = freshness
    }
    func isActive(sessionID: UUID) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return active && self.sessionID == sessionID
    }
    @discardableResult func recordEvidence(sessionID: UUID, now: TimeInterval) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard active, self.sessionID == sessionID, now.isFinite, now >= lastEvidence else { return false }
        lastEvidence = now; return true
    }
    func isFresh(sessionID: UUID, now: TimeInterval) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return active && self.sessionID == sessionID && now >= lastEvidence && now - lastEvidence <= freshness
    }
    @discardableResult func invalidate(sessionID: UUID) -> Bool {
        lock.lock()
        guard active, self.sessionID == sessionID else { lock.unlock(); return false }
        active = false
        let waiting = Array(invalidationWaiters.values); invalidationWaiters = [:]
        lock.unlock()
        waiting.forEach { $0() }; return true
    }
    func waitForInvalidation(sessionID: UUID) async throws {
        let waiterID = UUID(), outcome = LauncherOperationOutcome<Void>()
        defer { removeWaiter(waiterID) }
        try await withTaskCancellationHandler(operation: {
            try Task.checkCancellation()
            try await withCheckedThrowingContinuation { continuation in
                outcome.install(continuation)
                registerWaiter(waiterID, sessionID: sessionID) { outcome.resolve(.failure(LauncherConnectionError.staleSession)) }
            }
        }, onCancel: { self.removeWaiter(waiterID); outcome.resolve(.failure(CancellationError())) })
    }
    private func registerWaiter(_ id: UUID, sessionID: UUID, callback: @escaping @Sendable () -> Void) {
        lock.lock()
        guard active, self.sessionID == sessionID else { lock.unlock(); callback(); return }
        invalidationWaiters[id] = callback; lock.unlock()
    }
    private func removeWaiter(_ id: UUID) { lock.lock(); invalidationWaiters.removeValue(forKey: id); lock.unlock() }
}

// Like boundedRuntimeOperation, do not use a task group: Foundation may never
// deliver a cancelled callback. Unlike that fixed-deadline update helper, this
// session race must also release its caller immediately on cancellation.
private final class LauncherOperationOutcome<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<T, Error>?
    private var finished: Result<T, Error>?
    private var workers: [Task<Void, Never>] = []

    func install(_ continuation: CheckedContinuation<T, Error>) {
        lock.lock()
        if let result = finished { lock.unlock(); continuation.resume(with: result); return }
        self.continuation = continuation; lock.unlock()
    }
    func add(_ worker: Task<Void, Never>) {
        lock.lock()
        if finished != nil { lock.unlock(); worker.cancel(); return }
        workers.append(worker); lock.unlock()
    }
    func resolve(_ result: Result<T, Error>) {
        lock.lock()
        guard finished == nil else { lock.unlock(); return }
        finished = result
        let waiting = continuation, children = workers
        continuation = nil; workers = []
        lock.unlock()
        children.forEach { $0.cancel() }
        waiting?.resume(with: result)
    }
}

func launcherSessionOperation<T: Sendable>(operation: @escaping @Sendable () async throws -> T,
    monitor: @escaping @Sendable () async throws -> Void) async throws -> T {
    let outcome = LauncherOperationOutcome<T>()
    return try await withTaskCancellationHandler(operation: {
        try Task.checkCancellation()
        return try await withCheckedThrowingContinuation { continuation in
            outcome.install(continuation)
            outcome.add(Task {
                do { try Task.checkCancellation(); outcome.resolve(.success(try await operation())) }
                catch { outcome.resolve(.failure(error)) }
            })
            outcome.add(Task {
                do { try Task.checkCancellation(); try await monitor(); outcome.resolve(.failure(LauncherConnectionError.monitorEnded)) }
                catch { outcome.resolve(.failure(error)) }
            })
        }
    }, onCancel: { outcome.resolve(.failure(CancellationError())) })
}

func boundedLauncherOperation<T: Sendable>(timeout: Duration,
    operation: @escaping @Sendable () async throws -> T) async throws -> T {
    try await launcherSessionOperation(operation: operation, monitor: {
        try await Task.sleep(for: timeout)
        throw LauncherConnectionError.timeout
    })
}
