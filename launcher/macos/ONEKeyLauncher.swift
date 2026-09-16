import AppKit
import CryptoKit
import Foundation
import CFNetwork
import Network
import Darwin

let launcherVersion = "__ONE_RUNTIME_VERSION__"
let updatePublicKeyRaw = "__ONE_UPDATE_PUBLIC_KEY__"
let residentArgument = "--one-resident"
let deviceArgument = "--device-id"
let credentialArgument = "--credential-path"

func oneDefaults() -> UserDefaults { UserDefaults(suiteName: "one.theone.key") ?? .standard }

// Stored only on this computer, never in the portable credential or app bundle.
func installationId() -> String {
    let defaults = oneDefaults()
    if let saved = defaults.string(forKey: "one.installation.id"), saved.count == 32 { return saved }
    let generated = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    defaults.set(generated, forKey: "one.installation.id")
    defaults.synchronize()
    return generated
}

struct DeviceCredential: Decodable {
    let version: Int
    let deviceId: String
    let privateKeyRaw: String
    let serverBaseUrl: String
}

struct ChallengeRequest: Encodable { let deviceId: String; let installationId: String }
struct ChallengeResponse: Decodable { let challengeId: String; let nonce: String }
struct VerifyRequest: Encodable { let signature: String }
struct VerifyResponse: Decodable { let loginCode: String }
struct ApiFailure: Decodable { let error: String? }
struct SocketMessage: Decodable {
    let type: String
    let challengeId: String?
    let nonce: String?
    let deviceId: String?
    let taskId: String?
    let instruction: String?
    let requestId: String?
    let envelope: SignedRuntimeUpdate?
}
struct SocketResponse: Encodable { let type: String; let challengeId: String; let signature: String }
struct SocketAuthResponse: Encodable {
    let type: String
    let challengeId: String
    let signature: String
    let capabilities = ["runtime_update_v1"]
    let platform = "macos"
    let architecture: String
    let launcherVersion: String
    let updateProtocol = 1
}
struct ExecutionEventResponse: Encodable {
    let type = "execution_event"
    let taskId: String
    let kind: String
    let text: String?
    let providerThreadId: String?
    let targetName: String?
    let status: String?
}
struct SignedRuntimeUpdate: Codable { let payload: String; let signature: String }
struct RuntimeUpdatePayload: Decodable {
    let schemaVersion: Int
    let channel: String
    let artifacts: [RuntimeUpdateArtifact]
}
struct RuntimeUpdateArtifact: Decodable {
    let platform: String
    let architecture: String
    let version: String
    let url: String
    let sha256: String
    let size: Int64
}
struct UpdateEventResponse: Encodable {
    let type = "update_event"
    let requestId: String
    let status: String
    let error: String?
}

enum LauncherError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case let .message(value) = self { return value }; return "ONE Key 启动失败" }
}

func base64UrlDecode(_ value: String) -> Data? {
    var base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
    return Data(base64Encoded: base64)
}

func base64UrlEncode(_ value: Data) -> String {
    value.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}

func loadCredential(_ credentialUrl: URL, expectedDeviceId: String? = nil) throws -> DeviceCredential {
    guard FileManager.default.fileExists(atPath: credentialUrl.path) else {
        throw LauncherError.message("ONE Key 已拔出或凭证不存在")
    }
    let credential = try JSONDecoder().decode(DeviceCredential.self, from: Data(contentsOf: credentialUrl))
    guard credential.version == 1, expectedDeviceId == nil || credential.deviceId == expectedDeviceId else {
        throw LauncherError.message("ONE Key 凭证不匹配")
    }
    return credential
}

func findCredentialUrl(expectedDeviceId: String? = nil, preferred: URL? = nil) -> URL? {
    let portable = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent(".one/credential.json")
    var candidates = [URL]()
    if let preferred { candidates.append(preferred) }
    candidates.append(portable)
    // Once a Key has been found, keep checking its exact path. A mount
    // notification updates that path if macOS gives the volume a new suffix.
    // This avoids repeatedly enumerating every removable volume while absent.
    if preferred == nil {
        let volumes = FileManager.default.mountedVolumeURLs(includingResourceValuesForKeys: nil, options: [.skipHiddenVolumes]) ?? []
        candidates.append(contentsOf: volumes.map { $0.appendingPathComponent(".one/credential.json") })
    }
    var seen = Set<String>()
    return candidates
        .filter { seen.insert($0.standardizedFileURL.path).inserted }
        .first { url in
            guard FileManager.default.fileExists(atPath: url.path), let credential = try? loadCredential(url) else { return false }
            return expectedDeviceId == nil || credential.deviceId == expectedDeviceId
        }
}

final class ResidentLock {
    private let descriptor: Int32

    init(descriptor: Int32) { self.descriptor = descriptor }

    deinit {
        flock(descriptor, LOCK_UN)
        close(descriptor)
    }
}

