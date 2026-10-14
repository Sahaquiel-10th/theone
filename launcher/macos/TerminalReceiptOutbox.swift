import Foundation
import CryptoKit
import Darwin

// This journal is private to one computer installation and one Key. It never
// contains the task instruction, gateway token, or portable Key material.
struct ExecutionReceiptIdentity: Codable, Equatable {
    let workspaceId: String
    let userId: String
    let deviceId: String
    let installationId: String
    let attemptId: String
    let taskId: String
    let round: Int
}

struct ExecutionTerminalReceipt: Codable, Equatable {
    let type: String
    let schemaVersion: Int
    let receiptId: String
    let receiptHash: String
    let workspaceId: String
    let userId: String
    let deviceId: String
    let installationId: String
    let attemptId: String
    let taskId: String
    let round: Int
    let outcome: String
    let finalResponse: String
    let error: String?
    let targetName: String?
    let providerThreadId: String?
    let occurredAt: String

    var identity: ExecutionReceiptIdentity {
        ExecutionReceiptIdentity(workspaceId: workspaceId, userId: userId, deviceId: deviceId, installationId: installationId, attemptId: attemptId, taskId: taskId, round: round)
    }

    init(identity: ExecutionReceiptIdentity, outcome: String, finalResponse: String, error: String? = nil, targetName: String? = nil, providerThreadId: String? = nil, receiptId: String = UUID().uuidString.lowercased(), occurredAt: String = ISO8601DateFormatter().string(from: Date())) {
        type = "execution_terminal_receipt"; schemaVersion = 1
        self.receiptId = receiptId
        workspaceId = identity.workspaceId; userId = identity.userId
        deviceId = identity.deviceId; installationId = identity.installationId
        attemptId = identity.attemptId; taskId = identity.taskId; round = identity.round
        self.outcome = outcome; self.finalResponse = finalResponse; self.error = error
        self.targetName = targetName; self.providerThreadId = providerThreadId; self.occurredAt = occurredAt
        receiptHash = Self.hash(fields: ["one-terminal-receipt-v1", receiptId, identity.attemptId, identity.workspaceId, identity.userId, identity.deviceId, identity.installationId, identity.taskId, String(identity.round), outcome, finalResponse, error ?? "", targetName ?? "", providerThreadId ?? "", occurredAt])
    }

    static func hash(fields: [String]) -> String {
        var bytes = Data()
        for field in fields {
            let value = Data(field.utf8)
            bytes.append(Data("\(value.count):".utf8))
            bytes.append(value)
        }
        return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }

    var validHash: Bool {
        type == "execution_terminal_receipt" && schemaVersion == 1 && receiptHash == Self.hash(fields: ["one-terminal-receipt-v1", receiptId, attemptId, workspaceId, userId, deviceId, installationId, taskId, String(round), outcome, finalResponse, error ?? "", targetName ?? "", providerThreadId ?? "", occurredAt])
    }
}

struct ExecutionTerminalAcknowledgement {
    let accepted: Bool
    let receiptId: String
    let receiptHash: String
    let identity: ExecutionReceiptIdentity
    let disposition: String
}

enum TerminalOutboxFailure: Error, Equatable {
    case invalidIdentity, invalidReceipt, unsafeStorage, capacity, persistence
}

enum ExecutionReceiptDiagnostic: String {
    case sendUnavailable = "send_unavailable"
    case pendingReplay = "pending_replay"
    case outboxBlocked = "outbox_blocked"
    case acknowledgementRejected = "acknowledgement_rejected"
    case resultPersisted = "result_persisted"
    case resultAcknowledged = "result_acknowledged"
}

// A bounded diagnostic category, never paths, task text, errors, nonces or ids.
func receiptDiagnostic(_ category: ExecutionReceiptDiagnostic) {
    NSLog("ONE execution transport: %@", category.rawValue)
}

final class TerminalReceiptOutbox: @unchecked Sendable {
    private struct Entry: Codable {
        let identity: ExecutionReceiptIdentity
        var receipt: ExecutionTerminalReceipt?
        var acknowledged: Bool
        let reservedAt: String
    }
    private let lock = NSLock()
    private let root: URL
    let workspaceId: String
    let userId: String
    let deviceId: String
    let installationId: String
    private let maximumPending: Int
    private let maximumBytes: Int
    private let maximumReceiptBytes = 512 * 1024
    private let maximumAcknowledged = 2048

