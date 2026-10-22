import Foundation
import Darwin

// Test-only driver for the production outbox. No Key, model or user file is
// used. The parent supplies a fresh isolated directory and a loopback socket.
@main struct TerminalReceiptTransportFixture {
    static let identity = ExecutionReceiptIdentity(workspaceId: "ws_transport", userId: "usr_transport",
        deviceId: "dev_transport", installationId: String(repeating: "a", count: 32),
        attemptId: "attempt_transport", taskId: "task_transport", round: 0)
    struct WireAck: Decodable {
        let type: String; let accepted: Bool; let receiptId: String; let receiptHash: String
        let workspaceId: String; let userId: String; let deviceId: String; let installationId: String
        let attemptId: String; let taskId: String; let round: Int; let disposition: String
        var native: ExecutionTerminalAcknowledgement {
            ExecutionTerminalAcknowledgement(accepted: accepted, receiptId: receiptId, receiptHash: receiptHash,
                identity: ExecutionReceiptIdentity(workspaceId: workspaceId, userId: userId,
                    deviceId: deviceId, installationId: installationId, attemptId: attemptId,
                    taskId: taskId, round: round), disposition: disposition)
        }
    }
    static func emit(_ object: [String: Any]) throws {
        print(String(decoding: try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), as: UTF8.self))
    }
    static func main() async throws {
        let args = CommandLine.arguments
        guard args.count >= 3 else { throw TerminalOutboxFailure.invalidIdentity }
        let root = URL(fileURLWithPath: args[1], isDirectory: true).standardizedFileURL
        guard root.pathComponents.contains(where: { $0.hasPrefix("one-receipt-transport-") }) else {
            throw TerminalOutboxFailure.unsafeStorage
        }
        let outbox = try TerminalReceiptOutbox(root: root.appendingPathComponent("outbox"),
            workspaceId: identity.workspaceId, userId: identity.userId, deviceId: identity.deviceId,
            installationId: identity.installationId)
        if args[2] == "produce" {
            let reserved = try outbox.reserve(identity)
            if reserved {
                let log = root.appendingPathComponent("operation-count.txt")
                let fd = open(log.path, O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW, 0o600)
                guard fd >= 0 else { throw TerminalOutboxFailure.persistence }
                let written = "executed\n".withCString { Darwin.write(fd, $0, 9) }
                close(fd)
                guard written == 9 else { throw TerminalOutboxFailure.persistence }
                let artifact = root.appendingPathComponent("result.txt")
                try Data("ONE_TRANSPORT_OK 中文🙂\n".utf8).write(to: artifact, options: .withoutOverwriting)
                let actual = try String(contentsOf: artifact, encoding: .utf8)
                let receipt = ExecutionTerminalReceipt(identity: identity, outcome: "completed",
                    finalResponse: "已创建并回读：\(actual)", targetName: artifact.path,
                    providerThreadId: "thread_transport", occurredAt: "2026-10-22T10:00:00Z")
                _ = try outbox.persist(receipt)
            }
            try emit(["executed": reserved, "pending": try outbox.pending().count,
                "acknowledged": try outbox.isAcknowledged(identity)])
        } else if args[2] == "snapshot" {
            let data = try JSONEncoder().encode(outbox.pending())
            try emit(["receipts": try JSONSerialization.jsonObject(with: data),
                "acknowledged": try outbox.isAcknowledged(identity)])
        } else if args[2] == "send" {
            guard args.count == 4, let url = URL(string: args[3]), url.scheme == "ws",
                  url.host == "127.0.0.1", url.port != nil, url.path == "/receipt",
                  url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else {
                throw TerminalOutboxFailure.invalidIdentity
            }
            let session = URLSession(configuration: .ephemeral)
            let socket = session.webSocketTask(with: url)
            socket.resume()
            let timeout = Task {
                try await Task.sleep(for: .seconds(3))
                socket.cancel(with: .goingAway, reason: nil)
            }
            defer { timeout.cancel(); socket.cancel(with: .normalClosure, reason: nil); session.invalidateAndCancel() }
            var accepted = false
            do {
                guard let receipt = try outbox.pending().first else {
                    try emit(["accepted": false, "pending": 0]); return
                }
                let bytes = try JSONEncoder().encode(receipt)
                try await socket.send(.string(String(decoding: bytes, as: UTF8.self)))
                let message = try await socket.receive()
                let data: Data
                switch message {
                case .string(let text): data = Data(text.utf8)
                case .data(let value): data = value
                @unknown default: throw TerminalOutboxFailure.invalidReceipt
                }
                let ack = try JSONDecoder().decode(WireAck.self, from: data)
                guard ack.type == "execution_terminal_ack" else { throw TerminalOutboxFailure.invalidReceipt }
                accepted = try outbox.acknowledge(ack.native)
            } catch {
                // Expected transport loss / invalid ACK; never discard or rerun.
            }
            try emit(["accepted": accepted, "pending": try outbox.pending().count,
                "acknowledged": try outbox.isAcknowledged(identity)])
        } else { throw TerminalOutboxFailure.invalidIdentity }
    }
}
