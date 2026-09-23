// The file commit and the progress notification are different operations.
// A notification failure must not undo or prevent the committed hand-off.
import Foundation

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