func acquireResidentLock(deviceId: String) throws -> ResidentLock? {
    let applicationSupport = try FileManager.default.url(
        for: .applicationSupportDirectory,
        in: .userDomainMask,
        appropriateFor: nil,
        create: true
    )
    let directory = applicationSupport.appendingPathComponent("ONE", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let digest = SHA256.hash(data: Data(deviceId.utf8)).map { String(format: "%02x", $0) }.joined()
    let target = directory.appendingPathComponent("presence-\(digest).lock")
    let descriptor = open(target.path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
    guard descriptor >= 0 else { throw LauncherError.message("无法创建 ONE 驻留锁") }
    if flock(descriptor, LOCK_EX | LOCK_NB) != 0 {
        let lockError = errno
        close(descriptor)
        if lockError == EWOULDBLOCK { return nil }
        throw LauncherError.message("无法锁定 ONE 驻留进程")
    }
    return ResidentLock(descriptor: descriptor)
}

func commandLineValue(_ name: String) -> String? {
    guard let index = CommandLine.arguments.firstIndex(of: name), CommandLine.arguments.indices.contains(index + 1) else { return nil }
    return CommandLine.arguments[index + 1]
}

func launchResidentCopy() throws {
    _ = installationId()
    guard let source = Bundle.main.executableURL else { throw LauncherError.message("ONE 启动器不完整") }
    let portableCredential = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent(".one/credential.json")
    let applicationSupport = try FileManager.default.url(
        for: .applicationSupportDirectory,
        in: .userDomainMask,
        appropriateFor: nil,
        create: true
    )
    let installDirectory = applicationSupport.appendingPathComponent("ONE", isDirectory: true)
    try FileManager.default.createDirectory(at: installDirectory, withIntermediateDirectories: true)
    let target = installDirectory.appendingPathComponent("ONEPresence-\(launcherVersion)")
    if !FileManager.default.fileExists(atPath: target.path) {
        let temporary = installDirectory.appendingPathComponent(".ONEPresence-\(UUID().uuidString)")
        try FileManager.default.copyItem(at: source, to: temporary)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: temporary.path)
        try FileManager.default.moveItem(at: temporary, to: target)
    }

    let process = Process()
    process.executableURL = target
    // The portable app must not read the credential itself. The installed
    // resident is the single process that receives removable-volume access,
    // discovers the Key and keeps proving its presence.
    process.arguments = [residentArgument, credentialArgument, portableCredential.path]
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
}

func signNonce(_ nonce: String, credentialUrl: URL, deviceId: String) throws -> String {
    let credential = try loadCredential(credentialUrl, expectedDeviceId: deviceId)
    guard let privateData = base64UrlDecode(credential.privateKeyRaw), let nonceData = base64UrlDecode(nonce) else {
        throw LauncherError.message("ONE Key 挑战格式无效")
    }
    let privateKey = try Curve25519.Signing.PrivateKey(rawRepresentation: privateData)
    return base64UrlEncode(try privateKey.signature(for: nonceData))
}

func receiveText(_ task: URLSessionWebSocketTask) async throws -> String {
    switch try await task.receive() {
    case let .string(text): return text
    case let .data(data): return String(decoding: data, as: UTF8.self)
    @unknown default: throw LauncherError.message("ONE Key 在线连接返回未知消息")
    }
}

func socketUrl(base: String, deviceId: String) throws -> URL {
    guard var components = URLComponents(string: base) else { throw LauncherError.message("ONE 服务地址无效") }
    components.scheme = components.scheme == "https" ? "wss" : "ws"
    components.path = "/api/one-key/launcher"
    components.queryItems = [URLQueryItem(name: "deviceId", value: deviceId), URLQueryItem(name: "installationId", value: installationId())]
    guard let url = components.url else { throw LauncherError.message("ONE 在线验证地址无效") }
    return url
}

func connectLauncher(base: String, credentialUrl: URL, deviceId: String) async throws -> URLSessionWebSocketTask {
    let task = URLSession.shared.webSocketTask(with: try socketUrl(base: base, deviceId: deviceId))
    task.resume()
    let auth = try JSONDecoder().decode(SocketMessage.self, from: Data(try await receiveText(task).utf8))
    guard auth.type == "auth_challenge", let challengeId = auth.challengeId, let nonce = auth.nonce else {
        throw LauncherError.message("ONE 在线验证握手失败")
    }
    let signature = try signNonce(nonce, credentialUrl: credentialUrl, deviceId: deviceId)
    #if arch(arm64)
    let architecture = "arm64"
    #else
    let architecture = "x86_64"
    #endif
    let response = SocketAuthResponse(type: "auth_response", challengeId: challengeId, signature: signature, architecture: architecture, launcherVersion: launcherVersion)
    try await task.send(.string(String(decoding: try JSONEncoder().encode(response), as: UTF8.self)))
    let ready = try JSONDecoder().decode(SocketMessage.self, from: Data(try await receiveText(task).utf8))
    guard ready.type == "ready", ready.deviceId == deviceId else { throw LauncherError.message("ONE Key 在线验证失败") }
    return task
}

func compareVersions(_ left: String, _ right: String) throws -> Int {
    func parse(_ value: String) throws -> [Int] {
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        guard (2...4).contains(parts.count) else { throw LauncherError.message("更新版本格式无效") }
        return try parts.map { part in
            guard !part.isEmpty, !(part.count > 1 && part.first == "0"), part.allSatisfy(\.isNumber), let number = Int(part) else {
                throw LauncherError.message("更新版本格式无效")
            }
            return number
        }
    }
    let a = try parse(left), b = try parse(right)
    for index in 0..<max(a.count, b.count) {
        let difference = (index < a.count ? a[index] : 0) - (index < b.count ? b[index] : 0)
        if difference != 0 { return difference < 0 ? -1 : 1 }
    }
    return 0
}

func verifyRuntimeUpdate(_ envelope: SignedRuntimeUpdate) throws -> RuntimeUpdateArtifact {
    guard let publicKeyBytes = base64UrlDecode(updatePublicKeyRaw), publicKeyBytes.count == 32,
          let payloadBytes = base64UrlDecode(envelope.payload), !payloadBytes.isEmpty, payloadBytes.count <= 128 * 1024,
          let signature = base64UrlDecode(envelope.signature), signature.count == 64 else {
        throw LauncherError.message("ONE 更新清单无效")
    }
    let publicKey = try Curve25519.Signing.PublicKey(rawRepresentation: publicKeyBytes)
    guard publicKey.isValidSignature(signature, for: payloadBytes) else { throw LauncherError.message("ONE 更新签名无效") }
    let payload = try JSONDecoder().decode(RuntimeUpdatePayload.self, from: payloadBytes)
    guard payload.schemaVersion == 1, payload.channel == "stable", (1...12).contains(payload.artifacts.count) else {
        throw LauncherError.message("ONE 更新清单无效")
    }
    #if arch(arm64)
    let architecture = "arm64"
    #else
    let architecture = "x86_64"
    #endif
    let candidates = try payload.artifacts.filter { item in
        guard item.platform == "macos", item.architecture == architecture || item.architecture == "universal" else { return false }
        guard let downloadUrl = URL(string: item.url), downloadUrl.scheme == "https", downloadUrl.user == nil, downloadUrl.password == nil,
              downloadUrl.fragment == nil, item.size > 0, item.size <= Int64(512 * 1024 * 1024),
              item.sha256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
            throw LauncherError.message("ONE 更新制品无效")
        }
        return try compareVersions(item.version, launcherVersion) > 0
    }
    guard let selected = try candidates.sorted(by: { try compareVersions($0.version, $1.version) > 0 }).first else {
        throw LauncherError.message("没有适用于这台电脑的新版 ONE")
    }
    return selected
}

