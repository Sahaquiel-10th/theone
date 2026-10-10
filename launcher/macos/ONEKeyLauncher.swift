import AppKit
import CryptoKit
import Foundation
import CFNetwork
import Network
import Darwin

let launcherVersion = "__ONE_RUNTIME_VERSION__"
let updatePublicKeyRaw = "__ONE_UPDATE_PUBLIC_KEY__"
let executorPublicKeyRaw = "__ONE_EXECUTOR_PUBLIC_KEY__"
let managedCodexActivity = ManagedCodexActivity()
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
    let round: Int?
    let requestId: String?
    let change: Bool?
    let tool: String?
    let arguments: LocalFileArguments?
    let envelope: SignedRuntimeUpdate?
    let gateway: CodexGatewayConfiguration?
}
struct SocketResponse: Encodable { let type: String; let challengeId: String; let signature: String }
struct SocketAuthResponse: Encodable {
    let type: String
    let challengeId: String
    let signature: String
    let capabilities = ["runtime_update_v1", "local_configuration_v1", "local_tools_v1", "codex_exec_v1", "execution_round_v1", "codex_gateway_v1", "managed_codex_v1"]
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
    let round: Int
}
struct LocalConfigurationResponse: Encodable {
    let type: String
    let taskId: String
    let requestId: String
    let targetName: String?
    let output: String
    let error: String?
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

private var credentialAccessBlocked = false
private let credentialAccessMessage = "macOS 未允许 ONE 读取 Key，自动重试已停止。请先退出其他旧版 ONE，再检查系统设置中的可移除宗卷权限，然后重新打开 ONE。无需反复点击允许或重新安装。"

func loadCredential(_ credentialUrl: URL, expectedDeviceId: String? = nil) throws -> DeviceCredential {
    guard !credentialAccessBlocked else { throw LauncherError.message(credentialAccessMessage) }
    let data: Data
    do {
        // fileExists hides permission errors as 'missing'. Read once so that
        // denied access suspends this process instead of entering mount polling.
        data = try Data(contentsOf: credentialUrl)
    } catch {
        if isCredentialPermissionDenied(error) {
            credentialAccessBlocked = true
            throw LauncherError.message(credentialAccessMessage)
        }
        throw error
    }
    let credential = try JSONDecoder().decode(DeviceCredential.self, from: data)
    guard credential.version == 1, expectedDeviceId == nil || credential.deviceId == expectedDeviceId else {
        throw LauncherError.message("ONE Key 凭证不匹配")
    }
    return credential
}

private var nextVolumeScan = Date.distantPast
func findCredentialUrl(expectedDeviceId: String? = nil, preferred: URL? = nil) -> URL? {
    guard !credentialAccessBlocked else { return nil }
    let portable = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent(".one/credential.json")
    var candidates = [URL]()
    if let preferred { candidates.append(preferred) }
    candidates.append(portable)
    // Fast path never enumerates other volumes. Validate identity too: another
    // Key may now occupy the old mount path.
    if let found = candidates.first(where: { (try? loadCredential($0, expectedDeviceId: expectedDeviceId)) != nil }) { return found }
    guard !credentialAccessBlocked else { return nil }
    guard mayScanOtherKeyVolumes(expectedDeviceId: expectedDeviceId, preferred: preferred) else { return nil }
    // Event handlers give prompt recovery; this bounded fallback covers missed
    // mount notifications without scanning all disks every 500 ms.
    if Date() >= nextVolumeScan {
        nextVolumeScan = Date().addingTimeInterval(10)
        let volumes = FileManager.default.mountedVolumeURLs(includingResourceValuesForKeys: nil, options: [.skipHiddenVolumes]) ?? []
        candidates.append(contentsOf: volumes.map { $0.appendingPathComponent(".one/credential.json") })
    }
    var seen = Set<String>()
    return candidates
        .filter { seen.insert($0.standardizedFileURL.path).inserted }
        .first { url in
            guard !credentialAccessBlocked, let credential = try? loadCredential(url) else { return false }
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
    // v1 residents can remain offline while holding their legacy lock forever.
    // Use a stable v2 namespace, not a per-version lock: all repaired releases
    // still share one local owner per Key. Authenticated server arbitration
    // remains authoritative against older residents; never delete their locks.
    let target = directory.appendingPathComponent(residentLockFilename(digest: digest))
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

func macRecoveryJournal(deviceId: String) throws -> URL {
    let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    let digest = SHA256.hash(data: Data(deviceId.utf8)).map { String(format: "%02x", $0) }.joined()
    return support.appendingPathComponent("ONE/runtime-recovery-\(digest).json")
}
@discardableResult
func recoverMacRuntimeOnMount(credential: URL, deviceId: String, preferPrevious: Bool = false) throws -> (record: MacRuntimeRecovery, status: String)? {
    try recoverMacRuntime(credential: credential, journal: macRecoveryJournal(deviceId: deviceId), preferPrevious: preferPrevious) { app in
        try runProcess("/usr/bin/codesign", ["--verify", "--deep", "--strict", app.path])
    }
}

func commandLineValue(_ name: String) -> String? {
    guard let index = CommandLine.arguments.firstIndex(of: name), CommandLine.arguments.indices.contains(index + 1) else { return nil }
    return CommandLine.arguments[index + 1]
}

func launchResidentCopy() throws {
    _ = installationId()
    guard let source = Bundle.main.executableURL else { throw LauncherError.message("ONE 启动器不完整") }
    let portableCredential = commandLineValue(credentialArgument).map { URL(fileURLWithPath: $0) } ?? Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent(".one/credential.json")
    guard portableCredential.standardizedFileURL.pathComponents.count == 5, portableCredential.path.hasPrefix("/Volumes/"), portableCredential.lastPathComponent == "credential.json", portableCredential.deletingLastPathComponent().lastPathComponent == ".one" else {
        throw LauncherError.message("请从 ONE Key 打开启动器")
    }
    try launchResidentExecutable(source: source, version: launcherVersion, credential: portableCredential, resume: CommandLine.arguments.contains("--one-update-resume"))
}

func launchResidentExecutable(source: URL, version: String, credential: URL, resume: Bool) throws {
    guard version.range(of: #"^\d+(?:\.\d+){1,3}$"#, options: .regularExpression) != nil else { throw LauncherError.message("ONE 启动器版本无效") }
    let applicationSupport = try FileManager.default.url(
        for: .applicationSupportDirectory,
        in: .userDomainMask,
        appropriateFor: nil,
        create: true
    )
    let installDirectory = applicationSupport.appendingPathComponent("ONE", isDirectory: true)
    try FileManager.default.createDirectory(at: installDirectory, withIntermediateDirectories: true)
    guard let transition = try acquireMachineLease(directory: installDirectory, name: "machine-launch-v1.lock") else {
        throw LauncherError.message("ONE 正在切换或更新，请稍后再打开。无需反复点击。")
    }
    defer { withExtendedLifetime(transition) {} }
    let sourceApp = source.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    guard sourceApp.pathExtension == "app" else { throw LauncherError.message("ONE 启动器应用不完整") }
    let residentApp = installDirectory.appendingPathComponent("ONEPresence-\(version).app")
    let target = try prepareRuntimeResidentBundle(source: sourceApp, target: residentApp) { app in
        try runProcess("/usr/bin/codesign", ["--verify", "--deep", "--strict", app.path])
    }

    // Explicit opening switches this OS user to one Key. Retire old permission
    // identities before the replacement reads any credential. Never kill by name.
    try stopInstalledMachineResidents(support: installDirectory)
    let process = Process()
    process.executableURL = target
    // The portable app must not read the credential itself. The installed
    // resident is the single process that receives removable-volume access,
    // discovers the Key and keeps proving its presence.
    process.arguments = [residentArgument, credentialArgument, credential.path]
    if resume { process.arguments?.append("--one-update-resume") }
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    // Serialize rapid double-clicks until the child owns the machine lease,
    // which it acquires before credential access or any permission prompt.
    for _ in 0..<30 {
        if residentLockOwners(installDirectory.appendingPathComponent("machine-presence-v1.lock")).contains(process.processIdentifier) { return }
        if !process.isRunning { throw LauncherError.message("ONE 未能启动，请重新打开同一枚 Key。无需重复安装。") }
        usleep(100_000)
    }
    throw LauncherError.message("ONE 启动尚未确认，请稍后重新打开同一枚 Key。")
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
    var connected = false
    defer { if !connected { task.cancel(with: .goingAway, reason: nil) } }
    // A wake/mount event can cancel this generation during the handshake.
    let cancellationWatch = Task {
        while !Task.isCancelled {
            do { try await Task.sleep(for: .seconds(8)) } catch { return }
            task.cancel(with: .goingAway, reason: nil)
            return
        }
    }
    defer { cancellationWatch.cancel() }
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
    try Task.checkCancellation()
    connected = true
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

func installRuntimeUpdate(_ artifact: RuntimeUpdateArtifact, credentialUrl: URL, requestId: String = "", progress: (String) async -> Void) async throws -> URL {
    let credentialBefore = try Data(contentsOf: credentialUrl)
    guard let downloadUrl = URL(string: artifact.url) else { throw LauncherError.message("ONE 更新地址无效") }
    let downloadConfiguration = URLSessionConfiguration.ephemeral
    downloadConfiguration.timeoutIntervalForRequest = 30
    downloadConfiguration.timeoutIntervalForResource = 240
    let downloadSession = URLSession(configuration: downloadConfiguration)
    defer { downloadSession.invalidateAndCancel() }
    let (downloaded, response) = try await downloadSession.download(from: downloadUrl)
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
    let deviceId = try loadCredential(credentialUrl).deviceId
    let journal = try macRecoveryJournal(deviceId: deviceId)
    let recovery = try prepareMacRuntimeRecovery(credential: credentialUrl, staged: usbStagedApp, journal: journal, requestId: requestId, version: artifact.version)
    let previous = volumeRoot.appendingPathComponent(recovery.previousName)
    do {
        try FileManager.default.moveItem(at: target, to: previous)
        try FileManager.default.moveItem(at: usbStagedApp, to: target)
        try runProcess("/usr/bin/codesign", ["--verify", "--deep", "--strict", target.path])
        try verifyFATVolumeAfterUpdate(volumeRoot)
        try recoverMacRuntimeOnMount(credential: credentialUrl, deviceId: deviceId)
    } catch {
        do {
            try recoverMacRuntimeOnMount(credential: credentialUrl, deviceId: deviceId)
        } catch {
            throw LauncherError.message("更新已暂停，请插回同一枚 ONE Key；连接恢复后会自动校验或恢复启动器")
        }
        throw LauncherError.message("新版 Mac 启动器无法安装，已恢复旧版")
    }
    return target
}

@MainActor
func executionProject(deviceId: String, change: Bool = false) -> String? {
    let key = "one.execution.project.\(deviceId)"
    if !change, let saved = oneDefaults().string(forKey: key), FileManager.default.fileExists(atPath: saved) { return saved }
    NSApplication.shared.activate(ignoringOtherApps: true)
    let panel = NSOpenPanel()
    panel.title = "选择允许 ONE 执行任务的文件夹"
    panel.message = "选择本轮工作的文件夹。ONE 原生文件工具限于此目录；外部执行器的权限另由其安全机制约束。可在 ONE 设置中更换。"
    panel.prompt = "允许并开始执行"
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    guard panel.runModal() == .OK, let path = panel.url?.path else { return nil }
    let canonical = URL(fileURLWithPath: path).resolvingSymlinksInPath().path
    oneDefaults().set(canonical, forKey: key)
    return canonical
}

@MainActor
func codexApplications() -> [URL] {
    var apps = [URL]()
    for identifier in ["com.openai.codex", "com.openai.chat", "com.openai.chatgpt"] {
        if let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: identifier) { apps.append(app) }
    }
    for root in [URL(fileURLWithPath: "/Applications"), FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications")] {
        for name in ["ChatGPT.app", "Codex.app"] { apps.append(root.appendingPathComponent(name)) }
    }
    return apps
}

@MainActor
func selectCodexRuntime() -> String? {
    NSApplication.shared.activate(ignoringOtherApps: true)
    let panel = NSOpenPanel()
    panel.title = "选择 Codex 应用或命令行程序"
    panel.message = "ONE 未自动找到 Codex。请选择已安装的 ChatGPT/Codex 应用，或 codex 程序；取消不会安装或修改任何软件。"
    panel.prompt = "使用此 Codex"
    panel.canChooseFiles = true; panel.canChooseDirectories = false
    panel.treatsFilePackagesAsDirectories = false; panel.allowsMultipleSelection = false
    guard panel.runModal() == .OK else { return nil }
    return panel.url?.path
}

func codexExecutable(credentialUrl: URL, allowSelection: Bool = true) async -> String? {
    if !allowSelection { return await oneGatewayCodex(credentialUrl: credentialUrl)?.path }
    if let installed = try? managedCodexInstalled(credentialUrl: credentialUrl), isCodexRuntime(installed.path) { return installed.path }
    let volumeRoot = credentialUrl.deletingLastPathComponent().deletingLastPathComponent()
    let key = "one.execution.codex.path"
    let apps = await codexApplications()
    let candidates = codexRuntimeCandidates(saved: oneDefaults().string(forKey: key), resources: Bundle.main.resourceURL, volume: volumeRoot, applications: apps, home: FileManager.default.homeDirectoryForCurrentUser, path: ProcessInfo.processInfo.environment["PATH"] ?? "")
    if let found = await Task.detached(operation: { candidates.first(where: isCodexRuntime) }).value {
        oneDefaults().set(found, forKey: key)
        return found
    }
    oneDefaults().removeObject(forKey: key)
    if !allowSelection { return nil }
    guard let selected = await selectCodexRuntime() else { return nil }
    let choices = selected.hasSuffix(".app")
        ? codexRuntimeCandidates(saved: nil, resources: nil, volume: volumeRoot, applications: [URL(fileURLWithPath: selected)], home: FileManager.default.homeDirectoryForCurrentUser, path: "").filter { $0.hasPrefix(selected + "/") }
        : [selected]
    guard let found = await Task.detached(operation: { choices.first(where: isCodexRuntime) }).value else { return nil }
    oneDefaults().set(found, forKey: key)
    return found
}

func oneGatewayCodex(credentialUrl: URL) async -> (path: String, version: String, source: String)? {
    let volume = credentialUrl.deletingLastPathComponent().deletingLastPathComponent()
    let apps = await codexApplications()
    let managedRoot = (try? managedCodexRoot().path) ?? ""
    let candidates = codexRuntimeCandidates(saved: oneDefaults().string(forKey: "one.execution.codex.path"), resources: Bundle.main.resourceURL, volume: volume, applications: apps, home: FileManager.default.homeDirectoryForCurrentUser, path: ProcessInfo.processInfo.environment["PATH"] ?? "")
        .filter { managedRoot.isEmpty || !$0.hasPrefix(managedRoot + "/") }
    if let existing = await Task.detached(operation: { discoverCompatibleCodex(candidates) }).value {
        return (existing.path, existing.version, "existing")
    }
    if let managed = try? managedCodexInstalled(credentialUrl: credentialUrl),
       await Task.detached(operation: { discoverCompatibleCodex([managed.path]) != nil }).value {
        return (managed.path, managed.version, "managed")
    }
    return nil
}

func managedCodexRoot() throws -> URL {
    try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        .appendingPathComponent("ONE/executors", isDirectory: true)
}
func runtimeArchitecture() -> String {
    #if arch(arm64)
    return "arm64"
    #else
    return "x86_64"
    #endif
}
func managedCodexInstalled(credentialUrl: URL) throws -> (path: String, version: String)? {
    let credential = try JSONDecoder().decode(DeviceCredential.self, from: Data(contentsOf: credentialUrl))
    guard let origin = URL(string: credential.serverBaseUrl) else { throw ManagedCodexError.invalid }
    return try installedManagedCodex(root: managedCodexRoot(), publicKey: executorPublicKeyRaw, origin: origin, architecture: runtimeArchitecture())
}
@MainActor
func confirmManagedCodex(_ release: ManagedCodexRelease) -> Bool {
    NSApplication.shared.activate(ignoringOtherApps: true)
    let alert = NSAlert()
    alert.messageText = "准备 ONE 本机执行工具"
    alert.informativeText = "将下载官方 Codex \(release.version)（约 \(max(1, release.size / 1024 / 1024)) MB），来源经 ONE 校验。安装到本机 ONE 专用目录，不需要第三方登录，不改现有 Codex 配置。工作文件夹授权仍单独选择。"
    alert.addButton(withTitle: "下载并准备"); alert.addButton(withTitle: "暂不准备")
    return alert.runModal() == .alertFirstButtonReturn
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
    private var toolFailures = Set<String>()
    private var cancelled = Set<String>()
    private var preparing = Set<String>()
    private var rounds: [String: Int] = [:]
    private var outputBuffers: [String: String] = [:]
    private var errorBuffers: [String: String] = [:]

    init(socket: URLSessionWebSocketTask, deviceId: String, credentialUrl: URL) {
        self.socket = socket
        self.deviceId = deviceId
        self.credentialUrl = credentialUrl
    }

    func start(taskId: String, instruction: String, resume: Bool, round: Int = 0, gateway: CodexGatewayConfiguration? = nil) {
        let accepted = synchronized { () -> Bool in
            if processes[taskId] != nil || preparing.contains(taskId) { return false }
            preparing.insert(taskId); cancelled.remove(taskId); rounds[taskId] = round
            return true
        }
        guard accepted else {
            Task { await send(taskId: taskId, kind: "error", text: "上一轮的本机进程或授权窗口尚未退出，请关闭窗口后再执行；本次未启动，也不会自动重跑。", status: "failed", round: round) }
            return
        }
        Task { await self.run(taskId: taskId, instruction: instruction, resume: resume, gateway: gateway) }
    }

    func cancel(taskId: String) {
        let (process, round) = synchronized { cancelled.insert(taskId); return (processes[taskId], rounds[taskId] ?? 0) }
        process?.terminate()
        Task { await send(taskId: taskId, kind: "status", text: "已提交停止请求；已产生的修改不会自动撤销", status: "cancelled", round: round) }
    }

    private func run(taskId: String, instruction: String, resume: Bool, gateway: CodexGatewayConfiguration?) async {
        defer { synchronized { preparing.remove(taskId) } }
        let alreadyRunning = synchronized { processes[taskId] != nil }
        if managedCodexActivity.isActive() { await send(taskId: taskId, kind: "error", text: "正在准备本机执行工具，本轮尚未操作文件，请准备完成后再执行", status: "failed"); return }
        if alreadyRunning { await send(taskId: taskId, kind: "error", text: "Codex 正在执行当前任务", status: "failed"); return }
        guard let executable = await codexExecutable(credentialUrl: credentialUrl, allowSelection: gateway == nil) else {
            await send(taskId: taskId, kind: "error", text: gateway != nil ? "尚未找到执行工具。请在设置 → 本机执行中准备工具，然后重新执行；本轮未操作文件，不需要个人 Codex 登录。" : "尚未连接可用的 Codex，或已取消选择。请安装 Codex 并登录，或执行时选择已有应用。更新 ONE 不会自动安装 Codex。", status: "failed")
            return
        }
        let authenticated = gateway != nil ? true : await Task.detached { probeCodex(executable, arguments: ["login", "status"])?.status == 0 }.value
        guard authenticated else {
            await send(taskId: taskId, kind: "error", text: "已找到 Codex，但无法确认登录状态。请先在 Codex 完成登录，再重新执行；ONE 不会读取或上传你的登录凭证。", status: "failed")
            return
        }

        var projectPath = synchronized { projectPaths[taskId] }
        let configuredPath = oneDefaults().string(forKey: "one.execution.project.\(deviceId)")
        if let projectPath, let configuredPath, projectPath != configuredPath {
            await send(taskId: taskId, kind: "error", text: "授权目录已更换。请从这件事重新发起执行，不会复用旧目录或旧会话。", status: "failed")
            return
        }
        if projectPath == nil {
            await send(taskId: taskId, kind: "status", text: configuredPath == nil ? "请在电脑上选择工作文件夹" : "正在确认已选择的工作目录：\(configuredPath!)", status: "selecting_target")
            projectPath = await executionProject(deviceId: deviceId)
        }
        guard let projectPath else {
            await send(taskId: taskId, kind: "error", text: "没有选择执行文件夹", status: "cancelled")
            return
        }
        if synchronized({ cancelled.contains(taskId) }) { return }
        let threadId = synchronized { projectPaths[taskId] = projectPath; return threadIds[taskId] }

        let process = Process()
        let stdout = Pipe(), stderr = Pipe(), stdin = Pipe()
        process.executableURL = URL(fileURLWithPath: executable)
        process.environment = executionEnvironment()
        var arguments = ["exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check", "-C", projectPath]
        if let gateway {
            do {
                let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                let identity = SHA256.hash(data: Data("\(deviceId):\(taskId)".utf8)).map { String(format: "%02x", $0) }.joined()
                let home = support.appendingPathComponent("ONE/codex/\(identity)")
                try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                let overrides = try gateway.launchOverrides(home: home, environment: executionEnvironment())
                process.environment = overrides.environment
                arguments = overrides.arguments + arguments
            } catch {
                await send(taskId: taskId, kind: "error", text: "无法准备 ONE 执行环境；本机尚未开始操作，不会使用个人 Codex 账号", status: "failed")
                return
            }
        }
        if resume, let threadId { arguments += ["resume", threadId, "-"] } else { arguments.append("-") }
        process.arguments = arguments
        process.standardOutput = stdout
        process.standardError = stderr
        process.standardInput = stdin
        let processExit = CodexProcessExit(process: process)

        do {
            synchronized { lastResponses.removeValue(forKey: taskId); toolFailures.remove(taskId) }
            try process.run()
            synchronized { processes[taskId] = process }
            // Read both pipes through EOF. Process exit alone is not an output
            // barrier; each event is awaited before publishing the terminal.
            try? stdout.fileHandleForWriting.close()
            try? stderr.fileHandleForWriting.close()
            let outputReader = Task.detached { [self] in
                var pending = Data()
                while true {
                    let chunk = stdout.fileHandleForReading.availableData
                    if chunk.isEmpty { break }
                    pending.append(chunk)
                    while let newline = pending.firstIndex(of: 10) {
                        let line = String(decoding: pending[..<newline], as: UTF8.self)
                        pending.removeSubrange(...newline)
                        await consume(taskId: taskId, line: line, targetName: projectPath)
                    }
                }
                if !pending.isEmpty { await consume(taskId: taskId, line: String(decoding: pending, as: UTF8.self), targetName: projectPath) }
            }
            let errorReader = Task.detached { [self] in
                while true {
                    let data = stderr.fileHandleForReading.availableData
                    if data.isEmpty { break }
                    synchronized {
                        let combined = (errorBuffers[taskId] ?? "") + String(decoding: data, as: UTF8.self)
                        errorBuffers[taskId] = String(combined.suffix(4000))
                    }
                }
            }
            await send(taskId: taskId, kind: "status", text: "\(resume ? "继续执行" : "开始执行") · 工作位置：\(projectPath)", targetName: projectPath, status: "running")
            stdin.fileHandleForWriting.write(Data(instruction.utf8)); try? stdin.fileHandleForWriting.close()
            let exitCode = await processExit.value()
            await outputReader.value
            await errorReader.value
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
                if let finalResponse, !finalResponse.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    let failed = synchronized { toolFailures.remove(taskId) != nil }
                    await send(taskId: taskId, kind: failed ? "error" : "status", text: failed ? "\(finalResponse)\n\n本轮有工具执行失败，完成情况需检查，不会自动重跑。" : finalResponse, status: failed ? "failed" : "completed")
                } else {
                    await send(taskId: taskId, kind: "error", text: "执行器已退出，但没有返回本轮结果，任务是否完成尚未确认。请检查文件，不会自动重跑。", status: "failed")
                }
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

    private func consume(taskId: String, line: String, targetName: String) async {
        guard let data = line.data(using: .utf8), let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let type = payload["type"] as? String else { return }
        if type == "thread.started", let id = payload["thread_id"] as? String {
            synchronized { threadIds[taskId] = id }
            await send(taskId: taskId, kind: "status", text: "Codex 会话已建立", providerThreadId: id, targetName: targetName, status: "running")
            return
        }
        if type == "turn.failed" || type == "error" {
            synchronized { toolFailures.insert(taskId) }
            let detail = (payload["error"] as? [String: Any])?["message"] as? String ?? payload["message"] as? String ?? "执行器返回错误"
            await send(taskId: taskId, kind: "error", text: String(detail.prefix(4000)))
            return
        }
        guard let item = payload["item"] as? [String: Any], let itemType = item["type"] as? String else { return }
        if type == "item.completed", itemType == "agent_message", let text = item["text"] as? String, !text.isEmpty {
            synchronized { lastResponses[taskId] = text }
            await send(taskId: taskId, kind: "message", text: text)
        } else if type == "item.started", itemType == "command_execution", let command = item["command"] as? String {
            await send(taskId: taskId, kind: "command", text: "正在运行：\(String(command.prefix(600)))")
        } else if type == "item.completed", itemType == "command_execution" {
            let failed = (item["exit_code"] as? Int).map { $0 != 0 } ?? (item["status"] as? String == "failed")
            if failed { synchronized { toolFailures.insert(taskId) } }
            let output = item["aggregated_output"] as? String ?? "未返回文字输出"
            await send(taskId: taskId, kind: failed ? "error" : "command", text: "工具返回\(failed ? " · 失败" : "")：\n\(String(output.prefix(6000)))")
        } else if type == "item.completed", itemType == "file_change" {
            let paths = (item["changes"] as? [[String: Any]])?.compactMap { $0["path"] as? String }.joined(separator: "\n") ?? ""
            if item["status"] as? String == "failed" { synchronized { toolFailures.insert(taskId) } }
            await send(taskId: taskId, kind: "file_change", text: "执行器报告文件变更：\n\(String(paths.prefix(4000)))")
        }
    }

    private func send(taskId: String, kind: String, text: String? = nil, providerThreadId: String? = nil, targetName: String? = nil, status: String? = nil, round: Int? = nil) async {
        let event = ExecutionEventResponse(taskId: taskId, kind: kind, text: text, providerThreadId: providerThreadId, targetName: targetName, status: status, round: round ?? synchronized { rounds[taskId] ?? 0 })
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

@MainActor
final class MacLocalExecutor {
    private var roots = [String: String]()
    private var cancelled = Set<String>()
    private let deviceId: String
    private let credentialUrl: URL
    init(deviceId: String, credentialUrl: URL) { self.deviceId = deviceId; self.credentialUrl = credentialUrl }
    func cancel(_ taskId: String) { cancelled.insert(taskId) }
    func prepare(_ taskId: String) throws -> String {
        cancelled.remove(taskId)
        guard let path = executionProject(deviceId: deviceId) else { throw LauncherError.message("已取消目录授权，尚未操作文件") }
        roots[taskId] = URL(fileURLWithPath: path).resolvingSymlinksInPath().path
        return roots[taskId]!
    }
    func execute(_ taskId: String, tool: String, args: LocalFileArguments) throws -> String {
        try args.validate(tool: tool)
        guard try loadCredential(credentialUrl).deviceId == deviceId else { throw LauncherError.message("ONE Key 已断开，未操作") }
        guard !cancelled.contains(taskId), let root = roots[taskId], root == oneDefaults().string(forKey: "one.execution.project.\(deviceId)") else { throw LauncherError.message("执行已停止或授权目录已变化，未操作") }
        let files = try MacLocalFiles(root: root), path = args.path ?? "."
        if tool == "write_file" || tool == "replace_in_file" {
            NSApplication.shared.activate(ignoringOtherApps: true)
            let alert = NSAlert(); alert.messageText = tool == "write_file" ? "ONE 请求创建文件" : "ONE 请求修改文件"
            alert.informativeText = "工作目录：\(root)\n相对路径：\(path)\n\n\(String((args.content ?? args.newText ?? "").prefix(1200)))"
            alert.addButton(withTitle: "允许"); alert.addButton(withTitle: "不允许")
            if alert.runModal() != .alertFirstButtonReturn { throw LauncherError.message("用户拒绝文件操作，未修改") }
            if cancelled.contains(taskId) { throw LauncherError.message("执行已停止，未修改") }
            guard try loadCredential(credentialUrl).deviceId == deviceId else { throw LauncherError.message("ONE Key 已断开，未修改") }
            guard root == oneDefaults().string(forKey: "one.execution.project.\(deviceId)") else { throw LauncherError.message("授权目录已变化，未修改") }
        }
        switch tool {
        case "list_files": return try files.list(path, depth: min(4, max(1, args.maxDepth ?? 2))).joined(separator: "\n")
        case "read_file":
            let lines = try files.read(path).components(separatedBy: "\n"), start = max(1, args.startLine ?? 1), end = min(lines.count, args.endLine ?? 500)
            if start > end { return "没有对应行" }
            return lines[(start-1)..<end].enumerated().map { "\($0.offset+start): \($0.element)" }.joined(separator: "\n")
        case "search_text":
            guard let query = args.query, !query.isEmpty else { throw LauncherError.message("搜索内容不能为空") }
            var found = [String](), candidates = (try? files.list(path, depth: 4)) ?? []
            if candidates.isEmpty && (try? files.read(path)) != nil { candidates = [path] }
            for candidate in candidates where !candidate.hasSuffix("/") {
                guard let text = try? files.read(candidate) else { continue }
                for (index,line) in text.components(separatedBy: "\n").enumerated() {
                    if line.range(of: query, options: args.caseSensitive == true ? [] : .caseInsensitive) != nil { found.append("\(candidate):\(index+1): \(String(line.prefix(600)))") }
                    if found.count >= min(200, max(1, args.maxResults ?? 80)) { return found.joined(separator: "\n") }
                }
            }
            return found.isEmpty ? "没有匹配" : found.joined(separator: "\n")
        case "write_file": guard let content = args.content else { throw LauncherError.message("缺少文件内容") }; return try files.create(path, content: content)
        case "replace_in_file": guard let old = args.oldText, let new = args.newText else { throw LauncherError.message("缺少替换内容") }; return try files.replace(path, old: old, new: new)
        default: throw LauncherError.message("Mac 原生文件工具不支持此操作；未运行命令或扩大权限")
        }
    }
}

func serveProofs(_ task: URLSessionWebSocketTask, credentialUrl: URL, deviceId: String) async throws -> URL? {
    let execution = CodexExecutionRunner(socket: task, deviceId: deviceId, credentialUrl: credentialUrl)
    let localExecutor = await MacLocalExecutor(deviceId: deviceId, credentialUrl: credentialUrl)
    var installJob: Task<URL, Error>?
    do {
    while true {
        let text: String
        if let installJob {
            switch try await runtimeMessageOrInstallation(installation: installJob, receive: { try await receiveText(task) }) {
            case .installed(let target):
                runtimeInstallActivity.end()
                task.cancel(with: .goingAway, reason: nil)
                return target
            case .message(let received): text = received
            }
        } else { text = try await receiveText(task) }
        let message = try JSONDecoder().decode(SocketMessage.self, from: Data(text.utf8))
        if message.type == "request_challenge", let challengeId = message.challengeId, let nonce = message.nonce {
            let signature = try signNonce(nonce, credentialUrl: credentialUrl, deviceId: deviceId)
            let response = SocketResponse(type: "proof_response", challengeId: challengeId, signature: signature)
            try await task.send(.string(String(decoding: try JSONEncoder().encode(response), as: UTF8.self)))
        } else if message.type == "runtime_recovery_ack", let requestId = message.requestId {
            try? acknowledgeMacRecovery(credential: credentialUrl, journal: macRecoveryJournal(deviceId: deviceId), requestId: requestId)
        } else if message.type == "local_configuration", let requestId = message.requestId {
            Task { @MainActor in
                let selected = message.change == true ? executionProject(deviceId: deviceId, change: true) : oneDefaults().string(forKey: "one.execution.project.\(deviceId)")
                let response = LocalConfigurationResponse(type: message.change == true && selected == nil ? "local_error" : "local_ready", taskId: "device_settings", requestId: requestId, targetName: selected, output: selected ?? "", error: message.change == true && selected == nil ? "已取消选择，原授权目录保持不变" : nil)
                if let data = try? JSONEncoder().encode(response) { try? await task.send(.string(String(decoding: data, as: UTF8.self))) }
            }
        } else if ["executor_status", "executor_prepare"].contains(message.type), let requestId = message.requestId {
            Task {
                do {
                    func reportPhase(_ phase: String) async {
                        let response = LocalConfigurationResponse(type: "executor_progress", taskId: "device_settings", requestId: requestId, targetName: nil, output: phase, error: nil)
                        if let data = try? JSONEncoder().encode(response) { try? await task.send(.string(String(decoding:data,as:UTF8.self))) }
                    }
                    if message.type == "executor_prepare" {
                        guard !runtimeInstallActivity.active, managedCodexActivity.begin() else { throw ManagedCodexError.busy }
                        defer { managedCodexActivity.end() }
                        guard let signed = message.envelope else { throw ManagedCodexError.invalid }
                        let envelope = ManagedCodexEnvelope(payload: signed.payload, signature: signed.signature)
                        let credential = try JSONDecoder().decode(DeviceCredential.self, from: Data(contentsOf: credentialUrl))
                        guard let origin = URL(string: credential.serverBaseUrl) else { throw ManagedCodexError.invalid }
                        let release = try managedCodexRelease(envelope, publicKey: executorPublicKeyRaw, origin: origin, architecture: runtimeArchitecture())
                        let selected = await oneGatewayCodex(credentialUrl: credentialUrl)
                        if selected == nil || (selected!.source == "managed" && selected!.version.compare(release.version, options: .numeric) == .orderedAscending) {
                            await reportPhase("confirming")
                            guard await confirmManagedCodex(release) else { throw LauncherError.message("已取消准备，没有安装或启动任务") }
                            await reportPhase("downloading")
                            let bytes = try await ManagedCodexDownload(expected: release.size).fetch(URL(string: release.url)!)
                            await reportPhase("verifying")
                            // Require the same credential still present before committing. Unplug
                            // aborts preparation, but never corrupts the previous pointer.
                            _ = try signNonce(Data("one-executor-commit".utf8).base64EncodedString(), credentialUrl: credentialUrl, deviceId: deviceId)
                            let root = try managedCodexRoot()
                            _ = try await Task.detached {
                                try commitManagedCodex(bytes: bytes, envelope: envelope, release: release, root: root) { path, version in
                                    guard let probe = probeCodex(path, arguments: ["--version"]), probe.status == 0 else { return false }
                                    return probe.output.trimmingCharacters(in: .whitespacesAndNewlines) == "codex-cli \(version)"
                                }
                            }.value
                        }
                    }
                    let selected = await oneGatewayCodex(credentialUrl: credentialUrl)
                    let response = LocalConfigurationResponse(type: "local_ready", taskId: "device_settings", requestId: requestId, targetName: selected?.source, output: selected?.version ?? "", error: nil)
                    try await task.send(.string(String(decoding: JSONEncoder().encode(response), as: UTF8.self)))
                } catch {
                    let response = LocalConfigurationResponse(type: "local_error", taskId: "device_settings", requestId: requestId, targetName: nil, output: "", error: "工具准备未完成：\(error.localizedDescription)。未自动执行任务，可重新检查。")
                    if let data = try? JSONEncoder().encode(response) { try? await task.send(.string(String(decoding: data, as: UTF8.self))) }
                }
            }
        } else if message.type == "execution_start", let taskId = message.taskId, let instruction = message.instruction {
            execution.start(taskId: taskId, instruction: instruction, resume: false, round: message.round ?? 0, gateway: message.gateway)
        } else if message.type == "execution_continue", let taskId = message.taskId, let instruction = message.instruction {
            execution.start(taskId: taskId, instruction: instruction, resume: true, round: message.round ?? 0, gateway: message.gateway)
        } else if message.type == "execution_cancel", let taskId = message.taskId {
            execution.cancel(taskId: taskId)
            await localExecutor.cancel(taskId)
        } else if message.type == "local_prepare", let taskId = message.taskId, let requestId = message.requestId {
            Task { @MainActor in
                do {
                    let root = try localExecutor.prepare(taskId)
                    let response = LocalConfigurationResponse(type: "local_ready", taskId: taskId, requestId: requestId, targetName: root, output: "files_only", error: nil)
                    try await task.send(.string(String(decoding: JSONEncoder().encode(response), as: UTF8.self)))
                } catch {
                    let response = LocalConfigurationResponse(type: "local_error", taskId: taskId, requestId: requestId, targetName: nil, output: "", error: error.localizedDescription)
                    if let data = try? JSONEncoder().encode(response) { try? await task.send(.string(String(decoding: data, as: UTF8.self))) }
                }
            }
        } else if message.type == "tool_request", let taskId = message.taskId, let requestId = message.requestId, let tool = message.tool, let arguments = message.arguments {
            Task { @MainActor in
                do {
                    let output = try localExecutor.execute(taskId, tool: tool, args: arguments)
                    let response = LocalConfigurationResponse(type: "tool_result", taskId: taskId, requestId: requestId, targetName: nil, output: String(output.prefix(120000)), error: nil)
                    try await task.send(.string(String(decoding: JSONEncoder().encode(response), as: UTF8.self)))
                } catch {
                    let response = LocalConfigurationResponse(type: "local_error", taskId: taskId, requestId: requestId, targetName: nil, output: "", error: error.localizedDescription)
                    if let data = try? JSONEncoder().encode(response) { try? await task.send(.string(String(decoding: data, as: UTF8.self))) }
                }
            }
        } else if message.type == "update_install", let requestId = message.requestId, let envelope = message.envelope {
            if managedCodexActivity.isActive() {
                let response = UpdateEventResponse(requestId: requestId, status: "failed", error: "正在准备执行工具，请完成后再更新 ONE")
                try? await task.send(.string(String(decoding:try JSONEncoder().encode(response),as:UTF8.self)))
                continue
            }
            guard installJob == nil, runtimeInstallActivity.begin() else { continue }
            installJob = Task.detached {
              // Always wake the socket reader; it joins the result even after
              // disconnection, so file commit cannot be abandoned by a restart.
              defer { task.cancel(with: .goingAway, reason: nil) }
              do {
                let artifact = try verifyRuntimeUpdate(envelope)
                await reportRuntimeProgress(task, requestId: requestId, status: "downloading")
                return try await committedRuntimeInstallation(install: {
                    try await installRuntimeUpdate(artifact, credentialUrl: credentialUrl, requestId: requestId) { status in
                        await reportRuntimeProgress(task, requestId: requestId, status: status)
                    }
                }, reportCompletion: {
                    await reportRuntimeProgress(task, requestId: requestId, status: "completed")
                })
            } catch {
                await reportRuntimeProgress(task, requestId: requestId, status: "failed", error: error.localizedDescription)
                throw error
              }
            }
        }
    }
    } catch {
        if let installJob {
            defer { runtimeInstallActivity.end() }
            return try await installJob.value
        }
        throw error
    }
}

func reportRuntimeProgress(_ socket: URLSessionWebSocketTask, requestId: String, status: String, error: String? = nil) async {
    if let data = try? JSONEncoder().encode(UpdateEventResponse(requestId: requestId, status: status, error: error)) {
        // Cancellation alone is not a deadline: some URLSession callbacks never
        // arrive after the connection disappears during removable-media work.
        let _: Void? = try? await boundedRuntimeOperation(timeout: .seconds(2)) {
            try await socket.send(.string(String(decoding: data, as: UTF8.self)))
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
    private var handingOff = false
    private var ready = false
    private var openedLogin = CommandLine.arguments.contains("--one-update-resume")
    private var loginRequested = false
    private var residentLock: ResidentLock?
    private var machineLease: MachineResidentLease?
    private let networkMonitor = NWPathMonitor()
    private var receivedInitialPath = false
    private var reopenAcknowledged = false
    private var reopenDeviceId: String?

    private func reopenNotification(_ deviceId: String) -> Notification.Name {
        let digest = SHA256.hash(data: Data(deviceId.utf8)).map { String(format: "%02x", $0) }.joined()
        return Notification.Name("one.key.reopen.\(digest)")
    }

    @objc private func reopenRequested(_ notification: Notification) {
        guard let requestId = notification.object as? String, UUID(uuidString: requestId) != nil else { return }
        guard notification.userInfo?["version"] as? String == launcherVersion else { return }
        requestLogin()
        // A new double-click must wake the resident that actually owns this
        // Key, not merely create a login URL while that resident is offline.
        if !ready { nextVolumeScan = .distantPast; restartSession() }
        Task { @MainActor in
            // Allow wake/reconnect, but never acknowledge merely being alive.
            for _ in 0..<30 {
                if stopping { return }
                if ready {
                    DistributedNotificationCenter.default().postNotificationName(Notification.Name("one.key.reopen.ack.\(requestId)"), object: launcherVersion, userInfo: ["ready": true, "pid": Int(getpid())], deliverImmediately: true)
                    return
                }
                try? await Task.sleep(for: .milliseconds(100))
            }
        }
    }

    @objc private func reopenReply(_ notification: Notification) {
        guard let deviceId = reopenDeviceId,
              let support = try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: false).appendingPathComponent("ONE", isDirectory: true) else { return }
        let digest = SHA256.hash(data: Data(deviceId.utf8)).map { String(format: "%02x", $0) }.joined()
        reopenAcknowledged = isHealthyResidentReply(version: notification.object as? String, expectedVersion: launcherVersion, ready: notification.userInfo?["ready"] as? Bool == true, pid: (notification.userInfo?["pid"] as? NSNumber)?.int32Value, lockOwners: residentLockOwners(support.appendingPathComponent(residentLockFilename(digest: digest))))
    }

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
                // No portable fallback competing for removable-volume access.
                showFailure(error)
                return
            }
        }
        if residentMode {
            do {
                let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("ONE", isDirectory: true)
                guard let lease = try acquireMachineLease(directory: support, name: "machine-presence-v1.lock") else {
                    throw LauncherError.message("这台电脑已有 ONE 在运行。请从要使用的 Key 双击 ONE，完成切换。")
                }
                machineLease = lease
                let resolvedDeviceId: String
                if let expectedDeviceId {
                    resolvedDeviceId = expectedDeviceId
                } else {
                    guard let foundUrl = findCredentialUrl(preferred: initialCredentialUrl) else { throw LauncherError.message(credentialAccessBlocked ? credentialAccessMessage : "没有找到 ONE Key，请插入后重试") }
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
                DistributedNotificationCenter.default().addObserver(self, selector: #selector(reopenRequested(_:)), name: reopenNotification(resolvedDeviceId), object: nil)
            } catch {
                showFailure(error)
                return
            }
        }
        startResidentMonitoring()
    }

    private func startResidentMonitoring() {
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(resumeConnection), name: NSWorkspace.didWakeNotification, object: nil)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(volumeDidMount(_:)), name: NSWorkspace.didMountNotification, object: nil)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(volumeDidUnmount(_:)), name: NSWorkspace.didUnmountNotification, object: nil)
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
        nextVolumeScan = .distantPast
        restartSession()
    }

    @objc private func volumeDidMount(_ notification: Notification) {
        nextVolumeScan = .distantPast
        guard let volume = notification.userInfo?[NSWorkspace.volumeURLUserInfoKey] as? URL else { return }
        let boundVolume = (credentialUrl ?? initialCredentialUrl)?.deletingLastPathComponent().deletingLastPathComponent()
        guard boundVolume?.standardizedFileURL == volume.standardizedFileURL else { return }
        let candidate = volume.appendingPathComponent(".one/credential.json")
        let wantedDeviceId = credential?.deviceId ?? expectedDeviceId
        guard let mountedCredential = try? loadCredential(candidate), wantedDeviceId == nil || mountedCredential.deviceId == wantedDeviceId else { return }
        credentialUrl = candidate
        credential = mountedCredential
        restartSession()
    }

    @objc private func volumeDidUnmount(_ notification: Notification) {
        guard let volume = notification.userInfo?[NSWorkspace.volumeURLUserInfoKey] as? URL,
              let credentialUrl,
              credentialUrl.path.hasPrefix(volume.path + "/") else { return }
        // Drop the stale mount path immediately. The resident loop will wait
        // for the same device to reappear and then rescan all mounted volumes.
        socket?.cancel(with: .goingAway, reason: nil)
        self.credentialUrl = nil
        self.credential = nil
        self.ready = false
        restartSession()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        requestLogin()
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopping = true
        NSWorkspace.shared.notificationCenter.removeObserver(self)
        DistributedNotificationCenter.default().removeObserver(self)
        networkMonitor.cancel()
        loginTask?.cancel()
        removalTask?.cancel()
        sessionTask?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
    }

    private func restartSession() {
        guard residentMode, !stopping, !handingOff, !runtimeInstallActivity.active else { return }
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
            let portable = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent(".one/credential.json")
            let candidates = keyCredentialCandidates(current: credentialUrl, original: initialCredentialUrl, portable: portable)
            let direct = candidates.first { (try? loadCredential($0, expectedDeviceId: wantedDeviceId)) != nil }
            guard let foundUrl = direct ?? findCredentialUrl(expectedDeviceId: wantedDeviceId, preferred: credentialUrl ?? initialCredentialUrl) else {
                if credentialAccessBlocked { throw LauncherError.message(credentialAccessMessage) }
                if residentMode {
                    ready = false
                    socket = nil
                    do { try await Task.sleep(for: .seconds(1)) } catch { return }
                    continue
                }
                throw LauncherError.message("没有找到 ONE Key，请插入后重试")
            }
            let foundCredential = try loadCredential(foundUrl)
            let recovery = try recoverMacRuntimeOnMount(credential: foundUrl, deviceId: foundCredential.deviceId)
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
            // Pre-v2 residents may be offline and polling removable volumes
            // forever. Only retire the exact same Key after our server proof.
            let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("ONE", isDirectory: true)
            let digest = SHA256.hash(data: Data(foundCredential.deviceId.utf8)).map { String(format: "%02x", $0) }.joined()
            _ = terminateOlderResident(lock: support.appendingPathComponent("presence-\(digest).lock"), support: support, newVersion: launcherVersion) { candidate in
                (try? loadCredential(candidate, expectedDeviceId: foundCredential.deviceId)) != nil
            }
            if let recovery, !recovery.record.requestId.isEmpty {
                let report = ["type":"runtime_recovery_event", "requestId":recovery.record.requestId, "version":recovery.record.version, "status":recovery.status]
                try await connectedSocket.send(.string(String(decoding: try JSONSerialization.data(withJSONObject: report), as: UTF8.self)))
            }
            removalTask = Task { await monitorRemoval(of: foundUrl) }

            if !openedLogin || loginRequested {
                loginRequested = false
                try await openLoginPage(base: foundBase, credentialUrl: foundUrl, deviceId: foundCredential.deviceId)
                openedLogin = true
            }
            failures = 0
            if try await serveProofs(connectedSocket, credentialUrl: foundUrl, deviceId: foundCredential.deviceId) != nil {
                handingOff = true
                // Release the per-Key lock before starting the new portable
                // app so its updated resident can take over immediately.
                socket?.cancel(with: .goingAway, reason: nil)
                ready = false
                removalTask?.cancel()
                loginTask?.cancel()
                residentLock = nil
                machineLease = nil
                // Deliberately end here. A fresh explicit launch of the updated
                // USB app owns the new permission identity, never a child of the
                // old updating identity. Recovery journal remains until proof.
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
            if credentialAccessBlocked {
                socket?.cancel(with: .goingAway, reason: nil)
                removalTask?.cancel()
                ready = false
                stopping = true
                residentLock = nil
                showFailure(LauncherError.message(credentialAccessMessage))
                return
            }
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
            let requestId = UUID().uuidString
            let reply = Notification.Name("one.key.reopen.ack.\(requestId)")
            reopenAcknowledged = false
            reopenDeviceId = deviceId
            DistributedNotificationCenter.default().addObserver(self, selector: #selector(reopenReply(_:)), name: reply, object: nil)
            defer { DistributedNotificationCenter.default().removeObserver(self, name: reply, object: nil); reopenDeviceId = nil }
            DistributedNotificationCenter.default().postNotificationName(reopenNotification(deviceId), object: requestId, userInfo: ["version": launcherVersion], deliverImmediately: true)
            for _ in 0..<35 {
                try await Task.sleep(for: .milliseconds(100))
                if reopenAcknowledged {
                    stopping = true
                    NSApplication.shared.terminate(nil)
                    return
                }
            }
            // A newer installed binary can be blocked by an older resident's
            // local lock. Authenticate first: the server rejects equal-version
            // duplicates but asks an older owner to exit with close code 4009.
            if let credentialUrl = findCredentialUrl(expectedDeviceId: deviceId, preferred: preferred),
               let credential = try? loadCredential(credentialUrl, expectedDeviceId: deviceId),
               let replacement = try? await connectLauncher(base: credential.serverBaseUrl, credentialUrl: credentialUrl, deviceId: deviceId) {
                defer { replacement.cancel(with: .goingAway, reason: nil) }
                for _ in 0..<30 {
                    if let lock = try acquireResidentLock(deviceId: deviceId) {
                        residentLock = lock
                        self.credentialUrl = credentialUrl
                        self.credential = credential
                        self.expectedDeviceId = deviceId
                        DistributedNotificationCenter.default().addObserver(self, selector: #selector(reopenRequested(_:)), name: reopenNotification(deviceId), object: nil)
                        startResidentMonitoring()
                        return
                    }
                    try await Task.sleep(for: .milliseconds(100))
                }
                let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("ONE", isDirectory: true)
                let digest = SHA256.hash(data: Data(deviceId.utf8)).map { String(format: "%02x", $0) }.joined()
                // Server authentication succeeded: an equal-version active
                // connection would have rejected this duplicate. Recover an
                // offline same-version owner as well as older owners.
                _ = terminateOlderResident(lock: support.appendingPathComponent(residentLockFilename(digest: digest)), support: support, newVersion: launcherVersion, allowEqualAfterAuthentication: true) { candidate in
                    (try? loadCredential(candidate, expectedDeviceId: deviceId)) != nil
                }
                for _ in 0..<50 {
                    if let lock = try acquireResidentLock(deviceId: deviceId) {
                        residentLock = lock
                        self.credentialUrl = credentialUrl
                        self.credential = credential
                        self.expectedDeviceId = deviceId
                        DistributedNotificationCenter.default().addObserver(self, selector: #selector(reopenRequested(_:)), name: reopenNotification(deviceId), object: nil)
                        startResidentMonitoring()
                        return
                    }
                    try await Task.sleep(for: .milliseconds(100))
                }
                throw LauncherError.message("新版已安装，但连接尚未恢复。请保持 Key 插入，再打开盘中的 ONE；不需要重复安装。")
            }
            // Compatibility with already-running older launchers. New
            // residents handle login themselves after authenticating.
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
