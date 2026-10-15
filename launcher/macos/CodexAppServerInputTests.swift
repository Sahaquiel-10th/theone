import Foundation
import Darwin

private final class InputWriteMock: @unchecked Sendable {
    private let lock = NSLock()
    private var attempts = 0
    private var blocked = false
    private var again = 0
    private let chunkSize: Int
    private let failAfter: Int?

    init(chunkSize: Int = 7, again: Int = 0, blocked: Bool = false, failAfter: Int? = nil) {
        self.chunkSize = chunkSize; self.again = again; self.blocked = blocked; self.failAfter = failAfter
    }
    func unblock() { lock.lock(); blocked = false; lock.unlock() }
    func count() -> Int { lock.lock(); defer { lock.unlock() }; return attempts }
    func write(_ fd: Int32, _ pointer: UnsafeRawPointer, _ count: Int) -> CodexAppServerWriteResult {
        lock.lock()
        attempts += 1
        let shouldFail = failAfter.map { attempts > $0 } ?? false
        let shouldBlock = blocked || again > 0
        if again > 0 { again -= 1 }
        lock.unlock()
        if shouldFail { return CodexAppServerWriteResult(count: -1, errorCode: EIO) }
        if shouldBlock { return CodexAppServerWriteResult(count: -1, errorCode: EAGAIN) }
        let result = Darwin.write(fd, pointer, min(chunkSize, count))
        return CodexAppServerWriteResult(count: result, errorCode: result < 0 ? errno : 0)
    }
}

@main struct CodexAppServerInputTests {
    static let largeLine = String(repeating: "x", count: CodexAppServerInput.maximumLineBytes - 1)

    static func checkFast(_ start: ContinuousClock.Instant, _ context: String) {
        precondition(start.duration(to: .now) < .seconds(1), "\(context) was not bounded")
    }

