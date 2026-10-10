import Foundation
import Darwin

// Install before launch: a short-lived child may exit before the async caller
// starts awaiting. Do not move Foundation's waitUntilExit between cooperative
// worker threads; its run-loop wait can remain stuck after the child has gone.
final class CodexProcessExit: @unchecked Sendable {
    private let lock = NSLock()
    private var status: Int32?
    private var waiter: CheckedContinuation<Int32, Never>?

    init(process: Process) {
        process.terminationHandler = { [self] process in finish(process.terminationStatus) }
    }

    private func finish(_ value: Int32) {
        lock.lock()
        guard status == nil else { lock.unlock(); return }
        status = value
        let continuation = waiter
        waiter = nil
        lock.unlock()
        continuation?.resume(returning: value)
    }

    func value() async -> Int32 {
        await withCheckedContinuation { continuation in
            lock.lock()
            if let status {
                lock.unlock()
                continuation.resume(returning: status)
            } else {
                precondition(waiter == nil, "Only one exit waiter per process")
                waiter = continuation
                lock.unlock()
            }
        }
    }
}

// Bounded discovery only: no recursive disk search or shell startup scripts.
func codexRuntimeCandidates(saved: String?, resources: URL?, volume: URL, applications: [URL], home: URL, path: String) -> [String] {
    var result = saved.map { [$0] } ?? []
    if let resources { result.append(resources.appendingPathComponent("codex").path) }
    for name in ["ONE for Mac.app", "ONE.app"] {
        result.append(volume.appendingPathComponent("\(name)/Contents/Resources/codex").path)
    }
    for app in applications {
        for suffix in ["Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex", "Contents/Resources/codex", "Contents/MacOS/codex"] {
            result.append(app.appendingPathComponent(suffix).path)
        }
    }
    result += ["/opt/homebrew/bin/codex", "/usr/local/bin/codex", home.appendingPathComponent(".local/bin/codex").path, home.appendingPathComponent(".npm-global/bin/codex").path]
    result += path.split(separator: ":").filter { $0.hasPrefix("/") }.map { String($0) + "/codex" }
    var seen = Set<String>()
    return result.filter { seen.insert($0).inserted }
}

struct CodexProbeResult { let status: Int32; let output: String }

func probeCodex(_ executable: String, arguments: [String], timeout: TimeInterval = 5, outputLimit: Int = 4096, environment: [String: String]? = nil) -> CodexProbeResult? {
    guard FileManager.default.isExecutableFile(atPath: executable) else { return nil }
    let outputURL = FileManager.default.temporaryDirectory.appendingPathComponent("one-codex-probe-\(UUID().uuidString)")
    guard FileManager.default.createFile(atPath: outputURL.path, contents: nil, attributes: [.posixPermissions: 0o600]),
          let output = try? FileHandle(forWritingTo: outputURL) else { return nil }
    defer { try? output.close(); try? FileManager.default.removeItem(at: outputURL) }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    if let environment { process.environment = environment }
    process.standardOutput = output; process.standardError = output
    process.standardInput = FileHandle.nullDevice
    do { try process.run() } catch { return nil }
    let deadline = Date().addingTimeInterval(timeout)
    while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.025) }
    if process.isRunning {
        process.terminate()
        let grace = Date().addingTimeInterval(0.25)
        while process.isRunning && Date() < grace { Thread.sleep(forTimeInterval: 0.025) }
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        process.waitUntilExit()
        return nil
    }
    process.waitUntilExit()
    guard let input = try? FileHandle(forReadingFrom: outputURL) else { return nil }
    defer { try? input.close() }
    let data = (try? input.read(upToCount: outputLimit)) ?? Data()
    return CodexProbeResult(status: process.terminationStatus, output: String(decoding: data, as: UTF8.self))
}

struct CompatibleCodex { let path: String; let version: String }
// The ONE gateway/event contract is validated from 0.160.1 onward within the
// current major version. Unknown major versions and incomplete CLI surfaces
// fall back to the reviewed managed package rather than guessing compatibility.
func compatibleCodexVersion(_ output: String) -> String? {
    let lines = output.split(separator: "\n").map(String.init)
    guard let line = lines.first(where: { $0.hasPrefix("codex-cli ") }) else { return nil }
    let version = String(line.dropFirst(10)).trimmingCharacters(in: .whitespacesAndNewlines)
    guard version.range(of: "^0\\.[0-9]+\\.[0-9]+$", options: .regularExpression) != nil,
          version.compare("0.160.1", options: .numeric) != .orderedAscending else { return nil }
    return version
}
func discoverCompatibleCodex(_ candidates: [String], probe: (String, [String]) -> CodexProbeResult?) -> CompatibleCodex? {
    let deadline = Date().addingTimeInterval(20)
    for path in candidates.prefix(32) {
        if Date() >= deadline { break }
        guard let result = probe(path, ["--version"]), result.status == 0, let version = compatibleCodexVersion(result.output),
              let help = probe(path, ["exec", "--help"]), help.status == 0,
              ["--json", "--sandbox", "--skip-git-repo-check", "--cd", "--config"].allSatisfy({ help.output.contains($0) }),
              let resume = probe(path, ["exec", "resume", "--help"]), resume.status == 0,
              resume.output.contains("SESSION_ID") else { continue }
        return CompatibleCodex(path: path, version: version)
    }
    return nil
}
func discoverCompatibleCodex(_ candidates: [String]) -> CompatibleCodex? {
    let home = FileManager.default.temporaryDirectory.appendingPathComponent("one-codex-compatibility-\(UUID().uuidString)")
    guard (try? FileManager.default.createDirectory(at: home, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])) != nil else { return nil }
    defer { try? FileManager.default.removeItem(at: home) }
    var environment = ProcessInfo.processInfo.environment
    for key in ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY", "CODEX_SQLITE_HOME", "ONE_EXECUTOR_TOKEN"] { environment.removeValue(forKey: key) }
    environment["CODEX_HOME"] = home.path
    return discoverCompatibleCodex(candidates) { path, arguments in
        probeCodex(path, arguments: arguments, outputLimit: 64 * 1024, environment: environment)
    }
}

func isCodexRuntime(_ executable: String) -> Bool {
    guard let result = probeCodex(executable, arguments: ["--version"]), result.status == 0 else { return false }
    return result.output.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("codex-cli ")
}
