import Foundation
import Darwin

@main
struct MachineResidentTests {
    static func main() throws {
        if CommandLine.arguments.contains("--one-resident") { while true { sleep(1) } }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("one-machine-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let path = root.appendingPathComponent("ONEPresence-0.4.4").path
        let args = [path, "--one-resident", "--credential-path", "/Volumes/TESTONLYONE/.one/credential.json"]
        let identity = ResidentProcessIdentity(pid: 123, uid: getuid(), executable: path, arguments: args, startedAt: "start")
        precondition(isInstalledMachineResident(identity, support: root, uid: getuid(), excluding: getpid()))
        precondition(!isInstalledMachineResident(identity, support: root, uid: getuid()+1, excluding: getpid()))
        precondition(!isInstalledMachineResident(identity, support: root, uid: getuid(), excluding: 123))
        precondition(!isInstalledMachineResident(identity, support: root.appendingPathComponent("other"), uid: getuid(), excluding: getpid()))
        var lease = try acquireMachineLease(directory: root, name: "machine-presence-v1.lock")
        precondition(lease != nil)
        let duplicate = try acquireMachineLease(directory: root, name: "machine-presence-v1.lock")
        precondition(duplicate == nil)
        lease = nil
        let recovered = try acquireMachineLease(directory: root, name: "machine-presence-v1.lock")
        precondition(recovered != nil)
        let executable = root.appendingPathComponent("ONEPresence-0.4.4")
        try FileManager.default.copyItem(at: Bundle.main.executableURL!, to: executable)
        let a = Process(), b = Process()
        for (process, volume) in [(a, "ADMIN"), (b, "TESTONLYONE")] {
            process.executableURL = executable
            process.arguments = ["--one-resident", "--credential-path", "/Volumes/\(volume)/.one/credential.json"]
            try process.run()
        }
        defer { for process in [a,b] { if process.isRunning { process.terminate() }; process.waitUntilExit() } }
        for _ in 0..<30 {
            if try installedMachineResidents(support: root).count == 2 { break }
            usleep(100_000)
        }
        let running = try installedMachineResidents(support: root)
        precondition(running.count == 2)
        try stopInstalledMachineResidents(support: root)
        a.waitUntilExit(); b.waitUntilExit()
        let stopped = try installedMachineResidents(support: root)
        precondition(stopped.isEmpty)
        print("Machine singleton and legacy multi-Key migration tests passed")
    }
}
