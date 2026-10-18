import Foundation
import Darwin

enum CodexAppServerInputError: Error, Equatable, Sendable {
    case invalidConfiguration
    case invalidLine
    case lineTooLong(maximumBytes: Int)
    case closed
    case timedOut
    case descriptorConfigurationFailed(Int32)
    case writeFailed(Int32)
}

struct CodexAppServerWriteResult: Sendable {
    let count: Int
    let errorCode: Int32
}

/// Owns one fixed stdin write handle. Ownership transfers at initialization,
/// including initialization failure: callers must never close/reuse this handle
/// independently. No replacement process/descriptor is looked up on a write.
///
/// Each String is one newline-free JSON line; one LF is appended here. The
/// deadline includes FIFO admission, not just the actual write. A partially
/// written frame cannot safely be resumed or followed by an interrupt frame:
/// cancellation, timeout or failure of its writer closes this stream instead.
/// The controller must fail that session and use its owned-process stop fallback.
final class CodexAppServerInput: @unchecked Sendable {
    static let maximumLineBytes = 2 * 1024 * 1024
    typealias WriteOperation = @Sendable (Int32, UnsafeRawPointer, Int) -> CodexAppServerWriteResult

    private let fileHandle: FileHandle
    private let descriptor: Int32
    private let timeout: Duration
    private let pollInterval: Duration
    private let maxLineBytes: Int
    private let writeOperation: WriteOperation
    private let lock = NSLock()
    private var closed = false
    private var activeWriter: UUID?
    private var waiting: [UUID] = []

    convenience init(fileHandle: FileHandle, timeout: Duration = .seconds(3),
        pollInterval: Duration = .milliseconds(5), maxLineBytes: Int = CodexAppServerInput.maximumLineBytes) throws {
        try self.init(fileHandle: fileHandle, timeout: timeout, pollInterval: pollInterval,
            maxLineBytes: maxLineBytes, testingWrite: Self.nativeWrite)
    }