    init(root: URL, workspaceId: String, userId: String, deviceId: String, installationId: String, maximumPending: Int = 128, maximumBytes: Int = 64 * 1024 * 1024) throws {
        guard Self.validIdentifier(workspaceId), Self.validIdentifier(userId), Self.validIdentifier(deviceId), Self.validIdentifier(installationId), maximumPending > 0, maximumBytes >= 1024 else { throw TerminalOutboxFailure.invalidIdentity }
        self.root = root; self.workspaceId = workspaceId; self.userId = userId; self.deviceId = deviceId; self.installationId = installationId
        self.maximumPending = maximumPending; self.maximumBytes = maximumBytes
        try Self.privateDirectory(root)
    }

    // Reserve before any executable is started. A replayed start/continue with
    // the same server attemptId cannot execute twice, even after app restart.
    func reserve(_ identity: ExecutionReceiptIdentity) throws -> Bool {
        try synchronized {
            try validate(identity)
            let existing = try entries()
            if existing.contains(where: { $0.identity == identity }) { return false }
            guard !existing.contains(where: { $0.identity.attemptId == identity.attemptId }), existing.filter({ !$0.acknowledged }).count < maximumPending else { throw TerminalOutboxFailure.capacity }
            let used = existing.filter { !$0.acknowledged }.reduce(0) { $0 + ((try? JSONEncoder().encode($1).count) ?? maximumReceiptBytes) }
            // Keep enough room to finish each already-reserved task. Capacity
            // refuses new work rather than silently evicting an unacked result.
            guard used + (maximumReceiptBytes + 8192) * (existing.filter { !$0.acknowledged && $0.receipt == nil }.count + 1) <= maximumBytes else { throw TerminalOutboxFailure.capacity }
            try write(Entry(identity: identity, receipt: nil, acknowledged: false, reservedAt: ISO8601DateFormatter().string(from: Date())))
            try pruneAcknowledged(existing)
            return true
        }
    }

