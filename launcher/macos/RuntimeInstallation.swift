// The file commit and the progress notification are different operations.
// A notification failure must not undo or prevent the committed hand-off.
import Foundation
import Darwin

// A signed app executable is not a standalone signed command: its signature
// seals Info.plist and Resources too. Keep the whole bundle for macOS TCC.
func prepareRuntimeResidentBundle(source: URL, target: URL, verify: (URL) throws -> Void) throws -> URL {
    let executable = "Contents/MacOS/ONE"
    try verify(source)
    if FileManager.default.fileExists(atPath: target.path),
       (try? verify(target)) != nil,
       (try? Data(contentsOf: target.appendingPathComponent(executable))) == (try Data(contentsOf: source.appendingPathComponent(executable))),
       (try? Data(contentsOf: target.appendingPathComponent("Contents/Info.plist"))) == (try Data(contentsOf: source.appendingPathComponent("Contents/Info.plist"))) {
        return target.appendingPathComponent(executable)
    }
    let parent = target.deletingLastPathComponent()
    let staging = parent.appendingPathComponent(".ONE-resident-\(UUID().uuidString).app")
    let backup = parent.appendingPathComponent(".ONE-resident-backup-\(UUID().uuidString).app")
    defer { try? FileManager.default.removeItem(at: staging) }
    try FileManager.default.copyItem(at: source, to: staging)
    try verify(staging)
    let existing = FileManager.default.fileExists(atPath: target.path)
    if existing { try FileManager.default.moveItem(at: target, to: backup) }
    do {
        try FileManager.default.moveItem(at: staging, to: target)
    } catch {
        if existing { try? FileManager.default.moveItem(at: backup, to: target) }
        throw error
    }
    if existing { try? FileManager.default.removeItem(at: backup) }
    return target.appendingPathComponent(executable)
}

// Both ordinary launch and update hand-off use the exact verified executable,
// not LaunchServices' cached bundle identity (shared by all portable Keys).
func prepareRuntimeResident(source: URL, target: URL) throws {
    if (try? Data(contentsOf: target)) == (try Data(contentsOf: source)) { return }
    let temporary = target.deletingLastPathComponent().appendingPathComponent(".ONEPresence-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: temporary) }
    try FileManager.default.copyItem(at: source, to: temporary)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: temporary.path)
    guard rename(temporary.path, target.path) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
}

// Do not use a task group here: its scope waits for all children, including a
// socket operation that does not respond to cancellation. Only the first
// outcome is allowed to resume the caller; late callbacks are harmless.
private final class RuntimeOutcome<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<T, Error>?
    init(_ continuation: CheckedContinuation<T, Error>) { self.continuation = continuation }
    func resolve(_ result: Result<T, Error>) {
        lock.lock()
        let waiting = continuation
        continuation = nil
        lock.unlock()
        waiting?.resume(with: result)
    }
}

enum RuntimeOperationError: Error { case timeout }

func boundedRuntimeOperation<T: Sendable>(timeout: Duration, operation: @escaping @Sendable () async throws -> T) async throws -> T {
    try await withCheckedThrowingContinuation { continuation in
        let outcome = RuntimeOutcome(continuation)
        let work = Task {
            do { outcome.resolve(.success(try await operation())) }
            catch { outcome.resolve(.failure(error)) }
        }
        Task {
            do { try await Task.sleep(for: timeout) } catch { return }
            outcome.resolve(.failure(RuntimeOperationError.timeout))
            work.cancel()
        }
    }
}

enum RuntimeSocketOutcome: Sendable { case message(String), installed(URL) }

func runtimeMessageOrInstallation(installation: Task<URL, Error>, receive: @escaping @Sendable () async throws -> String) async throws -> RuntimeSocketOutcome {
    try await withCheckedThrowingContinuation { continuation in
        let outcome = RuntimeOutcome(continuation)
        let reader = Task {
            do { outcome.resolve(.success(.message(try await receive()))) }
            catch { outcome.resolve(.failure(error)) }
        }
        Task {
            do { outcome.resolve(.success(.installed(try await installation.value))) }
            catch { outcome.resolve(.failure(error)) }
            reader.cancel()
        }
    }
}

final class RuntimeInstallActivity: @unchecked Sendable {
    private let lock = NSLock()
    private var running = false
    var active: Bool { lock.lock(); defer { lock.unlock() }; return running }
    func begin() -> Bool { lock.lock(); defer { lock.unlock() }; if running { return false }; running = true; return true }
    func end() { lock.lock(); running = false; lock.unlock() }
}
let runtimeInstallActivity = RuntimeInstallActivity()
func committedRuntimeInstallation<T>(install: () async throws -> T, reportCompletion: () async throws -> Void) async throws -> T {
    let installed = try await install()
    try? await reportCompletion()
    return installed
}