    private static func untilWriteStarts(_ mock: InputWriteMock) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(1))
        while mock.count() == 0 {
            precondition(ContinuousClock.now < deadline, "mock writer never started")
            try await Task.sleep(for: .milliseconds(2))
        }
    }

    static func reader(_ handle: FileHandle) -> Task<Data, Never> {
        Task.detached { handle.readDataToEndOfFile() }
    }

    static func expectClosed(_ input: CodexAppServerInput) async {
        do { try await input.sendLine("not-retried"); fatalError("closed stream was reused") }
        catch CodexAppServerInputError.closed { }
        catch { fatalError("unexpected closed-stream error: \(error)") }
    }

    static func testNormalLineAndDescriptorFlags() async throws {
        let pipe = Pipe(), fd = pipe.fileHandleForWriting.fileDescriptor
        let input = try CodexAppServerInput(fileHandle: pipe.fileHandleForWriting)
        defer { input.close(); try? pipe.fileHandleForReading.close() }
        precondition(fcntl(fd, F_GETFL) & O_NONBLOCK != 0)
        precondition(fcntl(fd, F_GETNOSIGPIPE) == 1)
        let output = reader(pipe.fileHandleForReading)
        try await input.sendLine("{\"id\":1,\"method\":\"initialize\"}")
        try await input.sendLine("{\"id\":2}")
        input.close(); input.close()
        let actual = await output.value
        precondition(actual == Data("{\"id\":1,\"method\":\"initialize\"}\n{\"id\":2}\n".utf8))
        await expectClosed(input)
    }

    static func testValidationAndExactByteLimit() async throws {
        let pipe = Pipe()
        let input = try CodexAppServerInput(fileHandle: pipe.fileHandleForWriting, maxLineBytes: 32)
        defer { input.close(); try? pipe.fileHandleForReading.close() }
        for bad in ["first\nsecond", "already-framed\n", "raw\rreturn"] {
            do { try await input.sendLine(bad); fatalError("embedded line separator was accepted") }
            catch CodexAppServerInputError.invalidLine { }
        }
        do { try await input.sendLine(String(repeating: "界", count: 11)); fatalError("UTF-8 byte limit was not enforced") }
        catch CodexAppServerInputError.lineTooLong(maximumBytes: 32) { }
        let output = reader(pipe.fileHandleForReading)
        try await input.sendLine(String(repeating: "a", count: 31))
        input.close()
        let actual = await output.value
        precondition(actual == Data((String(repeating: "a", count: 31) + "\n").utf8))
    }

    static func testPartialWritesAgainAndConcurrentLines() async throws {
        let pipe = Pipe(), mock = InputWriteMock(chunkSize: 7, again: 3)
        let input = try CodexAppServerInput(fileHandle: pipe.fileHandleForWriting, timeout: .seconds(2),
            pollInterval: .milliseconds(2), maxLineBytes: 4096, testingWrite: { mock.write($0, $1, $2) })
        defer { input.close(); try? pipe.fileHandleForReading.close() }
        let output = reader(pipe.fileHandleForReading)
        let lines = (0..<8).map { "{\"id\":\($0),\"value\":\"\(String(repeating: String($0), count: 100))\"}" }
        try await withThrowingTaskGroup(of: Void.self) { group in
            for line in lines { group.addTask { try await input.sendLine(line) } }
            try await group.waitForAll()
        }
        input.close()
        let actual = String(decoding: await output.value, as: UTF8.self)
        let received = actual.split(separator: "\n", omittingEmptySubsequences: false)
        precondition(received.last == "")
        precondition(received.count == lines.count + 1)
        precondition(Set(received.dropLast().map(String.init)) == Set(lines), "partial concurrent frames interleaved")
        precondition(mock.count() > lines.count + 3)
    }

    static func testMaximumFrameAndOneByteOver() async throws {
        let pipe = Pipe()
        let input = try CodexAppServerInput(fileHandle: pipe.fileHandleForWriting, timeout: .seconds(2))
        defer { input.close(); try? pipe.fileHandleForReading.close() }
        let output = reader(pipe.fileHandleForReading)
        do {
            try await input.sendLine(largeLine + "x")
            fatalError("frame exceeded the hard 2 MiB limit")
        } catch CodexAppServerInputError.lineTooLong(maximumBytes: CodexAppServerInput.maximumLineBytes) { }
        try await input.sendLine(largeLine)
        input.close()
        let actual = await output.value
        precondition(actual.count == CodexAppServerInput.maximumLineBytes)
        precondition(actual.first == 120 && actual.last == 10)
        precondition(actual.dropLast().allSatisfy { $0 == 120 })
    }

    static func testFullPipeDeadlineClosesWithoutReplay() async throws {
        let pipe = Pipe(), fd = pipe.fileHandleForWriting.fileDescriptor
        let input = try CodexAppServerInput(fileHandle: pipe.fileHandleForWriting,
            timeout: .milliseconds(60), pollInterval: .milliseconds(2))
        defer { input.close(); try? pipe.fileHandleForReading.close() }
        let start = ContinuousClock.now
        do { try await input.sendLine(largeLine); fatalError("full pipe did not time out") }
        catch CodexAppServerInputError.timedOut { }
        checkFast(start, "full pipe deadline")
        precondition(fcntl(fd, F_GETFD) == -1 && errno == EBADF)
        let partial = pipe.fileHandleForReading.readDataToEndOfFile()
        precondition(!partial.isEmpty && partial.count < largeLine.utf8.count + 1)
        precondition(!partial.contains(10), "timed-out line was incorrectly completed")
        await expectClosed(input)
    }

    static func testCloseWhilePipeBlocked() async throws {
        let pipe = Pipe()
        let input = try CodexAppServerInput(fileHandle: pipe.fileHandleForWriting)
        defer { input.close(); try? pipe.fileHandleForReading.close() }
        let writer = Task { try await input.sendLine(largeLine) }
        try await Task.sleep(for: .milliseconds(30))
        let start = ContinuousClock.now
        input.close(); input.close()
        do { try await writer.value; fatalError("closed writer reported success") }
        catch CodexAppServerInputError.closed { }
        checkFast(start, "close while blocked")
        await expectClosed(input)
    }

    static func testInterruptCannotWaitForeverBehindLargeFrame() async throws {
        let pipe = Pipe(), mock = InputWriteMock(chunkSize: 4096)
        let input = try CodexAppServerInput(fileHandle: pipe.fileHandleForWriting, timeout: .milliseconds(80),
            pollInterval: .milliseconds(2), maxLineBytes: CodexAppServerInput.maximumLineBytes,
            testingWrite: { mock.write($0, $1, $2) })
        defer { input.close(); try? pipe.fileHandleForReading.close() }
        let active = Task { try await input.sendLine(largeLine) }
        try await untilWriteStarts(mock)
        let start = ContinuousClock.now
        let interrupt = Task { try await input.sendLine("{\"id\":9,\"method\":\"turn/interrupt\"}") }
        do { try await active.value; fatalError("blocked large frame completed") }
        catch CodexAppServerInputError.timedOut { }
        do { try await interrupt.value; fatalError("interrupt was inserted into a partial JSON frame") }
        catch CodexAppServerInputError.closed { }
        catch CodexAppServerInputError.timedOut { }
        checkFast(start, "queued interrupt")
        let actual = pipe.fileHandleForReading.readDataToEndOfFile()
        precondition(!actual.isEmpty && actual.count < CodexAppServerInput.maximumLineBytes)
        precondition(actual.allSatisfy { $0 == 120 }, "an interrupt interleaved with a partial line")
        await expectClosed(input)
    }

    static func testCancelActiveWriteClosesPromptly() async throws {
        let pipe = Pipe()
        let input = try CodexAppServerInput(fileHandle: pipe.fileHandleForWriting)
        defer { input.close(); try? pipe.fileHandleForReading.close() }
        let writer = Task { try await input.sendLine(largeLine) }
        try await Task.sleep(for: .milliseconds(30))
        let start = ContinuousClock.now
        writer.cancel()
        do { try await writer.value; fatalError("cancelled writer reported success") }
        catch is CancellationError { }
        checkFast(start, "active cancellation")
        await expectClosed(input)
    }

    static func testQueuedCancellationDoesNotCloseAnotherFrame() async throws {
        let pipe = Pipe(), mock = InputWriteMock(blocked: true)
        let input = try CodexAppServerInput(fileHandle: pipe.fileHandleForWriting, timeout: .seconds(2),
            pollInterval: .milliseconds(2), maxLineBytes: 1024, testingWrite: { mock.write($0, $1, $2) })
        defer { input.close(); try? pipe.fileHandleForReading.close() }
        let output = reader(pipe.fileHandleForReading)
        let active = Task { try await input.sendLine("active") }
        try await untilWriteStarts(mock)
        let queued = Task { try await input.sendLine("must-not-be-sent") }
        try await Task.sleep(for: .milliseconds(20))
        let start = ContinuousClock.now
        queued.cancel()
        do { try await queued.value; fatalError("queued cancellation was ignored") }
        catch is CancellationError { }
        checkFast(start, "queued cancellation")
        mock.unblock()
        try await active.value
        try await input.sendLine("after")
        input.close()
        let actual = await output.value
        precondition(actual == Data("active\nafter\n".utf8))
    }

    static func testBrokenPipeDoesNotRaiseSIGPIPE() async throws {
        let pipe = Pipe()
        let input = try CodexAppServerInput(fileHandle: pipe.fileHandleForWriting)
        defer { input.close(); try? pipe.fileHandleForReading.close() }
        try pipe.fileHandleForReading.close()
        do { try await input.sendLine("{\"method\":\"turn/interrupt\"}"); fatalError("broken pipe reported success") }
        catch CodexAppServerInputError.writeFailed(EPIPE) { }
        await expectClosed(input)
    }

    static func testPartialFailureIsNotRetriedOrRecovered() async throws {
        let pipe = Pipe(), mock = InputWriteMock(chunkSize: 5, failAfter: 1)
        let input = try CodexAppServerInput(fileHandle: pipe.fileHandleForWriting, timeout: .seconds(1),
            pollInterval: .milliseconds(2), maxLineBytes: 1024, testingWrite: { mock.write($0, $1, $2) })
        defer { input.close(); try? pipe.fileHandleForReading.close() }
        let output = reader(pipe.fileHandleForReading)
        do { try await input.sendLine("a-partially-written-frame"); fatalError("write error was ignored") }
        catch CodexAppServerInputError.writeFailed(EIO) { }
        await expectClosed(input)
        let actual = await output.value
        precondition(actual == Data("a-par".utf8))
        precondition(mock.count() == 2, "failed frame was retried")
    }

    static func testDeadlineAfterLastSyscallStillFailsClosed() async throws {
        let pipe = Pipe()
        let input = try CodexAppServerInput(fileHandle: pipe.fileHandleForWriting, timeout: .milliseconds(20),
            pollInterval: .milliseconds(2), maxLineBytes: 1024, testingWrite: { fd, pointer, count in
                let written = Darwin.write(fd, pointer, count)
                let error = written < 0 ? errno : 0
                // Simulate descheduling after a successful syscall without
                // pausing any real process or changing signal dispositions.
                Thread.sleep(forTimeInterval: 0.04)
                return CodexAppServerWriteResult(count: written, errorCode: error)
            })
        defer { input.close(); try? pipe.fileHandleForReading.close() }
        let output = reader(pipe.fileHandleForReading)
        do { try await input.sendLine("possibly-delivered"); fatalError("late write reported timely success") }
        catch CodexAppServerInputError.timedOut { }
        await expectClosed(input)
        let actual = await output.value
        precondition(actual == Data("possibly-delivered\n".utf8), "deadline must not pretend already-written bytes were undone")
    }

    static func testInvalidConfigurationClosesTransferredHandle() throws {
        let pipe = Pipe(), fd = pipe.fileHandleForWriting.fileDescriptor
        defer { try? pipe.fileHandleForReading.close() }
        do {
            _ = try CodexAppServerInput(fileHandle: pipe.fileHandleForWriting,
                maxLineBytes: CodexAppServerInput.maximumLineBytes + 1)
            fatalError("more than 2 MiB was accepted")
        } catch CodexAppServerInputError.invalidConfiguration { }
        precondition(fcntl(fd, F_GETFD) == -1 && errno == EBADF)
    }

    static func main() async throws {
        try await testNormalLineAndDescriptorFlags()
        try await testValidationAndExactByteLimit()
        try await testPartialWritesAgainAndConcurrentLines()
        try await testMaximumFrameAndOneByteOver()
        try await testFullPipeDeadlineClosesWithoutReplay()
        try await testCloseWhilePipeBlocked()
        try await testInterruptCannotWaitForeverBehindLargeFrame()
        try await testCancelActiveWriteClosesPromptly()
        try await testQueuedCancellationDoesNotCloseAnotherFrame()
        try await testBrokenPipeDoesNotRaiseSIGPIPE()
        try await testPartialFailureIsNotRetriedOrRecovered()
        try await testDeadlineAfterLastSyscallStillFailsClosed()
        try testInvalidConfigurationClosesTransferredHandle()
        print("CodexAppServerInputTests: 13 groups passed")
    }
}
