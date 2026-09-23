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
        print("Runtime installation hand-off tests passed")
    }
}
