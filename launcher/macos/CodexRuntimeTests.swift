import Foundation

@main struct CodexRuntimeTests {
    static func main() {
        let candidates = codexRuntimeCandidates(saved: "/custom/codex", resources: nil, volume: URL(fileURLWithPath: "/Volumes/test"), applications: [URL(fileURLWithPath: "/Elsewhere/ChatGPT.app")], home: URL(fileURLWithPath: "/Users/test"), path: ":relative:/custom:/opt/homebrew/bin")
        precondition(candidates.first == "/custom/codex")
        precondition(candidates.contains("/Elsewhere/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"))
        precondition(!candidates.contains("relative/codex"))
        precondition(Set(candidates).count == candidates.count)
        precondition(!isCodexRuntime("/usr/bin/true"))
        precondition(probeCodex("/usr/bin/false", arguments: [])?.status != 0)
        precondition(probeCodex("/bin/sleep", arguments: ["5"], timeout: 0.1) == nil)
        precondition(probeCodex("/does/not/exist", arguments: []) == nil)
        precondition(compatibleCodexVersion("warning\ncodex-cli 0.160.1\n") == "0.160.1")
        for output in ["codex-cli 0.159.0", "codex-cli 0.160.0", "codex-cli 1.0.0", "codex-cli 0.160.1-beta", "not codex-cli 0.160.1"] {
            precondition(compatibleCodexVersion(output) == nil)
        }
        let surface = "--json --sandbox --skip-git-repo-check --cd --config"
        let selected = discoverCompatibleCodex(["old", "partial", "good", "never"]) { path, args in
            precondition(path != "never")
            if args == ["--version"] { return CodexProbeResult(status: 0, output: "codex-cli \(path == "old" ? "0.100.0" : "0.160.2")") }
            if args == ["exec", "--help"] { return CodexProbeResult(status: 0, output: path == "partial" ? "--json" : surface) }
            return CodexProbeResult(status: 0, output: "SESSION_ID")
        }
        precondition(selected?.path == "good" && selected?.version == "0.160.2")
        precondition(discoverCompatibleCodex(["failed"]) { _, _ in CodexProbeResult(status: 1, output: "codex-cli 0.160.1") } == nil)
        if CommandLine.arguments.contains("--compatibility-only"), let executable = CommandLine.arguments.last {
            precondition(discoverCompatibleCodex([executable]) != nil, "actual CLI must support ONE gateway commands without personal login")
            print("Actual Codex reuse compatibility passed")
            return
        }
        if CommandLine.arguments.count > 1 {
            let executable = CommandLine.arguments[1]
            precondition(isCodexRuntime(executable), "actual installed runtime must pass version validation")
            precondition(probeCodex(executable, arguments: ["login", "status"])?.status == 0, "actual installed runtime must be logged in")
        }
        print("Codex discovery and bounded probe tests passed")
    }
}
