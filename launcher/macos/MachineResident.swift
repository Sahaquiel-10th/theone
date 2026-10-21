import Foundation
import Darwin

final class MachineResidentLease {
    private let descriptor: Int32
    init(_ descriptor: Int32) { self.descriptor = descriptor }
    deinit { flock(descriptor, LOCK_UN); close(descriptor) }
}

func acquireMachineLease(directory: URL, name: String) throws -> MachineResidentLease? {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let descriptor = open(directory.appendingPathComponent(name).path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
    guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    if flock(descriptor, LOCK_EX | LOCK_NB) != 0 {
        let reason = errno
        close(descriptor)
        if reason == EWOULDBLOCK { return nil }
        throw POSIXError(POSIXErrorCode(rawValue: reason) ?? .EIO)
    }
    return MachineResidentLease(descriptor)
}

// Migration deliberately targets ALL installed residents for this OS user,
// not all processes named ONE and not any other user's applications. No Key
// secret needs to be read before the old permission identity has exited.
func isInstalledMachineResident(_ identity: ResidentProcessIdentity, support: URL, uid: UInt32, excluding: Int32) -> Bool {
    guard identity.pid > 1, identity.pid != excluding, identity.uid == uid, !identity.startedAt.isEmpty else { return false }
    let executable = URL(fileURLWithPath: identity.executable).standardizedFileURL
    let installed: URL
    if executable.lastPathComponent == "ONE", executable.deletingLastPathComponent().lastPathComponent == "MacOS" {
        guard executable.deletingLastPathComponent().deletingLastPathComponent().lastPathComponent == "Contents" else { return false }
        installed = executable.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        guard installed.pathExtension == "app" else { return false }
    } else { installed = executable }
    guard installed.deletingLastPathComponent() == support.standardizedFileURL else { return false }
    let name = installed.pathExtension == "app" ? installed.deletingPathExtension().lastPathComponent : installed.lastPathComponent
    guard name.range(of: #"^ONEPresence-(0|[1-9]\d*)(?:\.(0|[1-9]\d*)){1,3}$"#, options: .regularExpression) != nil,
          identity.arguments.first == identity.executable else { return false }
    let args = Array(identity.arguments.dropFirst())
    guard args.count == 3 || args.count == 4, args[0] == "--one-resident", args[1] == "--credential-path",
          args.count == 3 || args[3] == "--one-update-resume" else { return false }
    let credential = URL(fileURLWithPath: args[2]).standardizedFileURL
    return credential.pathComponents.count == 5 && credential.path.hasPrefix("/Volumes/") && credential.lastPathComponent == "credential.json" && credential.deletingLastPathComponent().lastPathComponent == ".one"
}

func installedMachineResidents(support: URL) throws -> [ResidentProcessIdentity] {
    let output = try residentInspectionOutput("/bin/ps", ["-ww", "-U", String(getuid()), "-o", "pid=", "-o", "comm="])
    let candidates = output.split(separator: "\n").compactMap { line -> Int32? in
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard let split = trimmed.firstIndex(where: \.isWhitespace), let pid = Int32(trimmed[..<split]),
              trimmed[split...].trimmingCharacters(in: .whitespaces).hasPrefix(support.path + "/ONEPresence-") else { return nil }
        return pid
    }
    return candidates.compactMap(inspectResidentProcess).filter {
        isInstalledMachineResident($0, support: support, uid: getuid(), excluding: getpid())
    }
}

// A same-version portable reopen is a wake request, not an installation or
// permission-identity migration. Match the complete process identity and the
// machine lease before sending it anything; never read the Key in this opener.
func canWakeMachineResident(_ identity: ResidentProcessIdentity, support: URL, version: String, credential: URL, owners: [Int32], uid: UInt32, excluding: Int32) -> Bool {
    guard isInstalledMachineResident(identity, support: support, uid: uid, excluding: excluding),
          owners == [identity.pid], identity.arguments[3] == credential.standardizedFileURL.path else { return false }
    let executable = URL(fileURLWithPath: identity.executable).standardizedFileURL
    let installed = executable.lastPathComponent == "ONE"
        ? executable.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        : executable
    let name = installed.pathExtension == "app" ? installed.deletingPathExtension().lastPathComponent : installed.lastPathComponent
    return name == "ONEPresence-\(version)"
}

private final class MachineReopenReply {
    private let lock = NSLock()
    private var value: String?
    func record(_ status: String) { lock.lock(); defer { lock.unlock() }; value = status }
    func read() -> String? { lock.lock(); defer { lock.unlock() }; return value }
}

// Only the installed resident reads the reinserted credential and verifies its
// device id. A missing/unreadable reply must not be interpreted as permission
// to kill a live owner: it may still own a command or a pending terminal receipt.
func wakeInstalledMachineResident(support: URL, version: String, credential: URL, timeout: TimeInterval = 15) throws -> Bool {
    let residents = try installedMachineResidents(support: support)
    let machineLock = support.appendingPathComponent("machine-presence-v1.lock")
    let owners = residentLockOwners(machineLock).sorted()
    guard let owner = residents.first(where: {
        canWakeMachineResident($0, support: support, version: version, credential: credential, owners: owners, uid: getuid(), excluding: getpid())
    }) else { return false }
    let request = UUID().uuidString, reply = MachineReopenReply()
    let center = DistributedNotificationCenter.default()
    let observer = center.addObserver(forName: Notification.Name("one.machine.reopen.reply.\(request)"), object: nil, queue: nil) { notification in
        guard notification.object as? String == version,
              (notification.userInfo?["pid"] as? NSNumber)?.int32Value == owner.pid,
              inspectResidentProcess(owner.pid) == owner,
              residentLockOwners(machineLock).sorted() == [owner.pid],
              let status = notification.userInfo?["status"] as? String,
              ["accepted", "different_key"].contains(status) else { return }
        reply.record(status)
    }
    defer { center.removeObserver(observer) }
    center.postNotificationName(Notification.Name("one.machine.reopen.\(owner.pid)"), object: request,
        userInfo: ["version": version, "credentialPath": credential.standardizedFileURL.path], deliverImmediately: true)
    let deadline = ProcessInfo.processInfo.systemUptime + timeout
    while ProcessInfo.processInfo.systemUptime < deadline {
        if let status = reply.read() { return status == "accepted" }
        guard inspectResidentProcess(owner.pid) == owner else { throw POSIXError(.EBUSY) }
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))
    }
    throw POSIXError(.EBUSY)
}

func stopInstalledMachineResidents(support: URL) throws {
    let owners = try installedMachineResidents(support: support)
    for owner in owners {
        // Recheck start time, executable and argv to guard against PID reuse.
        guard inspectResidentProcess(owner.pid) == owner else { continue }
        if kill(owner.pid, SIGTERM) != 0 && errno != ESRCH { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    }
    for _ in 0..<30 {
        if owners.allSatisfy({ inspectResidentProcess($0.pid) != $0 }) { return }
        usleep(100_000)
    }
    // Never launch a competing permission identity or escalate to SIGKILL.
    throw POSIXError(.EBUSY)
}
