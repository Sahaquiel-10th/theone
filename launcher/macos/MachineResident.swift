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
