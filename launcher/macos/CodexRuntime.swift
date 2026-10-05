import Foundation
import Darwin

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

func probeCodex(_ executable: String, arguments: [String], timeout: TimeInterval = 5) -> CodexProbeResult? {
    guard FileManager.default.isExecutableFile(atPath: executable) else { return nil }
    let outputURL = FileManager.default.temporaryDirectory.appendingPathComponent("one-codex-probe-\(UUID().uuidString)")
    guard FileManager.default.createFile(atPath: outputURL.path, contents: nil, attributes: [.posixPermissions: 0o600]),
          let output = try? FileHandle(forWritingTo: outputURL) else { return nil }
    defer { try? output.close(); try? FileManager.default.removeItem(at: outputURL) }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
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
    let data = (try? input.read(upToCount: 4096)) ?? Data()
    return CodexProbeResult(status: process.terminationStatus, output: String(decoding: data, as: UTF8.self))
}

func isCodexRuntime(_ executable: String) -> Bool {
    guard let result = probeCodex(executable, arguments: ["--version"]), result.status == 0 else { return false }
    return result.output.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("codex-cli ")
}
