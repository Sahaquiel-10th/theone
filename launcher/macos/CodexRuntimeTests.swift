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
        if CommandLine.arguments.count > 1 {
            let executable = CommandLine.arguments[1]
            precondition(isCodexRuntime(executable), "actual installed runtime must pass version validation")
            precondition(probeCodex(executable, arguments: ["login", "status"])?.status == 0, "actual installed runtime must be logged in")
        }
        print("Codex discovery and bounded probe tests passed")
    }
}
