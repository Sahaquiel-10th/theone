import Foundation

enum FixtureError: Error { case offline, installFailed }

@main
struct RuntimeInstallationTests {
    static func main() async throws {
        let activity = RuntimeInstallActivity()
        precondition(!activity.active && activity.begin() && activity.active)
        precondition(!activity.begin(), "cannot start two installers")
        activity.end()
        precondition(!activity.active && activity.begin(), "release after join")
        activity.end()
        var installed = false
        let target = try await committedRuntimeInstallation(install: {
            installed = true
            return "verified-new-launcher"
        }, reportCompletion: { throw FixtureError.offline })
        precondition(installed && target == "verified-new-launcher", "lost reporting must still hand off")
        var reported = false
        do {
            let _: String = try await committedRuntimeInstallation(install: { throw FixtureError.installFailed }, reportCompletion: { reported = true })
            fatalError("failed installation must not return a target")
        } catch FixtureError.installFailed {}
        precondition(!reported, "failed installation cannot report success")
        let normal = try await committedRuntimeInstallation(install: { "normal" }, reportCompletion: { reported = true })
        precondition(normal == "normal" && reported)
        let start = Date()
        do {
            let _: String = try await boundedRuntimeOperation(timeout: .milliseconds(30)) {
                // Model a network callback which ignores task cancellation.
                await withCheckedContinuation { continuation in
                    DispatchQueue.global().asyncAfter(deadline: .now() + 0.2) { continuation.resume(returning: "late") }
                }
            }
            fatalError("stuck progress must time out")
        } catch RuntimeOperationError.timeout {}
        precondition(Date().timeIntervalSince(start) < 1)
        let completed = Task<URL, Error> { URL(fileURLWithPath: "/synthetic/new.app") }
        let outcome = try await runtimeMessageOrInstallation(installation: completed, receive: {
            await withCheckedContinuation { continuation in
                DispatchQueue.global().asyncAfter(deadline: .now() + 0.2) { continuation.resume(returning: "late") }
            }
        })
        guard case .installed(let url) = outcome else { fatalError("install must wake a stuck reader") }
        precondition(url.path == "/synthetic/new.app")
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("one-resident-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let source = directory.appendingPathComponent("source"), destination = directory.appendingPathComponent("resident")
        try Data("new verified executable".utf8).write(to: source)
        try Data("stale same-version executable".utf8).write(to: destination)
        try prepareRuntimeResident(source: source, target: destination)
        let expected = try Data(contentsOf: source)
        let copied = try Data(contentsOf: destination)
        precondition(copied == expected)
        do {
            try prepareRuntimeResident(source: directory.appendingPathComponent("missing"), target: destination)
            fatalError("missing source must fail")
        } catch {}
        let preserved = try Data(contentsOf: destination)
        precondition(preserved == expected, "failed preparation must preserve resident")
        print("Runtime installation hand-off tests passed")
    }
}
