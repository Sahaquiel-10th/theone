import Foundation
import Darwin

@main
struct ResidentTakeoverTests {
    static func main() throws {
        if CommandLine.arguments.contains("--one-resident") {
            let path = ProcessInfo.processInfo.environment["ONE_TEST_LOCK"]!
            let fd = open(path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
            guard fd >= 0, flock(fd, LOCK_EX | LOCK_NB) == 0 else { exit(2) }
            while true { sleep(1) }
        }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("one-takeover-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let credential = root.appendingPathComponent("credential-a.json"), other = root.appendingPathComponent("credential-b.json")
        let identity = ResidentProcessIdentity(pid: 123, uid: getuid(), executable: root.appendingPathComponent("ONEPresence-0.4.2").path, arguments: [root.appendingPathComponent("ONEPresence-0.4.2").path, "--one-resident", "--credential-path", credential.path], startedAt: "start")
        func approved(_ item: ResidentProcessIdentity, version: String = "0.4.3") -> Bool {
            olderResidentVersion(item, support: root, currentUID: getuid(), currentPID: getpid(), newVersion: version, credentialMatches: { $0 == credential }) != nil
        }
        precondition(approved(identity))
        let bundledExecutable = root.appendingPathComponent("ONEPresence-0.4.2.app/Contents/MacOS/ONE").path
        precondition(approved(ResidentProcessIdentity(pid: identity.pid, uid: identity.uid, executable: bundledExecutable, arguments: [bundledExecutable, "--one-resident", "--credential-path", credential.path], startedAt: identity.startedAt)), "signed bundle owners must support the same precise takeover")
        precondition(!approved(identity, version: "0.4.2"), "equal version must not be terminated")
        precondition(!approved(identity, version: "0.4.1"), "newer version must not be terminated")
        precondition(!approved(ResidentProcessIdentity(pid: identity.pid, uid: getuid()+1, executable: identity.executable, arguments: identity.arguments, startedAt: identity.startedAt)))
        precondition(!approved(ResidentProcessIdentity(pid: identity.pid, uid: identity.uid, executable: identity.executable, arguments: [identity.executable,"--one-resident","--credential-path",other.path], startedAt: identity.startedAt)), "other Key must remain untouched")
        precondition(!approved(ResidentProcessIdentity(pid: identity.pid, uid: identity.uid, executable: "/tmp/ONEPresence-0.4.2", arguments: identity.arguments, startedAt: identity.startedAt)), "similar name outside installed directory is not an owner")
        let source = Bundle.main.executableURL!
        let oldExecutable = root.appendingPathComponent("ONEPresence-0.4.2")
        try FileManager.default.copyItem(at: source, to: oldExecutable)
        let lockA = root.appendingPathComponent("presence-a-v2.lock"), lockB = root.appendingPathComponent("presence-b-v2.lock")
        func launch(_ key: URL, lock: URL) throws -> Process {
            let child = Process()
            child.executableURL = oldExecutable
            child.arguments = ["--one-resident", "--credential-path", key.path]
            child.environment = ProcessInfo.processInfo.environment.merging(["ONE_TEST_LOCK":lock.path]) { _, new in new }
            try child.run()
            for _ in 0..<50 {
                if residentLockOwners(lock).contains(child.processIdentifier) { return child }
                usleep(20_000)
            }
            child.terminate()
            throw POSIXError(.ETIMEDOUT)
        }
        let oldA = try launch(credential, lock: lockA), oldB = try launch(other, lock: lockB)
        defer {
            if oldA.isRunning { oldA.terminate() }; oldA.waitUntilExit()
            if oldB.isRunning { oldB.terminate() }; oldB.waitUntilExit()
        }
        guard let observed = inspectResidentProcess(oldA.processIdentifier) else { fatalError("inspect exact native owner") }
        precondition(approved(observed), "native argv and executable identity must match")
        precondition(!terminateOlderResident(lock: lockA, support: root, newVersion: "0.4.2", credentialMatches: {$0 == credential}))
        precondition(oldA.isRunning && oldB.isRunning)
        precondition(terminateOlderResident(lock: lockA, support: root, newVersion: "0.4.3", credentialMatches: {$0 == credential}))
        oldA.waitUntilExit()
        precondition(oldB.isRunning, "other Key's real resident must survive takeover")
        let descriptor = open(lockA.path, O_RDWR)
        defer { close(descriptor) }
        precondition(flock(descriptor, LOCK_EX | LOCK_NB) == 0, "new resident can acquire the released lock")
        print("Resident takeover native and isolation tests passed")
    }
}
