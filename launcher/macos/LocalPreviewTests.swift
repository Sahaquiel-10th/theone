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
        print("PASS: loopback HTTP, token, host, traversal, symlink, Chinese filename, Key removal and stop")
    }
}