func sha256File(_ url: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var digest = SHA256()
    while let data = try handle.read(upToCount: 1024 * 1024), !data.isEmpty { digest.update(data: data) }
    return digest.finalize().map { String(format: "%02x", $0) }.joined()
}

func runProcess(_ executable: String, _ arguments: [String]) throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else { throw LauncherError.message("ONE 更新安装校验失败") }
}

func normalizeMacBundleOnFAT(_ bundle: URL) throws {
    try runProcess("/usr/sbin/dot_clean", ["-m", bundle.path])
    try runProcess("/usr/bin/xattr", ["-cr", bundle.path])
    try runProcess("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", bundle.path])
    try runProcess("/usr/sbin/dot_clean", ["-m", bundle.path])
    try runProcess("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle.path])
}

func verifyFATVolumeAfterUpdate(_ volumeRoot: URL) throws {
    var lastError: Error?
    for attempt in 1...3 {
        do {
            try runProcess("/bin/sync", [])
            // Resolve by mounted volume path, never by a cached disk number:
            // macOS can renumber removable devices while test images or other
            // Keys are attached.
            try runProcess("/usr/sbin/diskutil", ["verifyVolume", volumeRoot.path])
            return
        } catch {
            lastError = error
            if attempt < 3 { Thread.sleep(forTimeInterval: 2) }
        }
    }
    throw lastError ?? LauncherError.message("ONE Key 文件系统校验失败")
}

