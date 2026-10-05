import Foundation

@main struct RuntimeRecoveryTests {
    static func app(_ url: URL, _ content: String) throws {
        try FileManager.default.createDirectory(at: runtimeExecutable(url).deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(content.utf8).write(to: runtimeExecutable(url))
    }
    static func main() throws {
        let manager = FileManager.default
        for phase in ["before", "missing", "partial", "complete", "invalid-resources", "launch-failed"] {
            let local = manager.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? manager.removeItem(at: local) }
            let root = local.appendingPathComponent("volume"), credential = root.appendingPathComponent(".one/credential.json")
            try manager.createDirectory(at: credential.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data("key-one".utf8).write(to: credential)
            let target = root.appendingPathComponent("ONE for Mac.app"), staged = root.appendingPathComponent("staged.app"), journal = local.appendingPathComponent("record.json")
            try app(target, "old"); try app(staged, "new")
            let record = try prepareMacRuntimeRecovery(credential: credential, staged: staged, journal: journal)
            if phase != "before" {
                try manager.moveItem(at: target, to: root.appendingPathComponent(record.previousName))
                if phase == "partial" { try app(target, "partial") }
                if ["complete", "invalid-resources", "launch-failed"].contains(phase) { try manager.moveItem(at: staged, to: target) }
            }
            let renamed = local.appendingPathComponent("renamed-volume")
            try manager.moveItem(at: root, to: renamed)
            do { _ = try recoverMacRuntime(credential: credential, journal: journal) { _ in }; fatalError("missing disk recovered") } catch {}
            let returnedCredential = renamed.appendingPathComponent(".one/credential.json")
            let outcome = try recoverMacRuntime(credential: returnedCredential, journal: journal, preferPrevious: phase == "launch-failed") { candidate in
                if phase == "invalid-resources", try String(contentsOf: runtimeExecutable(candidate), encoding: .utf8) == "new" { throw NSError(domain: "bad resources", code: 1) }
            }
            let expected = phase == "complete" ? "new" : "old"
            let result = try String(contentsOf: runtimeExecutable(renamed.appendingPathComponent("ONE for Mac.app")), encoding: .utf8)
            let keyBytes = try Data(contentsOf: returnedCredential)
            precondition(result == expected)
            precondition(keyBytes == Data("key-one".utf8))
            precondition(outcome?.status == (phase == "complete" ? "completed" : "failed"))
            precondition(manager.fileExists(atPath: journal.path), "retain until server acknowledges recovery")
            try acknowledgeMacRecovery(credential: returnedCredential, journal: journal, requestId: "wrong-request")
            precondition(manager.fileExists(atPath: journal.path))
            try acknowledgeMacRecovery(credential: returnedCredential, journal: journal, requestId: "")
            precondition(!manager.fileExists(atPath: journal.path))
        }
        print("Mac interrupted-update recovery tests passed")
    }
}
