import Foundation
import CryptoKit

// The journal lives on the computer, not on the removable disk. It contains
// hashes only, never credentials, and is bound to the exact Key bytes.
struct MacRuntimeRecovery: Codable {
    let requestId: String
    let version: String
    let credentialHash: String
    let previousName: String
    let previousHash: String
    let installedHash: String
}
func runtimeFileHash(_ url: URL) throws -> String {
    SHA256.hash(data: try Data(contentsOf: url)).map { String(format: "%02x", $0) }.joined()
}
func runtimeExecutable(_ app: URL) -> URL { app.appendingPathComponent("Contents/MacOS/ONE") }
func prepareMacRuntimeRecovery(credential: URL, staged: URL, journal: URL, requestId: String = "", version: String = "") throws -> MacRuntimeRecovery {
    let root = credential.deletingLastPathComponent().deletingLastPathComponent()
    let record = MacRuntimeRecovery(requestId: requestId, version: version, credentialHash: try runtimeFileHash(credential), previousName: ".one-macos-previous-\(UUID().uuidString).app", previousHash: try runtimeFileHash(runtimeExecutable(root.appendingPathComponent("ONE for Mac.app"))), installedHash: try runtimeFileHash(runtimeExecutable(staged)))
    try FileManager.default.createDirectory(at: journal.deletingLastPathComponent(), withIntermediateDirectories: true)
    try JSONEncoder().encode(record).write(to: journal, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: journal.path)
    return record
}
func recoverMacRuntime(credential: URL, journal: URL, preferPrevious: Bool = false, verify: (URL) throws -> Void) throws -> (record: MacRuntimeRecovery, status: String)? {
    let manager = FileManager.default
    guard manager.fileExists(atPath: journal.path) else { return nil }
    let record = try JSONDecoder().decode(MacRuntimeRecovery.self, from: Data(contentsOf: journal))
    let name = record.previousName
    guard name.hasPrefix(".one-macos-previous-"), name.hasSuffix(".app"),
          UUID(uuidString: String(name.dropFirst(".one-macos-previous-".count).dropLast(4))) != nil,
          try runtimeFileHash(credential) == record.credentialHash else {
        throw NSError(domain: "ONERecovery", code: 1, userInfo: [NSLocalizedDescriptionKey: "更新恢复记录与当前 Key 不匹配，未修改启动器"])
    }
    let root = credential.deletingLastPathComponent().deletingLastPathComponent()
    let target = root.appendingPathComponent("ONE for Mac.app")
    let currentHash = try? runtimeFileHash(runtimeExecutable(target))
    if currentHash == record.previousHash || (!preferPrevious && currentHash == record.installedHash) {
        do {
            try verify(target)
            return (record, currentHash == record.installedHash ? "completed" : "failed")
        } catch { /* A matching executable alone does not validate the bundle. */ }
    }
    let previous = root.appendingPathComponent(name)
    guard try runtimeFileHash(runtimeExecutable(previous)) == record.previousHash else {
        throw NSError(domain: "ONERecovery", code: 2, userInfo: [NSLocalizedDescriptionKey: "更新备份未通过校验，未修改启动器"])
    }
    try verify(previous)
    // Preserve any incomplete bundle rather than deleting user-visible files.
    if manager.fileExists(atPath: target.path) {
        try manager.moveItem(at: target, to: root.appendingPathComponent(".one-macos-interrupted-\(UUID().uuidString).app"))
    }
    try manager.moveItem(at: previous, to: target)
    try verify(target)
    return (record, "failed")
}

func acknowledgeMacRecovery(credential: URL, journal: URL, requestId: String) throws {
    guard FileManager.default.fileExists(atPath: journal.path) else { return }
    let record = try JSONDecoder().decode(MacRuntimeRecovery.self, from: Data(contentsOf: journal))
    guard record.requestId == requestId, try runtimeFileHash(credential) == record.credentialHash else { return }
    try FileManager.default.removeItem(at: journal)
}