func installRuntimeUpdate(_ artifact: RuntimeUpdateArtifact, credentialUrl: URL, progress: (String) async -> Void) async throws -> URL {
    let credentialBefore = try Data(contentsOf: credentialUrl)
    guard let downloadUrl = URL(string: artifact.url) else { throw LauncherError.message("ONE 更新地址无效") }
    let (downloaded, response) = try await URLSession.shared.download(from: downloadUrl)
    guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw LauncherError.message("下载 ONE 更新失败") }
    await progress("verifying")
    let attributes = try FileManager.default.attributesOfItem(atPath: downloaded.path)
    guard (attributes[.size] as? NSNumber)?.int64Value == artifact.size,
          try sha256File(downloaded) == artifact.sha256 else { throw LauncherError.message("ONE 更新文件校验失败") }

    // FAT32 cannot store macOS extended attributes. Expanding and clearing
    // quarantine directly on the Key creates AppleDouble sidecars and makes
    // `xattr -cr` fail. Validate and de-quarantine on the local APFS volume,
    // then copy the already verified bundle to a same-volume USB staging area.
    let localStaging = FileManager.default.temporaryDirectory.appendingPathComponent("ONE-update-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: localStaging, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: localStaging) }
    try runProcess("/usr/bin/ditto", ["-x", "-k", "--norsrc", "--noextattr", downloaded.path, localStaging.path])
    let candidates = [localStaging.appendingPathComponent("ONE.app"), localStaging.appendingPathComponent("ONE for Mac.app")]
    guard let stagedApp = candidates.first(where: { FileManager.default.fileExists(atPath: $0.path) }) else {
        throw LauncherError.message("Mac 更新包不完整")
    }
    try runProcess("/usr/bin/codesign", ["--verify", "--deep", "--strict", stagedApp.path])
    // The package is authenticated by ONE's Ed25519 release signature before
    // extraction. Remove download quarantine only from that verified staged app,
    // then verify its code signature again before it can replace the USB copy.
    try runProcess("/usr/bin/xattr", ["-cr", stagedApp.path])
    try runProcess("/usr/bin/codesign", ["--verify", "--deep", "--strict", stagedApp.path])

    let oneDirectory = credentialUrl.deletingLastPathComponent()
    let volumeRoot = oneDirectory.deletingLastPathComponent()
    let target = volumeRoot.appendingPathComponent("ONE for Mac.app", isDirectory: true)
    guard FileManager.default.fileExists(atPath: target.path) else { throw LauncherError.message("U 盘中没有找到 Mac 启动器") }
    // Keep the install rename inside the volume root. Moving a directory from a
    // nested staging directory into the root can leave an invalid `..` cluster
    // on FAT32. The hidden sibling is fully copied and verified before the
    // current launcher is touched.
    let usbStagedApp = volumeRoot.appendingPathComponent(".one-macos-update-\(UUID().uuidString).app", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: usbStagedApp) }
    try FATSafeFileOperations.copyTree(from: stagedApp, to: usbStagedApp)
    // Match the factory writer: FAT32 stores macOS metadata in AppleDouble
    // files, so normalize and ad-hoc sign the already release-authenticated
    // bundle on the target volume before it is allowed to replace the launcher.
    try normalizeMacBundleOnFAT(usbStagedApp)
    guard try Data(contentsOf: credentialUrl) == credentialBefore else { throw LauncherError.message("ONE Key 凭证状态发生变化，更新已停止") }

    await progress("installing")
    let backupDirectory = oneDirectory.appendingPathComponent("update-backups", isDirectory: true)
    try FileManager.default.createDirectory(at: backupDirectory, withIntermediateDirectories: true)
    let backup = backupDirectory.appendingPathComponent("ONE-for-Mac-\(launcherVersion).app", isDirectory: true)
    if FileManager.default.fileExists(atPath: backup.path) { try FileManager.default.removeItem(at: backup) }
    // Backups may live below `.one`, but they must be copied rather than
    // renamed across FAT32 parents. Only the final staged -> target rename is
    // used, and both paths share the volume-root parent.
    try FATSafeFileOperations.copyTree(from: target, to: backup)
    try normalizeMacBundleOnFAT(backup)
    do {
        try FileManager.default.removeItem(at: target)
        try FileManager.default.moveItem(at: usbStagedApp, to: target)
        try runProcess("/usr/bin/codesign", ["--verify", "--deep", "--strict", target.path])
        try verifyFATVolumeAfterUpdate(volumeRoot)
    } catch {
        try? FileManager.default.removeItem(at: target)
        do {
            try FATSafeFileOperations.copyTree(from: backup, to: target)
            try normalizeMacBundleOnFAT(target)
        } catch {
            throw LauncherError.message("ONE 更新失败，旧版启动器也未能自动恢复，请联系管理员")
        }
        throw LauncherError.message("新版 Mac 启动器无法安装，已恢复旧版")
    }
    return target
}

@MainActor
func executionProject(deviceId: String) -> String? {
    let key = "one.execution.project.\(deviceId)"
    if let saved = oneDefaults().string(forKey: key), FileManager.default.fileExists(atPath: saved) { return saved }
    NSApplication.shared.activate(ignoringOtherApps: true)
    let panel = NSOpenPanel()
    panel.title = "选择允许 ONE 执行任务的文件夹"
    panel.message = "Codex 只能在你选择的文件夹中读取和修改文件。以后可以重新选择。"
    panel.prompt = "允许并开始执行"
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    guard panel.runModal() == .OK, let path = panel.url?.path else { return nil }
    oneDefaults().set(path, forKey: key)
    return path
}

func codexExecutable(credentialUrl: URL) -> String? {
    let volumeRoot = credentialUrl.deletingLastPathComponent().deletingLastPathComponent()
    var candidates = [String]()
    if let bundled = Bundle.main.resourceURL?.appendingPathComponent("codex").path {
        candidates.append(bundled)
    }
    candidates.append(contentsOf: [
        volumeRoot.appendingPathComponent("ONE for Mac.app/Contents/Resources/codex").path,
        volumeRoot.appendingPathComponent("ONE.app/Contents/Resources/codex").path,
        "/Applications/ChatGPT.app/Contents/Resources/codex",
        "/opt/homebrew/bin/codex",
        "/usr/local/bin/codex"
    ])
    return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
}

// Finder-launched processes do not inherit shell proxy variables. Honor the
// user's configured system HTTP proxies without hard-coding a proxy service.
func executionEnvironment() -> [String: String] {
    var environment = ProcessInfo.processInfo.environment
    guard let settings = CFNetworkCopySystemProxySettings()?.takeRetainedValue() as? [String: Any] else { return environment }
    for (prefix, variable) in [("HTTP", "HTTP_PROXY"), ("HTTPS", "HTTPS_PROXY")] {
        guard environment[variable] == nil, environment[variable.lowercased()] == nil,
              environment["ALL_PROXY"] == nil, environment["all_proxy"] == nil,
              (settings[prefix + "Enable"] as? NSNumber)?.boolValue == true,
              let host = settings[prefix + "Proxy"] as? String,
              let port = settings[prefix + "Port"] as? Int, (1...65535).contains(port) else { continue }
        var url = URLComponents()
        url.scheme = "http"; url.host = host; url.port = port
        if let value = url.url?.absoluteString { environment[variable] = value }
    }
    if environment["NO_PROXY"] == nil, environment["no_proxy"] == nil {
        let exceptions = (settings["ExceptionsList"] as? [String] ?? []).map { $0.hasPrefix("*.") ? String($0.dropFirst()) : $0 }
        environment["NO_PROXY"] = (["localhost", "127.0.0.1", "::1"] + exceptions).joined(separator: ",")
    }
    return environment
}

