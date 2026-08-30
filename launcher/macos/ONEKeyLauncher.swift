import AppKit
import CryptoKit
import Foundation

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
struct SocketMessage: Decodable { let type: String; let challengeId: String?; let nonce: String?; let deviceId: String? }
struct SocketResponse: Encodable { let type: String; let challengeId: String; let signature: String }

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

func serveProofs(_ task: URLSessionWebSocketTask, credentialUrl: URL, deviceId: String) async throws {
    while true {
        let message = try JSONDecoder().decode(SocketMessage.self, from: Data(try await receiveText(task).utf8))
        guard message.type == "request_challenge", let challengeId = message.challengeId, let nonce = message.nonce else { continue }
        let signature = try signNonce(nonce, credentialUrl: credentialUrl, deviceId: deviceId)
        let response = SocketResponse(type: "proof_response", challengeId: challengeId, signature: signature)
        try await task.send(.string(String(decoding: try JSONEncoder().encode(response), as: UTF8.self)))
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

@main
struct ONEKeyLauncher {
    static func main() async {
        NSApplication.shared.setActivationPolicy(.accessory)
        do {
            let volumeRoot = Bundle.main.bundleURL.deletingLastPathComponent()
            let credentialUrl = volumeRoot.appendingPathComponent(".one/credential.json")
            let credential = try loadCredential(credentialUrl)
            let base = credential.serverBaseUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            let socket = try await connectLauncher(base: base, credentialUrl: credentialUrl, deviceId: credential.deviceId)
            guard let challengeUrl = URL(string: "\(base)/api/one-key/challenge") else { throw LauncherError.message("ONE 服务地址无效") }
            let challenge: ChallengeResponse = try await post(challengeUrl, body: ChallengeRequest(deviceId: credential.deviceId))
            guard let verifyUrl = URL(string: "\(base)/api/one-key/challenge/\(challenge.challengeId)/verify") else { throw LauncherError.message("ONE 验证地址无效") }
            let verified: VerifyResponse = try await post(verifyUrl, body: VerifyRequest(signature: try signNonce(challenge.nonce, credentialUrl: credentialUrl, deviceId: credential.deviceId)))
            guard let loginUrl = URL(string: "\(base)/#one-key=\(verified.loginCode)") else { throw LauncherError.message("ONE 登录地址无效") }
            NSWorkspace.shared.open(loginUrl)
            try await serveProofs(socket, credentialUrl: credentialUrl, deviceId: credential.deviceId)
        } catch {
            await MainActor.run {
                NSApplication.shared.activate(ignoringOtherApps: true)
                let alert = NSAlert(); alert.messageText = "无法打开 ONE"; alert.informativeText = error.localizedDescription; alert.alertStyle = .warning; alert.addButton(withTitle: "知道了"); alert.runModal()
            }
        }
    }
}
