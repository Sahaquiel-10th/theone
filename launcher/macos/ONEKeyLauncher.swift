import AppKit
import CryptoKit
import Foundation
import CFNetwork

struct DeviceCredential: Decodable {
    let version: Int
    let deviceId: String
    let privateKeyRaw: String
    let serverBaseUrl: String
}

struct ChallengeRequest: Encodable { let deviceId: String }
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
}
struct SocketResponse: Encodable { let type: String; let challengeId: String; let signature: String }
struct ExecutionEventResponse: Encodable {
    let type = "execution_event"
    let taskId: String
    let kind: String
    let text: String?
    let providerThreadId: String?
    let targetName: String?
    let status: String?
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

func findCredentialUrl(expectedDeviceId: String? = nil) -> URL? {
    let portable = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent(".one/credential.json")
    let volumes = FileManager.default.mountedVolumeURLs(includingResourceValuesForKeys: nil, options: [.skipHiddenVolumes]) ?? []
    return ([portable] + volumes.map { $0.appendingPathComponent(".one/credential.json") })
        .first { url in
            guard FileManager.default.fileExists(atPath: url.path), let credential = try? loadCredential(url) else { return false }
            return expectedDeviceId == nil || credential.deviceId == expectedDeviceId
        }
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
    components.queryItems = [URLQueryItem(name: "deviceId", value: deviceId)]
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
    let response = SocketResponse(type: "auth_response", challengeId: challengeId, signature: signature)
    try await task.send(.string(String(decoding: try JSONEncoder().encode(response), as: UTF8.self)))
    let ready = try JSONDecoder().decode(SocketMessage.self, from: Data(try await receiveText(task).utf8))
    guard ready.type == "ready", ready.deviceId == deviceId else { throw LauncherError.message("ONE Key 在线验证失败") }
    return task
}

@MainActor
func executionProject(deviceId: String) -> String? {
    let key = "one.execution.project.\(deviceId)"
    if let saved = UserDefaults.standard.string(forKey: key), FileManager.default.fileExists(atPath: saved) { return saved }
    NSApplication.shared.activate(ignoringOtherApps: true)
    let panel = NSOpenPanel()
    panel.title = "选择允许 ONE 执行任务的文件夹"
    panel.message = "Codex 只能在你选择的文件夹中读取和修改文件。以后可以重新选择。"
    panel.prompt = "允许并开始执行"
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    guard panel.runModal() == .OK, let path = panel.url?.path else { return nil }
    UserDefaults.standard.set(path, forKey: key)
    return path
}

func codexExecutable() -> String? {
    let candidates = [
        Bundle.main.resourceURL?.appendingPathComponent("codex").path,
        "/Applications/ChatGPT.app/Contents/Resources/codex",
        "/opt/homebrew/bin/codex",
        "/usr/local/bin/codex"
    ].compactMap { $0 }
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
    private let lock = NSLock()
    private var processes: [String: Process] = [:]
    private var threadIds: [String: String] = [:]
    private var projectPaths: [String: String] = [:]
    private var lastResponses: [String: String] = [:]
    private var cancelled = Set<String>()
    private var outputBuffers: [String: String] = [:]
    private var errorBuffers: [String: String] = [:]

    init(socket: URLSessionWebSocketTask, deviceId: String) { self.socket = socket; self.deviceId = deviceId }

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
        guard let executable = codexExecutable() else {
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

func serveProofs(_ task: URLSessionWebSocketTask, credentialUrl: URL, deviceId: String) async throws {
    let execution = CodexExecutionRunner(socket: task, deviceId: deviceId)
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
    let challenge: ChallengeResponse = try await post(challengeUrl, body: ChallengeRequest(deviceId: deviceId))
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
    private var credentialUrl: URL?
    private var credential: DeviceCredential?
    private var base = ""
    private var socket: URLSessionWebSocketTask?
    private var sessionTask: Task<Void, Never>?
    private var removalTask: Task<Void, Never>?
    private var loginTask: Task<Void, Never>?
    private var stopping = false
    private var ready = false
    private var loginRequested = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        sessionTask = Task { await runSession() }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        requestLogin()
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopping = true
        loginTask?.cancel()
        removalTask?.cancel()
        sessionTask?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
    }

    private func runSession() async {
        var openedLogin = false
        var failures = 0
        while !stopping {
        do {
            guard let foundUrl = findCredentialUrl(expectedDeviceId: credential?.deviceId) else { throw LauncherError.message("没有找到 ONE Key，请插入后重试") }
            let foundCredential = try loadCredential(foundUrl)
            let foundBase = foundCredential.serverBaseUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            credentialUrl = foundUrl
            credential = foundCredential
            base = foundBase
            let connectedSocket = try await connectLauncher(base: foundBase, credentialUrl: foundUrl, deviceId: foundCredential.deviceId)

            socket = connectedSocket
            ready = true
            removalTask = Task { await monitorRemoval(of: foundUrl) }

            if !openedLogin || loginRequested {
                loginRequested = false
                try await openLoginPage(base: foundBase, credentialUrl: foundUrl, deviceId: foundCredential.deviceId)
                openedLogin = true
            }
            failures = 0
            try await serveProofs(connectedSocket, credentialUrl: foundUrl, deviceId: foundCredential.deviceId)
            if !stopping { throw LauncherError.message("ONE Key 连接已断开，请重新双击 ONE 图标") }
        } catch is CancellationError {
            return
        } catch {
            failures += 1
            let terminalClose = [4003, 4009].contains(socket?.closeCode.rawValue ?? 0)
            if !stopping, !terminalClose, openedLogin, let credentialUrl, FileManager.default.fileExists(atPath: credentialUrl.path) {
                socket?.cancel(with: .goingAway, reason: nil)
                removalTask?.cancel()
                ready = false
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

    private func monitorRemoval(of credentialUrl: URL) async {
        while !Task.isCancelled {
            do { try await Task.sleep(for: .milliseconds(500)) } catch { return }
            if !FileManager.default.fileExists(atPath: credentialUrl.path) {
                stopping = true
                socket?.cancel(with: .goingAway, reason: nil)
                NSApplication.shared.terminate(nil)
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
        let application = NSApplication.shared
        let delegate = ONEKeyAppDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.accessory)
        application.run()
    }
}