final class CodexExecutionRunner: @unchecked Sendable {
    private let socket: URLSessionWebSocketTask
    private let deviceId: String
    private let credentialUrl: URL
    private let lock = NSLock()
    private var processes: [String: Process] = [:]
    private var threadIds: [String: String] = [:]
    private var projectPaths: [String: String] = [:]
    private var lastResponses: [String: String] = [:]
    private var cancelled = Set<String>()
    private var outputBuffers: [String: String] = [:]
    private var errorBuffers: [String: String] = [:]

    init(socket: URLSessionWebSocketTask, deviceId: String, credentialUrl: URL) {
        self.socket = socket
        self.deviceId = deviceId
        self.credentialUrl = credentialUrl
    }

    func start(taskId: String, instruction: String, resume: Bool) {
        Task { await self.run(taskId: taskId, instruction: instruction, resume: resume) }
    }

    func cancel(taskId: String) {
        let process = synchronized { cancelled.insert(taskId); return processes[taskId] }
        process?.terminate()
        Task { await send(taskId: taskId, kind: "status", text: "已停止 Codex 执行", status: "cancelled") }
    }

    private func run(taskId: String, instruction: String, resume: Bool) async {
        let alreadyRunning = synchronized { processes[taskId] != nil }
        if alreadyRunning { await send(taskId: taskId, kind: "error", text: "Codex 正在执行当前任务", status: "failed"); return }
        guard let executable = codexExecutable(credentialUrl: credentialUrl) else {
            await send(taskId: taskId, kind: "error", text: "本机没有可用的 Codex Runtime，请更新 ONE 后重试", status: "failed")
            return
        }

        var projectPath = synchronized { projectPaths[taskId] }
        if projectPath == nil {
            await send(taskId: taskId, kind: "status", text: "请选择 Codex 可以工作的文件夹", status: "selecting_target")
            projectPath = await executionProject(deviceId: deviceId)
        }
        guard let projectPath else {
            await send(taskId: taskId, kind: "error", text: "没有选择执行文件夹", status: "cancelled")
            return
        }
        let threadId = synchronized { projectPaths[taskId] = projectPath; cancelled.remove(taskId); return threadIds[taskId] }

        let process = Process()
        let stdout = Pipe(), stderr = Pipe(), stdin = Pipe()
        process.executableURL = URL(fileURLWithPath: executable)
        process.environment = executionEnvironment()
        var arguments = ["exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check", "-C", projectPath]
        if resume, let threadId { arguments += ["resume", threadId, "-"] } else { arguments.append("-") }
        process.arguments = arguments
        process.standardOutput = stdout
        process.standardError = stderr
        process.standardInput = stdin

        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let self else { return }
            for line in self.appendOutput(taskId: taskId, data: data) { self.consume(taskId: taskId, line: line, targetName: URL(fileURLWithPath: projectPath).lastPathComponent) }
        }
        stderr.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let self else { return }
            self.synchronized {
                let combined = (self.errorBuffers[taskId] ?? "") + String(decoding: data, as: UTF8.self)
                self.errorBuffers[taskId] = String(combined.suffix(4000))
            }
        }

        do {
            try process.run()
            synchronized { processes[taskId] = process; lastResponses.removeValue(forKey: taskId) }
            await send(taskId: taskId, kind: "status", text: resume ? "Codex 已继续执行" : "Codex 已开始执行", targetName: URL(fileURLWithPath: projectPath).lastPathComponent, status: "running")
            stdin.fileHandleForWriting.write(Data(instruction.utf8)); try? stdin.fileHandleForWriting.close()
            let exitCode = await Task.detached { process.waitUntilExit(); return process.terminationStatus }.value
            stdout.fileHandleForReading.readabilityHandler = nil
            stderr.fileHandleForReading.readabilityHandler = nil
            let result = synchronized { () -> (Bool, String?, String) in
                processes.removeValue(forKey: taskId)
                let wasCancelled = cancelled.remove(taskId) != nil
                let finalResponse = lastResponses[taskId]
                let errorText = errorBuffers.removeValue(forKey: taskId) ?? ""
                outputBuffers.removeValue(forKey: taskId)
                return (wasCancelled, finalResponse, errorText.trimmingCharacters(in: .whitespacesAndNewlines))
            }
            let (wasCancelled, finalResponse, errorText) = result
            if wasCancelled { return }
            if exitCode == 0 {
                await send(taskId: taskId, kind: "status", text: finalResponse == nil ? "Codex 本轮已结束，但没有返回文字结果" : "Codex 本轮已结束，请查看执行结果", status: "completed")
            } else {
                await send(taskId: taskId, kind: "error", text: errorText.isEmpty ? "Codex 执行失败" : String(errorText.prefix(4000)), status: "failed")
            }
        } catch {
            stdout.fileHandleForReading.readabilityHandler = nil
            stderr.fileHandleForReading.readabilityHandler = nil
            synchronized { processes.removeValue(forKey: taskId); outputBuffers.removeValue(forKey: taskId); errorBuffers.removeValue(forKey: taskId) }
            await send(taskId: taskId, kind: "error", text: "无法启动 Codex：\(error.localizedDescription)", status: "failed")
        }
    }

    private func consume(taskId: String, line: String, targetName: String) {
        guard let data = line.data(using: .utf8), let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let type = payload["type"] as? String else { return }
        if type == "thread.started", let id = payload["thread_id"] as? String {
            synchronized { threadIds[taskId] = id }
            Task { await send(taskId: taskId, kind: "status", text: "Codex 会话已建立", providerThreadId: id, targetName: targetName, status: "running") }
            return
        }
        guard let item = payload["item"] as? [String: Any], let itemType = item["type"] as? String else { return }
        if type == "item.completed", itemType == "agent_message", let text = item["text"] as? String, !text.isEmpty {
            synchronized { lastResponses[taskId] = text }
            Task { await send(taskId: taskId, kind: "message", text: text) }
        } else if type == "item.started", itemType == "command_execution", let command = item["command"] as? String {
            Task { await send(taskId: taskId, kind: "command", text: "正在运行：\(String(command.prefix(600)))") }
        } else if type == "item.completed", itemType == "file_change" {
            Task { await send(taskId: taskId, kind: "file_change", text: "Codex 已更新文件") }
        }
    }

    private func send(taskId: String, kind: String, text: String? = nil, providerThreadId: String? = nil, targetName: String? = nil, status: String? = nil) async {
        let event = ExecutionEventResponse(taskId: taskId, kind: kind, text: text, providerThreadId: providerThreadId, targetName: targetName, status: status)
        if let data = try? JSONEncoder().encode(event) { try? await socket.send(.string(String(decoding: data, as: UTF8.self))) }
    }

    @discardableResult
    private func synchronized<T>(_ body: () -> T) -> T {
        lock.lock(); defer { lock.unlock() }; return body()
    }

    private func appendOutput(taskId: String, data: Data) -> [String] {
        synchronized {
            let combined = (outputBuffers[taskId] ?? "") + String(decoding: data, as: UTF8.self)
            let parts = combined.split(separator: "\n", omittingEmptySubsequences: false)
            outputBuffers[taskId] = String(parts.last ?? "")
            return parts.dropLast().filter { !$0.isEmpty }.map(String.init)
        }
    }
}

