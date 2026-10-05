import Foundation
import Darwin

struct ResidentProcessIdentity: Equatable {
    let pid: Int32
    let uid: UInt32
    let executable: String
    let arguments: [String]
    let startedAt: String
}

func olderResidentVersion(_ identity: ResidentProcessIdentity, support: URL, currentUID: UInt32, currentPID: Int32, newVersion: String, credentialMatches: (URL) -> Bool) -> String? {
    guard identity.pid > 1, identity.pid != currentPID, identity.uid == currentUID,
          !identity.startedAt.isEmpty else { return nil }
    let executable = URL(fileURLWithPath: identity.executable).standardizedFileURL
    let bundle = executable.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let installed: URL
    if executable.lastPathComponent == "ONE", executable.deletingLastPathComponent().lastPathComponent == "MacOS",
       executable.deletingLastPathComponent().deletingLastPathComponent().lastPathComponent == "Contents",
       bundle.pathExtension == "app" { installed = bundle }
    else { installed = executable }
    guard installed.deletingLastPathComponent() == support.standardizedFileURL,
          installed.lastPathComponent.hasPrefix("ONEPresence-") else { return nil }
    let name = installed.pathExtension == "app" ? installed.deletingPathExtension().lastPathComponent : installed.lastPathComponent
    let version = String(name.dropFirst("ONEPresence-".count))
    func parts(_ value: String) -> [Int]? {
        guard value.range(of: #"^(0|[1-9]\d*)(?:\.(0|[1-9]\d*)){1,3}$"#, options: .regularExpression) != nil else { return nil }
        let numbers = value.split(separator: ".").compactMap { Int($0) }
        return numbers.count == value.split(separator: ".").count ? numbers : nil
    }
    guard let old = parts(version), let new = parts(newVersion) else { return nil }
    var older = false
    for index in 0..<max(old.count, new.count) {
        let left = index < old.count ? old[index] : 0, right = index < new.count ? new[index] : 0
        if left != right { older = left < right; break }
    }
    guard older, identity.arguments.first == identity.executable else { return nil }
    let args = Array(identity.arguments.dropFirst())
    guard args.count == 3 || args.count == 4, args[0] == "--one-resident", args[1] == "--credential-path",
          args.count == 3 || args[3] == "--one-update-resume",
          credentialMatches(URL(fileURLWithPath: args[2])) else { return nil }
    return version
}

// Inspect argv without a shell or whitespace parsing: volume names contain
// spaces. Do not return or log credential contents, only process identity.
func inspectResidentProcess(_ pid: Int32) -> ResidentProcessIdentity? {
    var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
    var size = 0
    guard sysctl(&mib, UInt32(mib.count), nil, &size, nil, 0) == 0, size >= 5, size <= 1024 * 1024 else { return nil }
    var data = [UInt8](repeating: 0, count: size)
    guard sysctl(&mib, UInt32(mib.count), &data, &size, nil, 0) == 0 else { return nil }
    let argc = data.withUnsafeBytes { $0.loadUnaligned(as: Int32.self) }
    guard argc > 0, argc < 32 else { return nil }
    var offset = MemoryLayout<Int32>.size
    func readString() -> String? {
        guard offset < size, let end = data[offset..<size].firstIndex(of: 0) else { return nil }
        defer { offset = end + 1 }
        return String(bytes: data[offset..<end], encoding: .utf8)
    }
    guard let executable = readString() else { return nil }
    while offset < size && data[offset] == 0 { offset += 1 }
    var arguments = [String]()
    for _ in 0..<argc { guard let argument = readString() else { return nil }; arguments.append(argument) }
    guard let metadata = try? residentInspectionOutput("/bin/ps", ["-p", String(pid), "-o", "uid=", "-o", "lstart="]),
          let split = metadata.firstIndex(where: { $0.isWhitespace }),
          let uid = UInt32(metadata[..<split]) else { return nil }
    return ResidentProcessIdentity(pid: pid, uid: uid, executable: executable, arguments: arguments, startedAt: metadata[split...].trimmingCharacters(in: .whitespacesAndNewlines))
}

func residentInspectionOutput(_ executable: String, _ arguments: [String]) throws -> String {
    let process = Process(), output = Pipe()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    try process.run()
    // These commands are scoped to one PID or one lock file. Drain before wait
    // to avoid a pipe-full deadlock; no general process inventory is requested.
    let data = output.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else { throw POSIXError(.ESRCH) }
    return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
}

func residentLockOwners(_ lock: URL) -> [Int32] {
    guard let output = try? residentInspectionOutput("/usr/sbin/lsof", ["-t", "--", lock.path]) else { return [] }
    return Array(Set(output.split(whereSeparator: \.isWhitespace).compactMap { Int32($0) }))
}

// Call only AFTER the replacement completed the server's Key challenge. Require
// the precise lock owner, same UID, installed resident path, older version and
// exact Key credential. Recheck PID identity and lock ownership immediately
// before a normal termination signal. Never kill by name or touch other Keys.
func terminateOlderResident(lock: URL, support: URL, newVersion: String, credentialMatches: (URL) -> Bool) -> Bool {
    var signalled = false
    for pid in residentLockOwners(lock) {
        guard let identity = inspectResidentProcess(pid),
              olderResidentVersion(identity, support: support, currentUID: getuid(), currentPID: getpid(), newVersion: newVersion, credentialMatches: credentialMatches) != nil,
              inspectResidentProcess(pid) == identity, residentLockOwners(lock).contains(pid) else { continue }
        if kill(pid, SIGTERM) == 0 { signalled = true }
    }
    return signalled
}
