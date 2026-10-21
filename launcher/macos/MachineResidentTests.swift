import Foundation
import Darwin

@main
struct MachineResidentTests {
    static func main() throws {
        if CommandLine.arguments.contains("--one-resident") {
            guard let mode = ProcessInfo.processInfo.environment["ONE_MACHINE_TEST_REPLY"] else { while true { sleep(1) } }
            let support = Bundle.main.executableURL!.deletingLastPathComponent()
            let lease = try acquireMachineLease(directory: support, name: "machine-presence-v1.lock")
            precondition(lease != nil)
            let center = DistributedNotificationCenter.default()
            let observer = center.addObserver(forName: Notification.Name("one.machine.reopen.\(getpid())"), object: nil, queue: nil) { n in
                guard let request = n.object as? String, mode != "silent" else { return }
                center.postNotificationName(Notification.Name("one.machine.reopen.reply.\(request)"), object: "0.4.4",
                    userInfo: ["pid": mode == "wrong_pid" ? Int(getpid()) + 1 : Int(getpid()), "status": mode == "different_key" ? mode : "accepted"], deliverImmediately: true)
            }
            withExtendedLifetime((lease, observer)) { while true { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05)) } }
            return
        }
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
        let credential = URL(fileURLWithPath: args[3])
        precondition(canWakeMachineResident(identity, support: root, version: "0.4.4", credential: credential, owners: [123], uid: getuid(), excluding: getpid()))
        for (version, path, owners, uid) in [("0.4.5", args[3], [Int32(123)], getuid()), ("0.4.4", "/Volumes/OTHER/.one/credential.json", [Int32(123)], getuid()), ("0.4.4", args[3], [Int32(124)], getuid()), ("0.4.4", args[3], [Int32(123),Int32(124)], getuid()), ("0.4.4", args[3], [Int32(123)], getuid()+1)] {
            precondition(!canWakeMachineResident(identity, support: root, version: version, credential: URL(fileURLWithPath: path), owners: owners, uid: uid, excluding: getpid()))
        }
        var lease = try acquireMachineLease(directory: root, name: "machine-presence-v1.lock")
        precondition(lease != nil)
        let duplicate = try acquireMachineLease(directory: root, name: "machine-presence-v1.lock")
        precondition(duplicate == nil)
        lease = nil
        var recovered = try acquireMachineLease(directory: root, name: "machine-presence-v1.lock")
        precondition(recovered != nil)
        recovered = nil
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
        for mode in ["accepted", "different_key", "silent", "wrong_pid"] {
            let child = Process()
            child.executableURL = executable
            child.arguments = Array(args.dropFirst())
            child.environment = ProcessInfo.processInfo.environment.merging(["ONE_MACHINE_TEST_REPLY":mode]) { _, new in new }
            try child.run()
            defer { if child.isRunning { child.terminate() }; child.waitUntilExit() }
            for _ in 0..<40 {
                if residentLockOwners(root.appendingPathComponent("machine-presence-v1.lock")) == [child.processIdentifier] { break }
                usleep(50_000)
            }
            // Reopen never kills the owner, including a timeout or forged ACK.
            do {
                let reused = try wakeInstalledMachineResident(support: root, version: "0.4.4", credential: credential, timeout: mode == "accepted" || mode == "different_key" ? 3 : 0.25)
                precondition(mode == "accepted" ? reused : mode == "different_key" && !reused)
            } catch {
                precondition(mode == "silent" || mode == "wrong_pid")
            }
            precondition(child.isRunning)
            child.terminate(); child.waitUntilExit()
        }
        print("Machine singleton, migration, same-Key reopen and non-destructive timeout tests passed")
    }
}