func serveProofs(_ task: URLSessionWebSocketTask, credentialUrl: URL, deviceId: String) async throws -> URL? {
    let execution = CodexExecutionRunner(socket: task, deviceId: deviceId, credentialUrl: credentialUrl)
    while true {
        let message = try JSONDecoder().decode(SocketMessage.self, from: Data(try await receiveText(task).utf8))
        if message.type == "request_challenge", let challengeId = message.challengeId, let nonce = message.nonce {
            let signature = try signNonce(nonce, credentialUrl: credentialUrl, deviceId: deviceId)
            let response = SocketResponse(type: "proof_response", challengeId: challengeId, signature: signature)
            try await task.send(.string(String(decoding: try JSONEncoder().encode(response), as: UTF8.self)))
        } else if message.type == "execution_start", let taskId = message.taskId, let instruction = message.instruction {
            execution.start(taskId: taskId, instruction: instruction, resume: false)
        } else if message.type == "execution_continue", let taskId = message.taskId, let instruction = message.instruction {
            execution.start(taskId: taskId, instruction: instruction, resume: true)
        } else if message.type == "execution_cancel", let taskId = message.taskId {
            execution.cancel(taskId: taskId)
        } else if message.type == "update_install", let requestId = message.requestId, let envelope = message.envelope {
            do {
                let artifact = try verifyRuntimeUpdate(envelope)
                try await task.send(.string(String(decoding: try JSONEncoder().encode(UpdateEventResponse(requestId: requestId, status: "downloading", error: nil)), as: UTF8.self)))
                let installedApp = try await installRuntimeUpdate(artifact, credentialUrl: credentialUrl) { status in
                    if let data = try? JSONEncoder().encode(UpdateEventResponse(requestId: requestId, status: status, error: nil)) {
                        try? await task.send(.string(String(decoding: data, as: UTF8.self)))
                    }
                }
                try await task.send(.string(String(decoding: try JSONEncoder().encode(UpdateEventResponse(requestId: requestId, status: "completed", error: nil)), as: UTF8.self)))
                return installedApp
            } catch {
                try? await task.send(.string(String(decoding: (try? JSONEncoder().encode(UpdateEventResponse(requestId: requestId, status: "failed", error: error.localizedDescription))) ?? Data(), as: UTF8.self)))
            }
        }
    }
}

func post<Request: Encodable, Response: Decodable>(_ url: URL, body: Request) async throws -> Response {
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONEncoder().encode(body)
    let (data, response) = try await URLSession.shared.data(for: request)
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
        let failure = try? JSONDecoder().decode(ApiFailure.self, from: data)
        throw LauncherError.message(failure?.error ?? "ONE 服务暂时不可用")
    }
    return try JSONDecoder().decode(Response.self, from: data)
}

func openLoginPage(base: String, credentialUrl: URL, deviceId: String) async throws {
    guard let challengeUrl = URL(string: "\(base)/api/one-key/challenge") else { throw LauncherError.message("ONE 服务地址无效") }
    let challenge: ChallengeResponse = try await post(challengeUrl, body: ChallengeRequest(deviceId: deviceId, installationId: installationId()))
    guard let verifyUrl = URL(string: "\(base)/api/one-key/challenge/\(challenge.challengeId)/verify") else { throw LauncherError.message("ONE 验证地址无效") }
    let signature = try signNonce(challenge.nonce, credentialUrl: credentialUrl, deviceId: deviceId)
    let verified: VerifyResponse = try await post(verifyUrl, body: VerifyRequest(signature: signature))
    guard let loginUrl = URL(string: "\(base)/#one-key=\(verified.loginCode)") else { throw LauncherError.message("ONE 登录地址无效") }
    guard await MainActor.run(body: { NSWorkspace.shared.open(loginUrl) }) else {
        throw LauncherError.message("无法打开默认浏览器")
    }
}

