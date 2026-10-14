import Foundation
import Darwin

private actor CallbackGate<Value: Sendable> {
    private var started = false
    private var value: Value?
    private var callback: CheckedContinuation<Value, Never>?
    private var observers: [CheckedContinuation<Void, Never>] = []

    func waitIgnoringCancellation() async -> Value {
        started = true
        let waiting = observers; observers = []
        waiting.forEach { $0.resume() }
        if let value { return value }
        return await withCheckedContinuation { callback = $0 }
    }
    func waitUntilStarted() async {
        if started { return }
        await withCheckedContinuation { observers.append($0) }
    }
    func release(_ result: Value) {
        value = result
        let waiting = callback; callback = nil
        waiting?.resume(returning: result)
    }
}

private final class MockURLRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var opened = 0
    func open() { lock.lock(); opened += 1; lock.unlock() }
    func count() -> Int { lock.lock(); defer { lock.unlock() }; return opened }
}

@main struct LauncherConnectionLivenessTests {
    static func checkFast(_ began: ContinuousClock.Instant, _ label: String) {
        precondition(began.duration(to: ContinuousClock.now) < .seconds(1), "\(label) waited for a non-cooperative callback")
    }

    static func testSessionEvidence() {
        let session = UUID(), other = UUID()
        let live = LauncherConnectionLiveness(sessionID: session, now: 100)
        precondition(live.isActive(sessionID: session))
        precondition(!live.isActive(sessionID: other))
        precondition(!live.recordEvidence(sessionID: other, now: 101))
        precondition(!live.invalidate(sessionID: other))
        precondition(!live.recordEvidence(sessionID: session, now: 99))
        precondition(!live.recordEvidence(sessionID: session, now: .nan))
        precondition(!live.recordEvidence(sessionID: session, now: .infinity))
        precondition(live.isFresh(sessionID: session, now: 115))
        precondition(!live.isFresh(sessionID: session, now: 115.001))
        precondition(!live.isFresh(sessionID: session, now: 99))
        precondition(live.invalidate(sessionID: session))
        precondition(!live.invalidate(sessionID: session))
        precondition(!live.recordEvidence(sessionID: session, now: 1000))
        precondition(!live.isFresh(sessionID: session, now: 1000))
        precondition(!live.isActive(sessionID: session))
        let replacement = LauncherConnectionLiveness(sessionID: other, now: 1000)
        precondition(!replacement.recordEvidence(sessionID: session, now: 1001))
        precondition(!replacement.invalidate(sessionID: session))
        precondition(replacement.isActive(sessionID: other))
    }

    static func testIdlePongEvidence() {
        let session = UUID()
        let current = LauncherConnectionLiveness(sessionID: session, now: 0)
        for second in stride(from: 5, through: 600, by: 5) {
            precondition(current.recordEvidence(sessionID: session, now: TimeInterval(second)))
            precondition(current.isFresh(sessionID: session, now: TimeInterval(second) + 4.9))
        }
        precondition(current.isActive(sessionID: session), "idle transport with simulated pong evidence must remain live")
        precondition(!current.isFresh(sessionID: session, now: 616), "missing pong evidence must eventually become stale")
    }

    static func testTimeoutAndLateCallback() async throws {
        let callback = CallbackGate<Int>(), began = ContinuousClock.now
        do {
            _ = try await boundedLauncherOperation(timeout: .milliseconds(40)) { await callback.waitIgnoringCancellation() }
            fatalError("missing callback incorrectly completed")
        } catch LauncherConnectionError.timeout { }
        checkFast(began, "bounded timeout")
        await callback.release(99)
        try await Task.sleep(for: .milliseconds(20))
        let next = try await boundedLauncherOperation(timeout: .seconds(1)) { 17 }
        precondition(next == 17, "a late callback must not replace an already-delivered timeout or poison the next operation")
    }

    static func testNoPongReleasesBlockedReader() async throws {
        let session = UUID()
        let live = LauncherConnectionLiveness(sessionID: session, now: 0)
        let reader = CallbackGate<Int>(), began = ContinuousClock.now
        do {
            _ = try await launcherSessionOperation(operation: { await reader.waitIgnoringCancellation() }, monitor: {
                try await Task.sleep(for: .milliseconds(30))
                guard live.isFresh(sessionID: session, now: 16) else { throw LauncherConnectionError.staleSession }
            })
            fatalError("a stale session incorrectly completed")
        } catch LauncherConnectionError.staleSession { }
        checkFast(began, "no-pong session monitor")
        await reader.release(42)
        try await Task.sleep(for: .milliseconds(20))
        let missingPong = LauncherConnectionLiveness(sessionID: session, now: 0)
        precondition(!missingPong.isFresh(sessionID: session, now: 16))
    }

    static func testOperationFirstAndMonitorEnd() async throws {
        let monitorCallback = CallbackGate<Int>()
        let answer = try await launcherSessionOperation(operation: { 23 }, monitor: {
            _ = await monitorCallback.waitIgnoringCancellation()
        })
        precondition(answer == 23)
        await monitorCallback.release(1)
        let reader = CallbackGate<Int>()
        do {
            _ = try await launcherSessionOperation(operation: { await reader.waitIgnoringCancellation() }, monitor: { })
            fatalError("a normally-ended monitor incorrectly represented a live session")
        } catch LauncherConnectionError.monitorEnded { }
        await reader.release(2)
        try await Task.sleep(for: .milliseconds(20))
    }

