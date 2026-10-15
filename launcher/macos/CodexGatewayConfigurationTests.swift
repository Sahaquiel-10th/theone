import Foundation
import Darwin

@main struct CodexGatewayConfigurationTests {
    static func main() throws {
        let config = CodexGatewayConfiguration(baseUrl: "https://one.example/api/executor-gateway/v1", token: String(repeating: "a", count: 43), model: "one-executor")
        let result = try config.launchOverrides(home: URL(fileURLWithPath: "/tmp/one-isolated"), environment: ["OPENAI_API_KEY": "personal", "OPENAI_BASE_URL": "personal-url", "CODEX_HOME": "/personal", "PATH": "/bin"])
        precondition(result.environment["OPENAI_API_KEY"] == nil && result.environment["OPENAI_BASE_URL"] == nil)
        precondition(result.environment["CODEX_HOME"] == "/tmp/one-isolated" && result.environment["ONE_EXECUTOR_TOKEN"] == config.token)
        precondition(!result.arguments.joined(separator: " ").contains(config.token))
        precondition(result.arguments.contains("model_providers.one.requires_openai_auth=false"))
        let runtimeEnv = try config.launchOverrides(home: URL(fileURLWithPath: "/tmp/one-isolated"), environment: ["TMPDIR": "/private/one/scratch-1", "TMPPREFIX": "/private/one/scratch-1/zsh", "ONE_DOCUMENT_TOOL": "/Applications/ONE.app/Contents/MacOS/ONE", "ONE_DOCUMENT_ROOT": "/Users/test/work"])
        precondition(runtimeEnv.arguments.contains { $0.hasPrefix("shell_environment_policy.set=") && $0.contains("TMPPREFIX=") && $0.contains("ONE_DOCUMENT_TOOL=") })
        precondition(!runtimeEnv.arguments.joined(separator: " ").contains(config.token))
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("one-scratch-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: false)
        let scratchA = try createCodexScratch(home: home), scratchB = try createCodexScratch(home: home)
        precondition(scratchA != scratchB && scratchA.deletingLastPathComponent().lastPathComponent == home.lastPathComponent)
        let permissions = try FileManager.default.attributesOfItem(atPath: scratchA.path)[.posixPermissions] as! NSNumber
        precondition(permissions.intValue & 0o777 == 0o700)
        // Real zsh here-document regression, not a model/prompt simulation.
        let work = home.appendingPathComponent("work")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: false)
        let document = String(repeating: "长文本临时文件验证🙂\n", count: 5000)
        func canonical(_ url: URL) -> String {
            let value = realpath(url.path, nil)!; defer { free(value) }
            return String(cString: value)
        }
        func hereDocument(allowScratch: Bool) throws -> Int32 {
            let process = Process()
            let allowedPath = canonical(allowScratch ? home : work)
            let policy = "(version 1)(allow default)(deny network*)(deny file-write* (require-not (subpath \"\(allowedPath)\")))"
            process.executableURL = URL(fileURLWithPath: "/usr/bin/sandbox-exec")
            process.arguments = ["-p", policy, "/bin/zsh", "-f", "-c", "cat > \"$ONE_TEST_ROOT/long.md\" <<'ONE_QA_BODY'\n\(document)ONE_QA_BODY\n"]
            var environment = ProcessInfo.processInfo.environment
            environment["TMPDIR"] = scratchA.path; environment["ONE_TEST_ROOT"] = canonical(work)
            environment["TMPPREFIX"] = scratchA.appendingPathComponent("zsh").path
            process.environment = environment
            let errors = Pipe()
            process.standardOutput = FileHandle.nullDevice; process.standardError = errors
            try process.run(); process.waitUntilExit()
            let detail = errors.fileHandleForReading.readDataToEndOfFile()
            if allowScratch && process.terminationStatus != 0 { FileHandle.standardError.write(detail) }
            return process.terminationStatus
        }
        let denied = try hereDocument(allowScratch: false)
        precondition(denied != 0, "old root-only boundary should reproduce here-document failure")
        let allowed = try hereDocument(allowScratch: true)
        let actualDocument = try String(contentsOf: work.appendingPathComponent("long.md"), encoding: .utf8)
        precondition(allowed == 0 && actualDocument == document, "exact private scratch must enable complete long-text writes")
        for url in ["http://one.example/api/executor-gateway/v1", "https://user:pass@one.example/api/executor-gateway/v1", "https://one.example/api/executor-gateway/v1?key=secret"] {
            do {
                _ = try CodexGatewayConfiguration(baseUrl: url, token: config.token, model: config.model).launchOverrides(home: URL(fileURLWithPath: "/tmp/one-isolated"), environment: [:])
                fatalError("invalid gateway accepted")
            } catch { }
        }
        print("Codex gateway configuration isolation tests passed")
    }
}