@MainActor
final class ONEKeyAppDelegate: NSObject, NSApplicationDelegate {
    private let residentMode: Bool
    private var expectedDeviceId: String?
    private let initialCredentialUrl: URL?
    private var credentialUrl: URL?
    private var credential: DeviceCredential?
    private var base = ""
    private var socket: URLSessionWebSocketTask?
    private var sessionTask: Task<Void, Never>?
    private var removalTask: Task<Void, Never>?
    private var loginTask: Task<Void, Never>?
    private var sessionGeneration = UUID()
    private var stopping = false
    private var ready = false
    private var openedLogin = false
    private var loginRequested = false
    private var residentLock: ResidentLock?
    private let networkMonitor = NWPathMonitor()
    private var receivedInitialPath = false

    init(residentMode: Bool, expectedDeviceId: String?, initialCredentialUrl: URL?) {
        self.residentMode = residentMode
        self.expectedDeviceId = expectedDeviceId
        self.initialCredentialUrl = initialCredentialUrl
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if !residentMode {
            do {
                try launchResidentCopy()
                NSApplication.shared.terminate(nil)
                return
            } catch {
                // If local installation is unavailable, retain the portable
                // behavior so the Key remains usable after a manual launch.
                NSLog("ONE resident installation failed: \(error.localizedDescription)")
            }
        }
        if residentMode {
            do {
                let resolvedDeviceId: String
                if let expectedDeviceId {
                    resolvedDeviceId = expectedDeviceId
                } else {
                    guard let foundUrl = findCredentialUrl(preferred: initialCredentialUrl) else { throw LauncherError.message("没有找到 ONE Key，请插入后重试") }
                    let foundCredential = try loadCredential(foundUrl)
                    credentialUrl = foundUrl
                    credential = foundCredential
                    resolvedDeviceId = foundCredential.deviceId
                    self.expectedDeviceId = resolvedDeviceId
                }
                guard let lock = try acquireResidentLock(deviceId: resolvedDeviceId) else {
                    sessionTask = Task { await openLoginThroughExistingResident(deviceId: resolvedDeviceId, preferred: initialCredentialUrl) }
                    return
                }
                residentLock = lock
            } catch {
                showFailure(error)
                return
            }
        }
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(resumeConnection), name: NSWorkspace.didWakeNotification, object: nil)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(volumeDidMount(_:)), name: NSWorkspace.didMountNotification, object: nil)
        networkMonitor.pathUpdateHandler = { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                if self.receivedInitialPath, !self.ready { self.restartSession() }
                self.receivedInitialPath = true
            }
        }
        networkMonitor.start(queue: DispatchQueue(label: "one.network-state"))
        restartSession()
    }

    @objc private func resumeConnection() {
        restartSession()
    }

    @objc private func volumeDidMount(_ notification: Notification) {
        guard let volume = notification.userInfo?[NSWorkspace.volumeURLUserInfoKey] as? URL else { return }
        let candidate = volume.appendingPathComponent(".one/credential.json")
        let wantedDeviceId = credential?.deviceId ?? expectedDeviceId
        guard let mountedCredential = try? loadCredential(candidate), wantedDeviceId == nil || mountedCredential.deviceId == wantedDeviceId else { return }
        credentialUrl = candidate
        credential = mountedCredential
        restartSession()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        requestLogin()
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopping = true
        NSWorkspace.shared.notificationCenter.removeObserver(self)
        networkMonitor.cancel()
        loginTask?.cancel()
        removalTask?.cancel()
        sessionTask?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
    }

    private func restartSession() {
        guard residentMode, !stopping else { return }
        let generation = UUID()
        sessionGeneration = generation
        socket?.cancel(with: .goingAway, reason: nil)
        removalTask?.cancel()
        sessionTask?.cancel()
        ready = false
        sessionTask = Task { await runSession(generation: generation) }
    }

    private func runSession(generation: UUID) async {
        var failures = 0
        while !stopping, generation == sessionGeneration {
        do {
            let wantedDeviceId = credential?.deviceId ?? expectedDeviceId
            guard let foundUrl = findCredentialUrl(expectedDeviceId: wantedDeviceId, preferred: credentialUrl) else {
                if residentMode {
                    ready = false
                    socket = nil
                    do { try await Task.sleep(for: .seconds(1)) } catch { return }
                    continue
                }
                throw LauncherError.message("没有找到 ONE Key，请插入后重试")
            }
            let foundCredential = try loadCredential(foundUrl)
            let foundBase = foundCredential.serverBaseUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            credentialUrl = foundUrl
            credential = foundCredential
            base = foundBase
            let connectedSocket = try await connectLauncher(base: foundBase, credentialUrl: foundUrl, deviceId: foundCredential.deviceId)
            guard generation == sessionGeneration, !stopping else {
                connectedSocket.cancel(with: .goingAway, reason: nil)
                return
            }

            socket = connectedSocket
            ready = true
            removalTask = Task { await monitorRemoval(of: foundUrl) }

            if !openedLogin || loginRequested {
                loginRequested = false
                try await openLoginPage(base: foundBase, credentialUrl: foundUrl, deviceId: foundCredential.deviceId)
                openedLogin = true
            }
            failures = 0
            if let installedApp = try await serveProofs(connectedSocket, credentialUrl: foundUrl, deviceId: foundCredential.deviceId) {
                // Release the per-Key lock before starting the new portable
                // app so its updated resident can take over immediately.
                socket?.cancel(with: .goingAway, reason: nil)
                ready = false
                residentLock = nil
                let process = Process()
                process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
                process.arguments = ["-n", installedApp.path]
                process.standardOutput = FileHandle.nullDevice
                process.standardError = FileHandle.nullDevice
                try process.run()
                process.waitUntilExit()
                guard process.terminationStatus == 0 else { throw LauncherError.message("新版 Mac 启动器无法启动") }
                stopping = true
                NSApplication.shared.terminate(nil)
                return
            }
            if !stopping { throw LauncherError.message("ONE Key 连接已断开") }
        } catch is CancellationError {
            // A mount, wake or network change starts a fresh generation. The
            // cancelled generation must exit instead of silently killing the
            // only resident connection loop.
            if stopping || generation != sessionGeneration { return }
            socket = nil
            removalTask?.cancel()
            ready = false
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                guard let self, !self.stopping, generation == self.sessionGeneration else { return }
                self.restartSession()
            }
            return
        } catch {
            if stopping || generation != sessionGeneration { return }
            failures += 1
            let closeCode = socket?.closeCode.rawValue ?? 0
            socket?.cancel(with: .goingAway, reason: nil)
            removalTask?.cancel()
            ready = false
            if closeCode == 4009 {
                // A newer resident already owns this computer. Exit fully so
                // the stale process cannot keep the local singleton lock.
                stopping = true
                residentLock = nil
                NSApplication.shared.terminate(nil)
                return
            }
            if closeCode == 4003 {
                if !stopping { showFailure(LauncherError.message("ONE Key 已挂失或凭证无效")) }
                return
            }
            if closeCode == 4006 {
                if !stopping { showFailure(LauncherError.message("请更新 U 盘中的 ONE 启动器")) }
                return
            }
            if residentMode, !stopping {
                let keyStillPresent = findCredentialUrl(expectedDeviceId: credential?.deviceId ?? expectedDeviceId, preferred: credentialUrl) != nil
                if !keyStillPresent {
                    failures = 0
                    do { try await Task.sleep(for: .seconds(1)) } catch { return }
                    continue
                }
                do { try await Task.sleep(for: .seconds(min(failures * 3, 15))) } catch { return }
                failures = min(failures, 5)
                continue
            }
            if !stopping, openedLogin, let credentialUrl, FileManager.default.fileExists(atPath: credentialUrl.path) {
                socket?.cancel(with: .goingAway, reason: nil)
                do { try await Task.sleep(for: .seconds(min(failures * 3, 15))) } catch { return }
                failures = min(failures, 5)
            } else {
                if !stopping { showFailure(error) }
                return
            }
        }
        }
    }

    private func requestLogin() {
        loginRequested = true
        guard ready, loginTask == nil, let credentialUrl, let credential else { return }
        loginRequested = false
        let base = self.base
        loginTask = Task {
            do {
                try await openLoginPage(base: base, credentialUrl: credentialUrl, deviceId: credential.deviceId)
            } catch is CancellationError {
                // Normal application termination.
            } catch {
                if !stopping { showFailure(error, terminateAfterDismissal: false) }
            }
            loginTask = nil
        }
    }

    private func openLoginThroughExistingResident(deviceId: String, preferred: URL? = nil) async {
        do {
            guard let credentialUrl = findCredentialUrl(expectedDeviceId: deviceId, preferred: preferred) else {
                throw LauncherError.message("没有找到 ONE Key，请插入后重试")
            }
            let credential = try loadCredential(credentialUrl, expectedDeviceId: deviceId)
            try await openLoginPage(base: credential.serverBaseUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/")), credentialUrl: credentialUrl, deviceId: deviceId)
        } catch {
            if !stopping { showFailure(error, terminateAfterDismissal: false) }
        }
        stopping = true
        NSApplication.shared.terminate(nil)
    }

    private func monitorRemoval(of credentialUrl: URL) async {
        while !Task.isCancelled {
            do { try await Task.sleep(for: .milliseconds(500)) } catch { return }
            if !FileManager.default.fileExists(atPath: credentialUrl.path) {
                socket?.cancel(with: .goingAway, reason: nil)
                if !residentMode {
                    stopping = true
                    NSApplication.shared.terminate(nil)
                }
                return
            }
        }
    }

    private func showFailure(_ error: Error, terminateAfterDismissal: Bool = true) {
        NSApplication.shared.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "无法打开 ONE"
        alert.informativeText = error.localizedDescription
        alert.alertStyle = .warning
        alert.addButton(withTitle: "知道了")
        alert.runModal()
        if terminateAfterDismissal {
            stopping = true
            NSApplication.shared.terminate(nil)
        }
    }
}

@main
struct ONEKeyLauncher {
    @MainActor
    static func main() {
        let residentMode = CommandLine.arguments.contains(residentArgument)
        let application = NSApplication.shared
        let credentialPath = commandLineValue(credentialArgument).map { URL(fileURLWithPath: $0) }
        let delegate = ONEKeyAppDelegate(residentMode: residentMode, expectedDeviceId: commandLineValue(deviceArgument), initialCredentialUrl: credentialPath)
        application.delegate = delegate
        application.setActivationPolicy(.accessory)
        application.run()
    }
}
