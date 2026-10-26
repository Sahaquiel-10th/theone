import Foundation
import Darwin

@main struct TerminalReceiptOutboxTests {
    static func identity(_ attempt: String = "attempt_one", task: String = "ext_one", round: Int = 1, workspace: String = "ws_one", user: String = "usr_one", device: String = "dev_one", installation: String = "install_one") -> ExecutionReceiptIdentity {
        ExecutionReceiptIdentity(workspaceId: workspace, userId: user, deviceId: device, installationId: installation, attemptId: attempt, taskId: task, round: round)
    }
    static func receipt(_ identity: ExecutionReceiptIdentity, outcome: String = "completed", text: String = "已创建并回读：ONE_QA_OK", receiptId: String = "11111111-1111-4111-8111-111111111111") -> ExecutionTerminalReceipt {
        ExecutionTerminalReceipt(identity: identity, outcome: outcome, finalResponse: text, targetName: "/private/qa", providerThreadId: "thread_one", receiptId: receiptId, occurredAt: "2026-10-14T10:20:30Z")
    }
    static func ack(_ value: ExecutionTerminalReceipt, accepted: Bool = true, hash: String? = nil, id: String? = nil, disposition: String = "accepted", identity: ExecutionReceiptIdentity? = nil) -> ExecutionTerminalAcknowledgement {
        ExecutionTerminalAcknowledgement(accepted: accepted, receiptId: id ?? value.receiptId, receiptHash: hash ?? value.receiptHash, identity: identity ?? value.identity, disposition: disposition)
    }
    static func main() throws {
        let manager = FileManager.default
        let temporary = manager.temporaryDirectory.appendingPathComponent("one-receipt-tests-\(UUID().uuidString)")
        try manager.createDirectory(at: temporary, withIntermediateDirectories: true)
        defer { try? manager.removeItem(at: temporary) }
        func outbox(_ name: String, maximumPending: Int = 128, maximumBytes: Int = 64 * 1024 * 1024) throws -> TerminalReceiptOutbox {
            try TerminalReceiptOutbox(root: temporary.appendingPathComponent(name), workspaceId: "ws_one", userId: "usr_one", deviceId: "dev_one", installationId: "install_one", maximumPending: maximumPending, maximumBytes: maximumBytes)
        }
        let store = try outbox("normal")
        let key = identity(), result = receipt(identity())
        let firstReserved = try store.reserve(key)
        precondition(firstReserved)
        let repeatedReserved = try store.reserve(key)
        precondition(!repeatedReserved, "duplicate command never starts twice")
        let persisted = try store.persist(result)
        precondition(persisted == result && result.validHash)
        let offline = try store.pending()
        precondition(offline == [result], "send failure does not remove the private receipt")
        let reopened = try outbox("normal")
        let recovered = try reopened.pending()
        precondition(recovered == [result], "durable reload retains actual answer and location")
        let exactReplay = try reopened.receiptForReplay(key)
        let wrongRoundReplay = try reopened.receiptForReplay(identity(round: 2))
        let unknownReplay = try reopened.receiptForReplay(identity("attempt_unknown"))
        precondition(exactReplay == result && wrongRoundReplay == nil && unknownReplay == nil,
                     "repeated Stop may replay only the exact durable terminal, never infer an unknown attempt stopped")
        let changed = receipt(key, outcome: "failed", text: "late replacement")
        let immutable = try reopened.persist(changed)
        precondition(immutable == result, "terminal is immutable")
        for invalid in [ack(result, accepted: false), ack(result, hash: String(repeating: "0", count: 64)), ack(result, id: "22222222-2222-4222-8222-222222222222"), ack(result, disposition: "unknown"), ack(result, identity: identity(round: 2))] {
            let removed = try reopened.acknowledge(invalid)
            precondition(!removed)
        }
        for foreign in [identity(workspace: "ws_other"), identity(user: "usr_other"), identity(device: "dev_other"), identity(installation: "install_other")] {
            do { _ = try reopened.acknowledge(ack(result, identity: foreign)); fatalError("foreign ACK accepted") } catch { }
            do { _ = try reopened.receiptForReplay(foreign); fatalError("foreign terminal lookup accepted") } catch { }
        }
        let beforeACK = try reopened.pending()
        precondition(beforeACK == [result])
        let accepted = try reopened.acknowledge(ack(result))
        let afterACK = try reopened.pending()
        let replayStart = try reopened.reserve(key)
        precondition(accepted && afterACK.isEmpty && !replayStart, "ACK clears only durable receipt; tombstone rejects relaunch")
        let stillSettled = try reopened.hasTerminal(key)
        let terminalAcknowledged = try reopened.isAcknowledged(key)
        precondition(stillSettled && terminalAcknowledged, "a late cancellation must not create a new failed/unsaved terminal after ACK")
        let acknowledgedReplay = try reopened.receiptForReplay(key)
        precondition(acknowledgedReplay == nil, "the server-owned result is not reconstructed after local content was purged")

        let cancelStore = try outbox("cancel")
        _ = try cancelStore.reserve(key)
        let cancellation = receipt(key, outcome: "cancelled", text: "已停止，修改不自动撤销")
        _ = try cancelStore.persist(cancellation)
        let late = try cancelStore.persist(result)
        precondition(late.outcome == "cancelled" && late == cancellation)
        let nextKey = identity("attempt_two", round: 2)
        _ = try cancelStore.reserve(nextKey)
        _ = try cancelStore.persist(receipt(nextKey, receiptId: "33333333-3333-4333-8333-333333333333"))
        _ = try cancelStore.acknowledge(ack(cancellation))
        let nextPending = try cancelStore.pending()
        precondition(nextPending.count == 1 && nextPending[0].identity == nextKey, "old ACK must not clear the next round")

        let interrupted = try outbox("restart")
        _ = try interrupted.reserve(key)
        let interruptedReopened = try outbox("restart")
        try interruptedReopened.recoverInterrupted()
        let unknown = try interruptedReopened.pending()
        precondition(unknown.count == 1 && unknown[0].outcome == "failed" && unknown[0].error == "launcher_interrupted")
        let recoveredUnknown = try interruptedReopened.receiptForReplay(key)
        precondition(recoveredUnknown?.error == "launcher_interrupted", "replay must retain uncertainty after restart")
        let cannotRestart = try interruptedReopened.reserve(key)
        precondition(!cannotRestart)

        let bounded = try outbox("capacity", maximumPending: 1)
        _ = try bounded.reserve(key)
        _ = try bounded.persist(result)
        do { _ = try bounded.reserve(nextKey); fatalError("capacity silently discarded pending") } catch TerminalOutboxFailure.capacity { }
        let preserved = try bounded.pending()
        precondition(preserved == [result])
        let bytesBounded = try outbox("bytes", maximumBytes: 1024)
        do { _ = try bytesBounded.reserve(key); fatalError("insufficient finish capacity accepted") } catch TerminalOutboxFailure.capacity { }
        let oversized = try outbox("oversized")
        _ = try oversized.reserve(key)
        do { _ = try oversized.persist(receipt(key, text: String(repeating: "文", count: 200000))); fatalError("oversize receipt accepted") } catch TerminalOutboxFailure.capacity { }

        let folderAttributes = try manager.attributesOfItem(atPath: temporary.appendingPathComponent("cancel").path)
        precondition((folderAttributes[.posixPermissions] as? NSNumber)?.intValue == 0o700)
        for file in try manager.contentsOfDirectory(at: temporary.appendingPathComponent("cancel"), includingPropertiesForKeys: nil) {
            let attributes = try manager.attributesOfItem(atPath: file.path)
            precondition((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
            precondition(!file.lastPathComponent.contains("ext_one") && !file.lastPathComponent.contains("ws_one"))
        }
        let link = temporary.appendingPathComponent("linked")
        try manager.createSymbolicLink(at: link, withDestinationURL: temporary.appendingPathComponent("normal"))
        do { _ = try outbox("linked"); fatalError("symlink root accepted") } catch TerminalOutboxFailure.unsafeStorage { }
        let damaged = try outbox("damaged")
        _ = try damaged.reserve(key)
        _ = try damaged.persist(result)
        let files = try manager.contentsOfDirectory(at: temporary.appendingPathComponent("damaged"), includingPropertiesForKeys: nil)
        let original = files[0], moved = original.deletingLastPathComponent().appendingPathComponent("wrong-name.json")
        try manager.moveItem(at: original, to: moved)
        do { _ = try damaged.pending(); fatalError("misbound filename replayed") } catch TerminalOutboxFailure.persistence { }
        // Lengths count UTF8 bytes, not Swift characters or JS UTF16 units.
        let hash = ExecutionTerminalReceipt.hash(fields: ["one-terminal-receipt-v1", "é", "文😀", "", "1"])
        precondition(hash == "483febbbb56c43a53a7893abd049416991e27f4112c23227ee800e184665c875")
        let unicode = ExecutionTerminalReceipt(identity: identity("attempt-a", task: "task-a", workspace: "workspace-a", user: "user-a", device: "device-a", installation: String(repeating: "a", count: 32)), outcome: "completed", finalResponse: "🙂中文/\n3:abc\"\\", error: "1:2", receiptId: "b58901b7-8c0e-4c7b-9074-a6cc72065b8a", occurredAt: "2026-10-14T06:00:00.000Z")
        precondition(unicode.receiptHash == "5d0c2b4a5fe116e75b3bb1e7b79d0b485645aa32f63a9d7a541da47e1b8a80e2", "shared Swift / TypeScript contract")
        print("Mac durable execution terminal outbox tests passed (scope, ACK, cancellation, capacity, restart, permissions, hash)")
    }
}