    static func testBoundedCallerCancellation() async throws {
        let callback = CallbackGate<Int>()
        let request = Task { try await boundedLauncherOperation(timeout: .seconds(5)) { await callback.waitIgnoringCancellation() } }
        await callback.waitUntilStarted()
        let began = ContinuousClock.now
        request.cancel()
        do { _ = try await request.value; fatalError("bounded operation ignored caller cancellation") }
        catch is CancellationError { }
        checkFast(began, "bounded caller cancellation")
        await callback.release(77)
        try await Task.sleep(for: .milliseconds(20))
    }

    static func testWholeSessionCancellation() async throws {
        let reader = CallbackGate<Int>(), monitor = CallbackGate<Int>()
        let request = Task {
            try await launcherSessionOperation(operation: { await reader.waitIgnoringCancellation() }, monitor: {
                _ = await monitor.waitIgnoringCancellation()
            })
        }
        await reader.waitUntilStarted(); await monitor.waitUntilStarted()
        let began = ContinuousClock.now
        request.cancel()
        do { _ = try await request.value; fatalError("session ignored caller cancellation") }
        catch is CancellationError { }
        checkFast(began, "whole-session cancellation")
        await reader.release(88); await monitor.release(1)
        try await Task.sleep(for: .milliseconds(20))
    }

    static func testInvalidationReleasesWaiter() async throws {
        let session = UUID()
        let live = LauncherConnectionLiveness(sessionID: session, now: 0)
        let waiter = Task { try await live.waitForInvalidation(sessionID: session) }
        try await Task.sleep(for: .milliseconds(15))
        precondition(live.isActive(sessionID: session))
        let began = ContinuousClock.now
        precondition(live.invalidate(sessionID: session))
        do { try await waiter.value; fatalError("invalidated waiter completed without stale-session error") }
        catch LauncherConnectionError.staleSession { }
        checkFast(began, "invalidation waiter")
        do { try await live.waitForInvalidation(sessionID: session); fatalError("late waiter revived an invalidated session") }
        catch LauncherConnectionError.staleSession { }
        precondition(!live.recordEvidence(sessionID: session, now: 1))
    }

    static func testWrongSessionWaiter() async throws {
        let session = UUID()
        let live = LauncherConnectionLiveness(sessionID: session, now: 0)
        let began = ContinuousClock.now
        do { try await live.waitForInvalidation(sessionID: UUID()); fatalError("wrong-session waiter did not fail immediately") }
        catch LauncherConnectionError.staleSession { }
        checkFast(began, "wrong-session invalidation waiter")
        precondition(live.isActive(sessionID: session))
        precondition(live.recordEvidence(sessionID: session, now: 1))
        precondition(live.isFresh(sessionID: session, now: 2))
    }

    static func testCancelledWaiterDoesNotInvalidateSession() async throws {
        let session = UUID()
        let live = LauncherConnectionLiveness(sessionID: session, now: 0)
        for started in [false, true] {
            let waiter = Task { try await live.waitForInvalidation(sessionID: session) }
            if started { try await Task.sleep(for: .milliseconds(15)) }
            let began = ContinuousClock.now
            waiter.cancel()
            do { try await waiter.value; fatalError("cancelled invalidation waiter ignored caller cancellation") }
            catch is CancellationError { }
            checkFast(began, "cancelled invalidation waiter")
            precondition(live.isActive(sessionID: session))
            precondition(live.recordEvidence(sessionID: session, now: 1))
        }
        let replacementWaiter = Task { try await live.waitForInvalidation(sessionID: session) }
        try await Task.sleep(for: .milliseconds(15))
        precondition(live.invalidate(sessionID: session))
        do { try await replacementWaiter.value; fatalError("a new waiter stopped working after earlier waiters were cancelled") }
        catch LauncherConnectionError.staleSession { }
        precondition(!live.isActive(sessionID: session))
    }

    static func testSlowLoginBoundary() async throws {
        let session = UUID()
        let current = LauncherConnectionLiveness(sessionID: session, now: 0)
        let loginCallback = CallbackGate<String>(), recorder = MockURLRecorder()
        let login = Task {
            _ = await loginCallback.waitIgnoringCancellation()
            guard current.isActive(sessionID: session) else { return false }
            recorder.open(); return true
        }
        await loginCallback.waitUntilStarted()
        let began = ContinuousClock.now
        let mockProofHandled = try await boundedLauncherOperation(timeout: .milliseconds(100)) {
            current.recordEvidence(sessionID: session, now: 1)
        }
        precondition(mockProofHandled)
        checkFast(began, "independent mock proof while login is slow")
        precondition(current.invalidate(sessionID: session))
        precondition(!current.isActive(sessionID: session))
        await loginCallback.release("https://one.example/mock-login")
        let didOpen = await login.value
        precondition(didOpen == false, "invalidated session must reject a late mock login callback")
        precondition(recorder.count() == 0)
    }

    static func main() async throws {
        alarm(12)
        defer { alarm(0) }
        testSessionEvidence()
        testIdlePongEvidence()
        try await testTimeoutAndLateCallback()
        try await testNoPongReleasesBlockedReader()
        try await testOperationFirstAndMonitorEnd()
        try await testBoundedCallerCancellation()
        try await testWholeSessionCancellation()
        try await testInvalidationReleasesWaiter()
        try await testWrongSessionWaiter()
        try await testCancelledWaiterDoesNotInvalidateSession()
        try await testSlowLoginBoundary()
        print("Mac launcher connection helper tests passed (11 cases: session binding, idle pong, timeout, late callback, monitor, cancellation, invalidation waiters, mock login gate)")
    }
}