    // First terminal wins. A cancelled receipt is immutable and cannot be
    // replaced by a late completed answer from pipes still draining.
    func persist(_ receipt: ExecutionTerminalReceipt) throws -> ExecutionTerminalReceipt {
        try synchronized {
            try validate(receipt.identity)
            guard receipt.validHash, UUID(uuidString: receipt.receiptId) != nil, ["completed", "failed", "cancelled"].contains(receipt.outcome), !receipt.finalResponse.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw TerminalOutboxFailure.invalidReceipt }
            let bytes = try JSONEncoder().encode(receipt)
            guard bytes.count <= maximumReceiptBytes else { throw TerminalOutboxFailure.capacity }
            guard var entry = try read(receipt.identity) else { throw TerminalOutboxFailure.invalidIdentity }
            if let first = entry.receipt { return first }
            guard !entry.acknowledged else { throw TerminalOutboxFailure.invalidIdentity }
            entry.receipt = receipt
            try write(entry)
            return receipt
        }
    }

    func pending() throws -> [ExecutionTerminalReceipt] {
        try synchronized { try entries().filter { !$0.acknowledged }.compactMap(\.receipt).sorted { $0.occurredAt < $1.occurredAt } }
    }

    func hasTerminal(_ identity: ExecutionReceiptIdentity) throws -> Bool {
        try synchronized {
            try validate(identity)
            guard let entry = try read(identity) else { return false }
            return entry.acknowledged || entry.receipt != nil
        }
    }

    func isAcknowledged(_ identity: ExecutionReceiptIdentity) throws -> Bool {
        try synchronized { try validate(identity); return try read(identity)?.acknowledged == true }
    }

    func acknowledge(_ acknowledgement: ExecutionTerminalAcknowledgement) throws -> Bool {
        try synchronized {
            try validate(acknowledgement.identity)
            guard acknowledgement.accepted, ["accepted", "duplicate", "supplemental", "superseded"].contains(acknowledgement.disposition), var entry = try read(acknowledgement.identity), let receipt = entry.receipt, receipt.receiptId == acknowledgement.receiptId, receipt.receiptHash == acknowledgement.receiptHash else { return false }
            if entry.acknowledged { return true }
            // Retain only an identity tombstone after the server durably owns
            // the actual result. It prevents a replayed launch without keeping
            // local user output forever. No user files are touched.
            entry = Entry(identity: entry.identity, receipt: nil, acknowledged: true, reservedAt: entry.reservedAt)
            try write(entry)
            return true
        }
    }

    // Only called when constructing a new runner, not on socket reconnection.
    // An interrupted app is not allowed to rerun an uncertain old attempt.
    func recoverInterrupted() throws {
        let interrupted = try synchronized { try entries().filter { !$0.acknowledged && $0.receipt == nil } }
        for entry in interrupted {
            _ = try persist(ExecutionTerminalReceipt(identity: entry.identity, outcome: "failed", finalResponse: "启动器在上轮执行期间退出了，结果尚未确认。请先检查文件；ONE 不会自动重新执行这轮任务。", error: "launcher_interrupted"))
        }
    }

    private func validate(_ identity: ExecutionReceiptIdentity) throws {
        guard identity.deviceId == deviceId, identity.installationId == installationId, identity.workspaceId == workspaceId, identity.userId == userId, Self.validIdentifier(identity.attemptId), Self.validIdentifier(identity.taskId), identity.round >= 0 else { throw TerminalOutboxFailure.invalidIdentity }
    }

    private static func validIdentifier(_ value: String) -> Bool {
        (1...160).contains(value.utf8.count) && value.utf8.allSatisfy { (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95 }
    }

    private func url(_ identity: ExecutionReceiptIdentity) -> URL {
        let digest = ExecutionTerminalReceipt.hash(fields: [identity.workspaceId, identity.userId, identity.deviceId, identity.installationId, identity.attemptId, identity.taskId, String(identity.round)])
        return root.appendingPathComponent("\(digest).json")
    }

    private func read(_ identity: ExecutionReceiptIdentity) throws -> Entry? {
        let path = url(identity)
        guard FileManager.default.fileExists(atPath: path.path) else { return nil }
        let entry = try decode(path)
        guard entry.identity == identity else { throw TerminalOutboxFailure.invalidIdentity }
        return entry
    }

    private func decode(_ path: URL) throws -> Entry {
        var info = stat()
        guard lstat(path.path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_uid == getuid(), info.st_size <= maximumReceiptBytes + 8192 else { throw TerminalOutboxFailure.unsafeStorage }
        guard let data = try? Data(contentsOf: path), let entry = try? JSONDecoder().decode(Entry.self, from: data), entry.receipt?.validHash != false, entry.receipt == nil || entry.receipt?.identity == entry.identity, path.lastPathComponent == url(entry.identity).lastPathComponent, !entry.acknowledged || entry.receipt == nil else { throw TerminalOutboxFailure.persistence }
        try validate(entry.identity)
        return entry
    }

    private func entries() throws -> [Entry] {
        try Self.privateDirectory(root)
        let files = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil).filter { $0.pathExtension == "json" }
        guard files.count <= maximumPending + maximumAcknowledged + 1 else { throw TerminalOutboxFailure.capacity }
        return try files.map(decode)
    }

    private static func privateDirectory(_ root: URL) throws {
        var info = stat()
        if lstat(root.path, &info) != 0 {
            guard errno == ENOENT else { throw TerminalOutboxFailure.unsafeStorage }
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            guard lstat(root.path, &info) == 0 else { throw TerminalOutboxFailure.unsafeStorage }
        }
        guard (info.st_mode & S_IFMT) == S_IFDIR, info.st_uid == getuid(), chmod(root.path, 0o700) == 0 else { throw TerminalOutboxFailure.unsafeStorage }
    }

    private func write(_ entry: Entry) throws {
        try Self.privateDirectory(root)
        let bytes = try JSONEncoder().encode(entry)
        let temporary = root.appendingPathComponent(".receipt-\(UUID().uuidString).tmp")
        let descriptor = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { throw TerminalOutboxFailure.persistence }
        defer { close(descriptor); try? FileManager.default.removeItem(at: temporary) }
        let wrote = bytes.withUnsafeBytes { buffer -> Bool in
            guard let base = buffer.baseAddress else { return false }
            var position = 0
            while position < buffer.count {
                let count = Darwin.write(descriptor, base.advanced(by: position), buffer.count - position)
                if count < 0 && errno == EINTR { continue }
                if count <= 0 { return false }
                position += count
            }
            return true
        }
        guard wrote, fsync(descriptor) == 0, rename(temporary.path, url(entry.identity).path) == 0 else { throw TerminalOutboxFailure.persistence }
        let directory = open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard directory >= 0 else { throw TerminalOutboxFailure.persistence }
        defer { close(directory) }
        guard fsync(directory) == 0 else { throw TerminalOutboxFailure.persistence }
    }

    private func pruneAcknowledged(_ existing: [Entry]) throws {
        let archived = existing.filter(\.acknowledged).sorted { $0.reservedAt < $1.reservedAt }
        guard archived.count > maximumAcknowledged else { return }
        for entry in archived.prefix(archived.count - maximumAcknowledged) { try FileManager.default.removeItem(at: url(entry.identity)) }
    }

    @discardableResult private func synchronized<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock(); defer { lock.unlock() }; return try body()
    }
}
