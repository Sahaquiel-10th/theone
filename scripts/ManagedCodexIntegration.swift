import Foundation
import CryptoKit

// Offline candidate acceptance only: ephemeral test signing key, private temp
// install, no portable Key, production trust/config or user Codex home changed.
@main struct ManagedCodexIntegration {
    static func main() throws {
        guard [3,4].contains(CommandLine.arguments.count) else { throw ManagedCodexError.invalid }
        let catalogURL = URL(fileURLWithPath:CommandLine.arguments[1]), archiveURL = URL(fileURLWithPath:CommandLine.arguments[2])
        let payload = try Data(contentsOf:catalogURL), key = Curve25519.Signing.PrivateKey()
        let actualEnvelope = try? JSONDecoder().decode(ManagedCodexEnvelope.self,from:payload)
        let envelope = try actualEnvelope ?? ManagedCodexEnvelope(payload:payload.base64EncodedString(),signature:key.signature(for:payload).base64EncodedString())
        let publicKey = CommandLine.arguments.count == 4 ? try String(contentsOfFile:CommandLine.arguments[3],encoding:.utf8).trimmingCharacters(in:.whitespacesAndNewlines) : key.publicKey.rawRepresentation.base64EncodedString()
        #if arch(arm64)
        let arch = "arm64"
        #else
        let arch = "x86_64"
        #endif
        let release = try managedCodexRelease(envelope,publicKey:publicKey,origin:URL(string:"https://theone.aiarrival.cn")!,architecture:arch)
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("one-codex-install-real-\(UUID().uuidString)")
        let executable = try commitManagedCodex(bytes:Data(contentsOf:archiveURL),envelope:envelope,release:release,root:root) { path,version in
            let result = probeCodex(path,arguments:["--version"],timeout:30)
            if result?.status != 0 { print("HEALTH_PROBE_FAILED=\(result?.status.description ?? "timeout")") }
            return result?.status == 0 && result?.output.trimmingCharacters(in:.whitespacesAndNewlines) == "codex-cli \(version)"
        }
        let checked = try installedManagedCodex(root:root,publicKey:publicKey,origin:URL(string:"https://theone.aiarrival.cn")!,architecture:arch)
        guard checked?.path == executable else { throw ManagedCodexError.unhealthy }
        let directory = URL(fileURLWithPath:executable).deletingLastPathComponent().deletingLastPathComponent()
        guard probeCodex(directory.appendingPathComponent("codex-path/rg").path,arguments:["--version"])?.status == 0,
              FileManager.default.isExecutableFile(atPath:directory.appendingPathComponent("bin/codex-code-mode-host").path) else { throw ManagedCodexError.unhealthy }
        print("REAL_INSTALL_PASSED=\(release.version)")
        print("TEST_SIGNING_ONLY=\(actualEnvelope == nil)")
        print("EXECUTABLE=\(executable)")
        print("EVIDENCE_ROOT=\(root.path)")
    }
}