    // Deterministic partial-write/EAGAIN tests use this nonblocking syscall
    // seam. Production construction above always uses Darwin.write directly.
    init(fileHandle: FileHandle, timeout: Duration, pollInterval: Duration,
        maxLineBytes: Int, testingWrite: @escaping WriteOperation) throws {
        self.fileHandle = fileHandle
        descriptor = fileHandle.fileDescriptor
        self.timeout = timeout
        self.pollInterval = pollInterval
        self.maxLineBytes = maxLineBytes
        writeOperation = testingWrite
        do {
            guard timeout > .zero, timeout <= .seconds(60), pollInterval > .zero,
                pollInterval <= .seconds(1), maxLineBytes > 0,
                maxLineBytes <= Self.maximumLineBytes else { throw CodexAppServerInputError.invalidConfiguration }
            // Only this owned fd suppresses SIGPIPE. Never change the process's
            // signal disposition, which could affect unrelated local tools.
            guard fcntl(descriptor, F_SETNOSIGPIPE, 1) == 0 else {
                throw CodexAppServerInputError.descriptorConfigurationFailed(errno)
            }
            let flags = fcntl(descriptor, F_GETFL)
            guard flags >= 0 else { throw CodexAppServerInputError.descriptorConfigurationFailed(errno) }
            guard fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) == 0 else {
                throw CodexAppServerInputError.descriptorConfigurationFailed(errno)
            }
        } catch {
            closed = true
            try? fileHandle.close()
            throw error
        }
    }

    deinit { close() }

    func sendLine(_ line: String) async throws {
        let deadline = ContinuousClock.now.advanced(by: timeout)
        try Task.checkCancellation()
        guard line.utf8.count < maxLineBytes else {
            throw CodexAppServerInputError.lineTooLong(maximumBytes: maxLineBytes)
        }
        var bytes = Data(line.utf8)
        let hasSeparator = bytes.withUnsafeBytes { buffer in
            guard let address = buffer.baseAddress, !buffer.isEmpty else { return false }
            return memchr(address, 10, buffer.count) != nil || memchr(address, 13, buffer.count) != nil
        }
        guard !hasSeparator else { throw CodexAppServerInputError.invalidLine }
        bytes.append(10)
        let ticket = UUID()
        try synchronized {
            guard !closed else { throw CodexAppServerInputError.closed }
            waiting.append(ticket)
        }
        do { try await withTaskCancellationHandler(operation: {
            var completed = false
            defer { self.finish(ticket, completed: completed) }
            try await self.acquire(ticket, deadline: deadline)
            var offset = 0
            while offset < bytes.count {
                try Task.checkCancellation()
                try self.checkDeadline(deadline)
                let count = try self.writeOnce(bytes, offset: offset, ticket: ticket)
                if count > 0 { offset += count }
                else { try await self.pause(deadline: deadline) }
            }
            try Task.checkCancellation()
            // A process may have been descheduled across the deadline after
            // its final syscall. Do not report a late frame as timely success.
            try self.checkDeadline(deadline)
            completed = true
        }, onCancel: { self.cancel(ticket) })
        } catch {
            // onCancel closes an active stream before the writer resumes. A
            // racing fd check may therefore observe `closed`; preserve the
            // caller's explicit cancellation instead of misreporting a fault.
            try Task.checkCancellation()
            throw error
        }
    }

    func close() { synchronized { closeLocked() } }

    private static let nativeWrite: WriteOperation = { descriptor, buffer, count in
        let written = Darwin.write(descriptor, buffer, count)
        return CodexAppServerWriteResult(count: written, errorCode: written < 0 ? errno : 0)
    }

    private func acquire(_ ticket: UUID, deadline: ContinuousClock.Instant) async throws {
        while true {
            try Task.checkCancellation()
            try checkDeadline(deadline)
            let acquired = try synchronized { () throws -> Bool in
                guard !closed else { throw CodexAppServerInputError.closed }
                guard waiting.contains(ticket) else { throw CancellationError() }
                if activeWriter == nil, waiting.first == ticket {
                    waiting.removeFirst()
                    activeWriter = ticket
                    return true
                }
                return false
            }
            if acquired { return }
            try await pause(deadline: deadline)
        }
    }

    private func writeOnce(_ data: Data, offset: Int, ticket: UUID) throws -> Int {
        try synchronized {
            guard !closed, activeWriter == ticket else { throw CodexAppServerInputError.closed }
            let remaining = data.count - offset
            // The lock covers only this single nonblocking syscall. It is
            // never held while awaiting pipe capacity, FIFO admission or time.
            let result = data.withUnsafeBytes { buffer in
                writeOperation(descriptor, buffer.baseAddress!.advanced(by: offset), remaining)
            }
            if result.count > 0, result.count <= remaining { return result.count }
            if result.count < 0, [EAGAIN, EWOULDBLOCK, EINTR].contains(result.errorCode) { return 0 }
            throw CodexAppServerInputError.writeFailed(result.count < 0 ? result.errorCode : EIO)
        }
    }

    private func checkDeadline(_ deadline: ContinuousClock.Instant) throws {
        guard ContinuousClock.now < deadline else { throw CodexAppServerInputError.timedOut }
    }

    private func pause(deadline: ContinuousClock.Instant) async throws {
        try checkDeadline(deadline)
        let remaining = ContinuousClock.now.duration(to: deadline)
        try await Task.sleep(for: min(pollInterval, remaining))
    }

    private func cancel(_ ticket: UUID) {
        synchronized {
            if activeWriter == ticket { closeLocked() }
            else { waiting.removeAll { $0 == ticket } }
        }
    }

    private func finish(_ ticket: UUID, completed: Bool) {
        synchronized {
            waiting.removeAll { $0 == ticket }
            if activeWriter == ticket {
                if completed { activeWriter = nil }
                else { closeLocked() }
            }
        }
    }

    private func closeLocked() {
        guard !closed else { return }
        closed = true
        activeWriter = nil
        waiting.removeAll()
        try? fileHandle.close()
    }

    @discardableResult private func synchronized<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock(); defer { lock.unlock() }; return try body()
    }
}
