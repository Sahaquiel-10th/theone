import Foundation

private final class KeyState: @unchecked Sendable {
    private let lock = NSLock()
    private var value = true
    func present() -> Bool { lock.lock(); defer { lock.unlock() }; return value }
    func remove() { lock.lock(); value = false; lock.unlock() }
}

@main struct LocalPreviewTests {
    static func main() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("one-preview-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("web"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try "<h1>ONE_PREVIEW_OK</h1>".write(to: root.appendingPathComponent("web/index.html"), atomically: true, encoding: .utf8)
        try "PRIVATE_OUTSIDE_PROJECT".write(to: root.appendingPathComponent("private.html"), atomically: true, encoding: .utf8)
        try FileManager.default.createSymbolicLink(atPath: root.appendingPathComponent("web/escape.css").path, withDestinationPath: root.appendingPathComponent("private.html").path)
        let preview = try LocalPreview(root: root.path, entry: "web/index.html", present: {true})
        let url = try await preview.start()
        defer { preview.stop() }
        func get(_ target: String, host: String? = nil) async throws -> (Int, String) {
            var request = URLRequest(url: URL(string: target)!); request.timeoutInterval = 3
            if let host { request.setValue(host, forHTTPHeaderField: "Host") }
            let (data, response) = try await URLSession.shared.data(for: request)
            return ((response as! HTTPURLResponse).statusCode, String(decoding: data, as: UTF8.self))
        }
        let good = try await get(url); precondition(good.0 == 200 && good.1.contains("ONE_PREVIEW_OK"))
        precondition(preview.currentURL() == url)
        let base = String(url.prefix(upTo: url.lastIndex(of: "/")!))
        let escape = try await get(base + "/escape.css"); precondition(escape.0 == 404 && !escape.1.contains("PRIVATE"))
        let privateFile = try await get(base + "/../private.html"); precondition(privateFile.0 == 404)
        let invalidHost = try await get(url, host: "evil.example"); precondition(invalidHost.0 == 403)
        let noToken = try await get(url.replacingOccurrences(of: URL(string: url)!.path, with: "/index.html")); precondition(noToken.0 == 404)
        do { _ = try LocalPreview(root: root.path, entry: "../private.html", present: {true}); preconditionFailure("traversal accepted") } catch {}
        do { _ = try LocalPreview(root: root.path, entry: "web/escape.css", present: {true}); preconditionFailure("non-html accepted") } catch {}
        let absent = try LocalPreview(root: root.path, entry: "web/index.html", present: {false})
        do { _ = try await absent.start(); preconditionFailure("absent Key accepted") } catch {}
        preview.stop()
        precondition(preview.currentURL() == nil)
        do { _ = try await get(url); preconditionFailure("stopped preview reachable") } catch {}
        try "<h1>中文路径</h1>".write(to: root.appendingPathComponent("web/首页.html"), atomically: true, encoding: .utf8)
        let key = KeyState()
        let chinese = try LocalPreview(root: root.path, entry: "web/首页.html", present: {key.present()})
        let chineseURL = try await chinese.start()
        defer { chinese.stop() }
        let chineseResult = try await get(chineseURL); precondition(chineseResult.0 == 200 && chineseResult.1.contains("中文路径"))
        key.remove()
        try await Task.sleep(nanoseconds: 2_500_000_000)
        do { _ = try await get(chineseURL); preconditionFailure("removed Key preview reachable") } catch {}
        precondition(chinese.currentURL() == nil)
        let manager = LocalPreviewManager()
        let first = try await manager.start("one", root: root.path, entry: "web/index.html", present: {true})
        let firstStatus = await manager.status("one"); precondition(firstStatus == first)
        let second = try await manager.start("two", root: root.path, entry: "web/index.html", present: {true})
        let oldStatus = await manager.status("one"); precondition(oldStatus.isEmpty)
        do { _ = try await get(first); preconditionFailure("replaced preview reachable") } catch {}
        let secondResult = try await get(second); precondition(secondResult.0 == 200)
        await manager.stopAll()
        let stoppedStatus = await manager.status("two"); precondition(stoppedStatus.isEmpty)
        // Simulate HTTP verification exceeding the Key proof timeout. Other
        // actor operations remain responsive and cancellation cannot resurrect
        // the listener when the late verification completes.
        let slow = LocalPreviewManager(verify: { _ in try await Task.sleep(for: .milliseconds(2200)) })
        let pending = Task { try await slow.start("slow", root: root.path, entry: "web/index.html", present: {true}) }
        try await Task.sleep(for: .milliseconds(100))
        let beforeStop = Date()
        await slow.stopAll()
        precondition(Date().timeIntervalSince(beforeStop) < 1)
        do { _ = try await pending.value; preconditionFailure("late startup resurrected stopped preview") } catch {}
        let lateStatus = await slow.status("slow"); precondition(lateStatus.isEmpty)
        print("PASS: loopback HTTP, token, host, traversal, symlink, Chinese filename, Key removal and stop")
    }
}
